import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { monthBounds, monthOf, personMonth, variance, type PersonMonth } from '../../domain/capacity/capacity.js';
import { coverage, heatMap, SPOF_LEVEL, type SkillHolder } from '../../domain/capacity/skills.js';
import { demandTotals, parseDemandCsv, type DemandLine } from '../../domain/capacity/demand.js';
import { RosterCoreModule, RosterRepository, type PersonRow } from '../roster/roster.module.js';

/**
 * Capacity (Capacity & Allocation technical sections 2.4 to 2.9; CAP-02 to
 * CAP-06, cut): PTO per person, planned allocations per person, account and
 * month, the capacity view per month, the assignment-time check, and the
 * planned-versus-actual report. The read models are rebuilt inline for the
 * month being read (pilot scale) rather than by a worker lease; the same
 * pure math serves both. Operator-only: every route is behind a capacity
 * permission and the portal role has no grant on the tables.
 */

// Rows ------------------------------------------------------------------------

export interface PtoRow {
  id: string;
  person_id: string;
  starts_on: string;
  ends_on: string;
  kind: 'vacation' | 'sick' | 'other';
  fraction: string;
  note: string;
  entered_by: string;
  created_at: string;
}

export interface AllocationRow {
  id: string;
  person_id: string;
  account_id: string;
  period_month: string;
  planned_minutes: number;
  note: string | null;
  updated_by: string;
  updated_at: string;
  version: number;
}

export interface DemandRow extends DemandLine {
  id: string;
  role: string | null;
  skill_id: string | null;
  note: string;
  entered_by: string;
  created_at: string;
}

interface CapacityPeriodRow extends PersonMonth {
  person_id: string;
  period_month: string;
  computed_at: string;
}

const DEFAULT_OVERHEAD_PERCENT = 10;
const WARNING_RATIO = 0.9;

// Repository -------------------------------------------------------------------

@Injectable()
export class CapacityRepository extends RepositoryBase {
  ptoOf(tx: Tx, personId: string): Promise<PtoRow[]> {
    return this.many(tx, 'select * from op.pto where person_id = $1 order by starts_on desc', [personId]);
  }

  /** PTO rows of many people overlapping a range, for the month computation. */
  ptoOverlapping(tx: Tx, personIds: string[], from: string, to: string): Promise<PtoRow[]> {
    return this.many(
      tx,
      'select * from op.pto where person_id = any ($1::uuid[]) and starts_on <= $3 and ends_on >= $2',
      [personIds, from, to],
    );
  }

  insertPto(
    tx: Tx,
    input: {
      personId: string;
      startsOn: string;
      endsOn: string;
      kind: string;
      fraction: number;
      note: string;
      enteredBy: string;
    },
  ): Promise<PtoRow> {
    return this.one(
      tx,
      'pto',
      `insert into op.pto (person_id, starts_on, ends_on, kind, fraction, note, entered_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [input.personId, input.startsOn, input.endsOn, input.kind, input.fraction, input.note, input.enteredBy],
    );
  }

  async deletePto(tx: Tx, personId: string, id: string): Promise<PtoRow | undefined> {
    return this.maybeOne(tx, 'delete from op.pto where id = $1 and person_id = $2 returning *', [id, personId]);
  }

  calendarsOf(
    tx: Tx,
    personIds: string[],
  ): Promise<{ person_id: string; working_days: number[]; hours_per_day: string }[]> {
    return this.many(
      tx,
      'select person_id, working_days, hours_per_day from op.person_calendars where person_id = any ($1::uuid[])',
      [personIds],
    );
  }

  holidaysOf(
    tx: Tx,
    calendarIds: string[],
    from: string,
    to: string,
  ): Promise<{ calendar_id: string; date: string }[]> {
    if (calendarIds.length === 0) return Promise.resolve([]);
    return this.many(
      tx,
      'select calendar_id, date::text as date from op.holidays where calendar_id = any ($1::uuid[]) and date between $2 and $3',
      [calendarIds, from, to],
    );
  }

  allocationsOf(
    tx: Tx,
    filter: { personIds?: string[]; accountId?: string; from: string; to: string },
  ): Promise<AllocationRow[]> {
    return this.many(
      tx,
      `select a.*, a.period_month::text as period_month from op.allocations a
        where a.period_month between $1 and $2
          and ($3::uuid[] is null or a.person_id = any ($3))
          and ($4::uuid is null or a.account_id = $4)
        order by a.period_month, a.person_id`,
      [filter.from, filter.to, filter.personIds ?? null, filter.accountId ?? null],
    );
  }

  /** Upserts a grid cell; a stale version is a conflict; zero minutes with no note removes the cell. */
  async upsertAllocation(
    tx: Tx,
    cell: {
      personId: string;
      accountId: string;
      month: string;
      plannedMinutes: number;
      /** Omitted keeps the stored note; null clears it. */
      note?: string | null;
      version?: number;
    },
    updatedBy: string,
  ): Promise<AllocationRow | null> {
    const existing = await this.maybeOne<AllocationRow>(
      tx,
      'select *, period_month::text as period_month from op.allocations where person_id = $1 and account_id = $2 and period_month = $3 for update',
      [cell.personId, cell.accountId, cell.month],
    );
    if (existing && cell.version !== undefined && existing.version !== cell.version)
      throw new ConflictException({ code: 'stale_version', entity: 'allocation', current: existing.version });
    const note = cell.note === undefined ? (existing?.note ?? null) : cell.note;
    if (cell.plannedMinutes === 0 && !cell.note) {
      if (existing) await tx.query('delete from op.allocations where id = $1', [existing.id]);
      return null;
    }
    if (existing)
      return this.one(
        tx,
        'allocation',
        `update op.allocations set planned_minutes = $2, note = $3, updated_by = $4, version = version + 1
          where id = $1 returning *, period_month::text as period_month`,
        [existing.id, cell.plannedMinutes, note, updatedBy],
      );
    return this.one(
      tx,
      'allocation',
      `insert into op.allocations (person_id, account_id, period_month, planned_minutes, note, updated_by)
       values ($1, $2, $3, $4, $5, $6) returning *, period_month::text as period_month`,
      [cell.personId, cell.accountId, cell.month, cell.plannedMinutes, note, updatedBy],
    );
  }

  /** Actual minutes per person and account in a month, every class, from entries and adjustments. */
  actualsOf(
    tx: Tx,
    personUserIds: string[],
    from: string,
    to: string,
  ): Promise<{ person_id: string; account_id: string; minutes: number }[]> {
    return this.many(
      tx,
      `with lines as (
         select e.person_id, e.account_id, e.minutes from acct.time_entries e
          where e.person_id = any ($1::text[]) and e.performed_on between $2 and $3
         union all
         select e.person_id, a.account_id, a.delta_minutes
           from acct.time_adjustments a join acct.time_entries e on e.id = a.entry_id
          where e.person_id = any ($1::text[]) and a.performed_on between $2 and $3
       )
       select person_id, account_id, sum(minutes)::int as minutes from lines group by 1, 2`,
      [personUserIds, from, to],
    );
  }

  async writePeriod(tx: Tx, personId: string, month: string, value: PersonMonth): Promise<void> {
    await tx.query(
      `insert into rpt.capacity_periods (person_id, period_month, working_days, contracted_minutes, pto_minutes, holiday_minutes, overhead_minutes, available_minutes, allocated_minutes, actual_minutes, status, computed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       on conflict (person_id, period_month) do update set
         working_days = excluded.working_days, contracted_minutes = excluded.contracted_minutes, pto_minutes = excluded.pto_minutes,
         holiday_minutes = excluded.holiday_minutes, overhead_minutes = excluded.overhead_minutes, available_minutes = excluded.available_minutes,
         allocated_minutes = excluded.allocated_minutes, actual_minutes = excluded.actual_minutes, status = excluded.status, computed_at = now()`,
      [
        personId,
        month,
        value.working_days,
        value.contracted_minutes,
        value.pto_minutes,
        value.holiday_minutes,
        value.overhead_minutes,
        value.available_minutes,
        value.allocated_minutes,
        value.actual_minutes,
        value.status,
      ],
    );
  }

  async writeActual(
    tx: Tx,
    row: { personId: string; accountId: string; month: string; planned: number; actual: number },
  ): Promise<void> {
    await tx.query(
      `insert into rpt.capacity_actuals (person_id, account_id, period_month, planned_minutes, actual_minutes, variance_minutes, computed_at)
       values ($1, $2, $3, $4::int, $5::int, $5::int - $4::int, now())
       on conflict (person_id, account_id, period_month) do update set
         planned_minutes = excluded.planned_minutes, actual_minutes = excluded.actual_minutes,
         variance_minutes = excluded.variance_minutes, computed_at = now()`,
      [row.personId, row.accountId, row.month, row.planned, row.actual],
    );
  }

  /** Every active person's level on every active skill. */
  skillHolders(tx: Tx): Promise<(SkillHolder & { kind: string })[]> {
    return this.many(
      tx,
      `select ps.person_id, s.code, s.kind, ps.level
         from op.person_skills ps
         join op.skills s on s.id = ps.skill_id and s.is_active
         join op.people p on p.id = ps.person_id and p.is_active`,
    );
  }

  activeSkills(tx: Tx): Promise<{ id: string; code: string; name: string; kind: string }[]> {
    return this.many(tx, 'select id, code, name, kind from op.skills where is_active order by kind, name');
  }

  /** The technologies each granted account requires: the union over its active contracts. */
  requiredTechnologies(
    tx: Tx,
    accountIds: string[],
  ): Promise<{ account_id: string; key: string; name: string; codes: string[] }[]> {
    return this.many(
      tx,
      `select a.id as account_id, a.key, a.name,
              coalesce((select array_agg(distinct code) from acct.contracts c, unnest(c.technology_codes) as code
                          where c.account_id = a.id and c.status = 'active'), '{}') as codes
         from op.accounts a
        where a.id = any ($1::uuid[]) and a.status in ('onboarding', 'active', 'suspended', 'offboarding')
        order by a.name`,
      [accountIds],
    );
  }

  demandOf(
    tx: Tx,
    filter: { from: string; to: string; accountId?: string },
  ): Promise<(DemandRow & { account_key: string | null })[]> {
    return this.many(
      tx,
      `select d.*, d.period_month::text as period_month, d.hours::float8 as hours, d.probability::float8 as probability, a.key as account_key
         from op.pipeline_demand d left join op.accounts a on a.id = d.account_id
        where d.period_month between $1 and $2 and ($3::uuid is null or d.account_id = $3)
        order by d.period_month, a.key nulls last, d.prospect_name`,
      [filter.from, filter.to, filter.accountId ?? null],
    );
  }

  insertDemand(
    tx: Tx,
    input: {
      source: 'pipeline' | 'project' | 'import';
      accountId: string | null;
      prospectName: string | null;
      month: string;
      hours: number;
      probability: number;
      role: string | null;
      note: string;
      enteredBy: string;
    },
  ): Promise<DemandRow> {
    return this.one(
      tx,
      'demand',
      `insert into op.pipeline_demand (source, account_id, prospect_name, period_month, hours, probability, role, note, entered_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *, period_month::text as period_month, hours::float8 as hours, probability::float8 as probability`,
      [
        input.source,
        input.accountId,
        input.prospectName,
        input.month,
        input.hours,
        input.probability,
        input.role,
        input.note,
        input.enteredBy,
      ],
    );
  }

  deleteDemand(tx: Tx, id: string): Promise<DemandRow | undefined> {
    return this.maybeOne(
      tx,
      'delete from op.pipeline_demand where id = $1 returning *, period_month::text as period_month, hours::float8 as hours, probability::float8 as probability',
      [id],
    );
  }

  accountIdsByKey(tx: Tx, keys: string[]): Promise<{ id: string; key: string }[]> {
    return this.many(tx, 'select id, key from op.accounts where key = any ($1::text[])', [keys]);
  }

  periodsOf(tx: Tx, month: string): Promise<CapacityPeriodRow[]> {
    return this.many(
      tx,
      'select *, period_month::text as period_month from rpt.capacity_periods where period_month = $1',
      [month],
    );
  }
}

// DTOs ------------------------------------------------------------------------

export class CreatePtoDto {
  @IsISO8601({ strict: true }) starts_on!: string;
  @IsISO8601({ strict: true }) ends_on!: string;
  @IsIn(['vacation', 'sick', 'other']) kind!: 'vacation' | 'sick' | 'other';
  @IsOptional() @IsNumber() @Min(0.25) @Max(1) fraction?: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class CreateDemandDto {
  @IsIn(['pipeline', 'project']) source!: 'pipeline' | 'project';
  @IsOptional() @IsUUID('4') account_id?: string | null;
  @IsOptional() @IsString() @MaxLength(160) prospect_name?: string | null;
  @Matches(/^\d{4}-\d{2}(-01)?$/) month!: string;
  @IsNumber() @Min(0) @Max(100000) hours!: number;
  @IsOptional() @IsNumber() @Min(0.01) @Max(1) probability?: number;
  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,39}$/) role?: string | null;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class ImportDemandDto {
  @IsString() @MaxLength(2_000_000) content!: string;
}

export class AllocationCellDto {
  @IsUUID('4') person_id!: string;
  @IsUUID('4') account_id!: string;
  @Matches(/^\d{4}-\d{2}-01$/) month!: string;
  @IsInt() @Min(0) @Max(60 * 24 * 31) planned_minutes!: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string | null;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

export class PutAllocationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AllocationCellDto)
  cells!: AllocationCellDto[];
}

// Service ----------------------------------------------------------------------

interface PersonView {
  person: Pick<PersonRow, 'id' | 'display_name' | 'role' | 'fte_percent' | 'time_zone' | 'assignment_group_ids'>;
  month: PersonMonth;
  allocations: { account_id: string; planned_minutes: number; note: string | null; version: number }[];
}

@Injectable()
export class CapacityService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: CapacityRepository,
    private readonly roster: RosterRepository,
    private readonly audit: AuditService,
  ) {}

  // PTO (CAP-02) ---------------------------------------------------------------

  pto(principal: Principal, personId: string) {
    return this.uow.operator(async (tx) => {
      const person = await this.roster.person(tx, personId);
      this.assertSelfOrManage(principal, person);
      return this.repo.ptoOf(tx, personId);
    });
  }

  addPto(principal: Principal, ctx: RequestContext, personId: string, dto: CreatePtoDto) {
    if (dto.ends_on < dto.starts_on) throw new BadRequestException({ code: 'invalid_range' });
    return this.uow.operator(async (tx) => {
      const person = await this.roster.person(tx, personId);
      this.assertSelfOrManage(principal, person);
      const row = await this.repo.insertPto(tx, {
        personId,
        startsOn: dto.starts_on,
        endsOn: dto.ends_on,
        kind: dto.kind,
        fraction: dto.fraction ?? 1,
        note: dto.note ?? '',
        enteredBy: principal.userId,
      });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'person',
          entityId: personId,
          eventType: 'capacity.pto.added',
          newValue: {
            id: row.id,
            starts_on: row.starts_on,
            ends_on: row.ends_on,
            kind: row.kind,
            fraction: row.fraction,
          },
        },
      ]);
      return row;
    });
  }

  removePto(principal: Principal, ctx: RequestContext, personId: string, id: string) {
    return this.uow.operator(async (tx) => {
      const person = await this.roster.person(tx, personId);
      this.assertSelfOrManage(principal, person);
      const row = await this.repo.deletePto(tx, personId, id);
      if (!row) throw new NotFoundException({ code: 'not_found', entity: 'pto' });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'person',
          entityId: personId,
          eventType: 'capacity.pto.removed',
          oldValue: { id: row.id, starts_on: row.starts_on, ends_on: row.ends_on, kind: row.kind },
        },
      ]);
      return { removed: row.id };
    });
  }

  private assertSelfOrManage(principal: Principal, person: PersonRow): void {
    if (principal.permissions.has('capacity:manage')) return;
    if (person.user_id === principal.userId) return;
    throw new ForbiddenException({ code: 'forbidden', permission: 'capacity:manage' });
  }

  // The month (CAP-03) ---------------------------------------------------------

  /**
   * Computes every active person's month from the roster, calendars,
   * holidays, PTO, allocations and actuals, writes the read models and
   * returns the rows; the filters narrow the response, not the compute.
   */
  view(
    principal: Principal,
    month: string,
    filter: { group?: string; role?: string; account?: string; personIds?: string[] },
  ) {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.computeMonth(tx, principal, month, filter.personIds);
      const demandRows = (await this.repo.demandOf(tx, { from: month, to: month, accountId: filter.account })).filter(
        (row) => row.account_id === null || principal.accountIds.includes(row.account_id),
      );
      const visible = rows.filter(
        (row) =>
          (!filter.role || row.person.role === filter.role) &&
          (!filter.group || row.person.assignment_group_ids.includes(filter.group)) &&
          (!filter.account || row.allocations.some((cell) => cell.account_id === filter.account)),
      );
      return {
        month,
        people: visible,
        demand: {
          ...demandTotals(demandRows),
          by_subject: demandRows.map((row) => ({
            account_id: row.account_id,
            account_key: row.account_key,
            prospect_name: row.prospect_name,
            source: row.source,
            hours: row.hours,
            probability: row.probability,
          })),
        },
        totals: visible.reduce(
          (sum, row) => ({
            available_minutes: sum.available_minutes + row.month.available_minutes,
            allocated_minutes: sum.allocated_minutes + row.month.allocated_minutes,
            actual_minutes: sum.actual_minutes + row.month.actual_minutes,
            remaining_minutes: sum.remaining_minutes + row.month.remaining_minutes,
          }),
          { available_minutes: 0, allocated_minutes: 0, actual_minutes: 0, remaining_minutes: 0 },
        ),
      };
    });
  }

  /** CAP-06: the assignment-time check for a few people, served from the same math. */
  check(principal: Principal, personIds: string[], month: string) {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.computeMonth(tx, principal, month, personIds);
      return rows.map((row) => ({
        person_id: row.person.id,
        display_name: row.person.display_name,
        available_minutes: row.month.available_minutes,
        allocated_minutes: row.month.allocated_minutes,
        actual_minutes: row.month.actual_minutes,
        remaining_minutes: row.month.remaining_minutes,
        status: row.month.status,
      }));
    });
  }

  private async computeMonth(tx: Tx, principal: Principal, month: string, personIds?: string[]): Promise<PersonView[]> {
    const { from, to } = monthBounds(month);
    let people = await this.roster.list(tx, { active: true });
    if (personIds && personIds.length > 0) people = people.filter((person) => personIds.includes(person.id));
    if (people.length === 0) return [];
    const ids = people.map((person) => person.id);
    const calendars = new Map((await this.repo.calendarsOf(tx, ids)).map((row) => [row.person_id, row]));
    const holidayCalendarIds = [
      ...new Set(people.map((p) => p.holiday_calendar_id).filter((id): id is string => !!id)),
    ];
    const holidays = new Map<string, Set<string>>();
    for (const row of await this.repo.holidaysOf(tx, holidayCalendarIds, from, to)) {
      const set = holidays.get(row.calendar_id) ?? new Set<string>();
      set.add(row.date);
      holidays.set(row.calendar_id, set);
    }
    const pto = await this.repo.ptoOverlapping(tx, ids, from, to);
    const allocations = await this.repo.allocationsOf(tx, { personIds: ids, from: month, to: month });
    const userIds = people.map((person) => person.user_id).filter((id): id is string => !!id);
    const actuals = await this.repo.actualsOf(tx, userIds, from, to);
    const views: PersonView[] = [];
    for (const person of people) {
      const calendar = calendars.get(person.id);
      const own = allocations.filter((row) => row.person_id === person.id);
      const actual = actuals.filter((row) => row.person_id === person.user_id);
      const value = personMonth({
        month,
        workingDays: calendar?.working_days ?? null,
        hoursPerDay: calendar ? Number(calendar.hours_per_day) : 0,
        ftePercent: Number(person.fte_percent),
        overheadPercent:
          person.admin_overhead_percent === null ? DEFAULT_OVERHEAD_PERCENT : Number(person.admin_overhead_percent),
        startDate: person.start_date,
        endDate: person.end_date,
        holidays: (person.holiday_calendar_id && holidays.get(person.holiday_calendar_id)) || new Set<string>(),
        pto: pto
          .filter((row) => row.person_id === person.id)
          .map((row) => ({ starts_on: row.starts_on, ends_on: row.ends_on, fraction: Number(row.fraction) })),
        allocatedMinutes: own.reduce((sum, row) => sum + row.planned_minutes, 0),
        actualMinutes: actual.reduce((sum, row) => sum + row.minutes, 0),
        warningRatio: WARNING_RATIO,
      });
      await this.repo.writePeriod(tx, person.id, month, value);
      const accountIds = new Set([...own.map((row) => row.account_id), ...actual.map((row) => row.account_id)]);
      for (const accountId of accountIds)
        if (principal.accountIds.includes(accountId))
          await this.repo.writeActual(tx, {
            personId: person.id,
            accountId,
            month,
            planned: own
              .filter((row) => row.account_id === accountId)
              .reduce((sum, row) => sum + row.planned_minutes, 0),
            actual: actual.filter((row) => row.account_id === accountId).reduce((sum, row) => sum + row.minutes, 0),
          });
      views.push({
        person: {
          id: person.id,
          display_name: person.display_name,
          role: person.role,
          fte_percent: person.fte_percent,
          time_zone: person.time_zone,
          assignment_group_ids: person.assignment_group_ids,
        },
        month: value,
        allocations: own.map((row) => ({
          account_id: row.account_id,
          planned_minutes: row.planned_minutes,
          note: row.note,
          version: row.version,
        })),
      });
    }
    return views;
  }

  // Skills matrix (CAP-07) ------------------------------------------------------

  /**
   * People lens: a heat map of levels per person and skill. Account lens:
   * per granted account (or the one asked for), the technologies its active
   * contracts require, who is at level three or above, and the single point
   * of failure or gap flags the account record shows as chips.
   */
  skillsMatrix(principal: Principal, lens: 'people' | 'account', accountId?: string) {
    return this.uow.run(principal, async (tx) => {
      const holders = await this.repo.skillHolders(tx);
      if (lens === 'people') {
        const people = await this.roster.list(tx, { active: true });
        const skills = await this.repo.activeSkills(tx);
        const rows = heatMap(
          people.map((person) => person.id),
          holders,
        );
        return {
          lens,
          skills,
          people: people.map((person, index) => ({
            id: person.id,
            display_name: person.display_name,
            role: person.role,
            levels: rows[index].levels,
          })),
        };
      }
      const accountIds = accountId ? principal.accountIds.filter((id) => id === accountId) : [...principal.accountIds];
      if (accountId && accountIds.length === 0) throw new NotFoundException({ code: 'not_found', entity: 'account' });
      const people = new Map((await this.roster.list(tx, { active: true })).map((person) => [person.id, person]));
      const required = await this.repo.requiredTechnologies(tx, accountIds);
      const technologyHolders = holders.filter((row) => row.kind === 'technology');
      return {
        lens,
        required_level: SPOF_LEVEL,
        accounts: required.map((account) => {
          const rows = coverage(account.codes, technologyHolders);
          return {
            account_id: account.account_id,
            key: account.key,
            name: account.name,
            technologies: rows.map((row) => ({
              ...row,
              qualified: row.qualified.map((personId) => ({
                person_id: personId,
                display_name: people.get(personId)?.display_name ?? personId,
              })),
            })),
            single_points_of_failure: rows.filter((row) => row.status === 'spof').map((row) => row.code),
            gaps: rows.filter((row) => row.status === 'gap').map((row) => row.code),
          };
        }),
      };
    });
  }

  // Forward demand (CAP-08) ------------------------------------------------------

  demand(principal: Principal, filter: { from: string; to: string; account?: string }) {
    return this.uow.run(principal, async (tx) => {
      const rows = (
        await this.repo.demandOf(tx, { from: filter.from, to: filter.to, accountId: filter.account })
      ).filter((row) => row.account_id === null || principal.accountIds.includes(row.account_id));
      return { ...filter, rows, totals: demandTotals(rows) };
    });
  }

  addDemand(principal: Principal, ctx: RequestContext, dto: CreateDemandDto) {
    if (!dto.account_id && !dto.prospect_name) throw new BadRequestException({ code: 'subject_required' });
    if (dto.account_id && !principal.accountIds.includes(dto.account_id))
      throw new ForbiddenException({ code: 'forbidden', account_id: dto.account_id });
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.insertDemand(tx, {
        source: dto.source,
        accountId: dto.account_id ?? null,
        prospectName: dto.account_id ? null : (dto.prospect_name ?? null),
        month: `${dto.month.slice(0, 7)}-01`,
        hours: dto.hours,
        probability: dto.source === 'project' ? 1 : (dto.probability ?? 1),
        role: dto.role ?? null,
        note: dto.note ?? '',
        enteredBy: principal.userId,
      });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'demand',
          entityId: row.id,
          eventType: 'capacity.demand.added',
          newValue: { source: row.source, month: row.period_month, hours: row.hours, probability: row.probability },
        },
      ]);
      return row;
    });
  }

  removeDemand(principal: Principal, ctx: RequestContext, id: string) {
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.deleteDemand(tx, id);
      if (!row) throw new NotFoundException({ code: 'not_found', entity: 'demand' });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'demand',
          entityId: row.id,
          eventType: 'capacity.demand.removed',
          oldValue: { month: row.period_month, hours: row.hours },
        },
      ]);
      return { removed: row.id };
    });
  }

  /** The spreadsheet template as CSV text; every problem is reported and nothing imports until the file is clean. */
  importDemand(principal: Principal, ctx: RequestContext, content: string) {
    const parsed = parseDemandCsv(content);
    if (parsed.problems.length > 0)
      throw new BadRequestException({ code: 'invalid_import', problems: parsed.problems });
    return this.uow.run(principal, async (tx) => {
      const keys = [...new Set(parsed.rows.map((row) => row.account_key).filter((key): key is string => !!key))];
      const accounts = new Map((await this.repo.accountIdsByKey(tx, keys)).map((row) => [row.key, row.id]));
      const unknown = keys.filter((key) => !accounts.has(key) || !principal.accountIds.includes(accounts.get(key)!));
      if (unknown.length > 0) throw new BadRequestException({ code: 'unknown_account', keys: unknown });
      const rows: DemandRow[] = [];
      for (const row of parsed.rows)
        rows.push(
          await this.repo.insertDemand(tx, {
            source: row.source,
            accountId: row.account_key ? accounts.get(row.account_key)! : null,
            prospectName: row.account_key ? null : row.prospect_name,
            month: row.period_month,
            hours: row.hours,
            probability: row.probability,
            role: row.role,
            note: `imported line ${row.line}`,
            enteredBy: principal.userId,
          }),
        );
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'demand',
          entityId: rows[0]?.id ?? 'none',
          eventType: 'capacity.demand.imported',
          newValue: { rows: rows.length },
        },
      ]);
      return { imported: rows.length, rows };
    });
  }

  // Allocations (CAP-04) -------------------------------------------------------

  allocations(principal: Principal, filter: { account?: string; from: string; to: string }) {
    return this.uow.run(principal, async (tx) =>
      (
        await this.repo.allocationsOf(tx, {
          accountId: filter.account,
          from: monthOf(filter.from),
          to: monthOf(filter.to),
        })
      ).filter((row) => principal.accountIds.includes(row.account_id)),
    );
  }

  /** Bulk cell upsert with the version each cell was read at; then the affected months are recomputed. */
  putAllocations(principal: Principal, ctx: RequestContext, dto: PutAllocationsDto) {
    return this.uow.run(principal, async (tx) => {
      const results: (AllocationRow | { removed: true; person_id: string; account_id: string; month: string })[] = [];
      for (const cell of dto.cells) {
        if (!principal.accountIds.includes(cell.account_id))
          throw new ForbiddenException({ code: 'forbidden', account_id: cell.account_id });
        await this.roster.person(tx, cell.person_id);
        const row = await this.repo.upsertAllocation(
          tx,
          {
            personId: cell.person_id,
            accountId: cell.account_id,
            month: cell.month,
            plannedMinutes: cell.planned_minutes,
            note: cell.note,
            version: cell.version,
          },
          principal.userId,
        );
        results.push(
          row ?? { removed: true, person_id: cell.person_id, account_id: cell.account_id, month: cell.month },
        );
      }
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'allocation',
          entityId: dto.cells[0].account_id,
          eventType: 'capacity.allocations.updated',
          newValue: { cells: dto.cells.length, months: [...new Set(dto.cells.map((cell) => cell.month))] },
        },
      ]);
      for (const month of new Set(dto.cells.map((cell) => cell.month)))
        await this.computeMonth(tx, principal, month, [...new Set(dto.cells.map((cell) => cell.person_id))]);
      return { cells: results };
    });
  }

  // Planned versus actual (CAP-05) ----------------------------------------------

  variance(principal: Principal, month: string, filter: { account?: string; person?: string }) {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.computeMonth(tx, principal, month, filter.person ? [filter.person] : undefined);
      const { from, to } = monthBounds(month);
      const userIds = rows.map((row) => row.person.id);
      const people = (await this.roster.list(tx, { active: true })).filter((person) => userIds.includes(person.id));
      const actuals = await this.repo.actualsOf(
        tx,
        people.map((person) => person.user_id).filter((id): id is string => !!id),
        from,
        to,
      );
      const lines: {
        person_id: string;
        display_name: string;
        account_id: string;
        planned_minutes: number;
        actual_minutes: number;
        variance_minutes: number;
        variance_ratio: number | null;
      }[] = [];
      for (const row of rows) {
        const person = people.find((candidate) => candidate.id === row.person.id);
        const accountIds = new Set([
          ...row.allocations.map((cell) => cell.account_id),
          ...actuals.filter((cell) => cell.person_id === person?.user_id).map((cell) => cell.account_id),
        ]);
        for (const accountId of accountIds) {
          if (filter.account && accountId !== filter.account) continue;
          if (!principal.accountIds.includes(accountId)) continue;
          const planned = row.allocations
            .filter((cell) => cell.account_id === accountId)
            .reduce((sum, cell) => sum + cell.planned_minutes, 0);
          const actual = actuals
            .filter((cell) => cell.person_id === person?.user_id && cell.account_id === accountId)
            .reduce((sum, cell) => sum + cell.minutes, 0);
          lines.push({
            person_id: row.person.id,
            display_name: row.person.display_name,
            account_id: accountId,
            planned_minutes: planned,
            actual_minutes: actual,
            ...variance(planned, actual),
          });
        }
      }
      return {
        month,
        lines,
        totals: {
          planned_minutes: lines.reduce((sum, line) => sum + line.planned_minutes, 0),
          actual_minutes: lines.reduce((sum, line) => sum + line.actual_minutes, 0),
          variance_minutes: lines.reduce((sum, line) => sum + line.variance_minutes, 0),
        },
      };
    });
  }
}

// Controllers --------------------------------------------------------------------

@ApiTags('capacity')
@ApiBearerAuth()
@Controller('roster/people/:id/pto')
export class PtoController {
  constructor(private readonly capacity: CapacityService) {}

  @Get()
  @RequirePermission('time:log')
  list(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.capacity.pto(principal, id);
  }

  @Post()
  @RequirePermission('time:log')
  add(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePtoDto,
  ) {
    return this.capacity.addPto(principal, ctx, id, dto);
  }

  @Delete(':ptoId')
  @HttpCode(200)
  @RequirePermission('time:log')
  remove(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ptoId', ParseUUIDPipe) ptoId: string,
  ) {
    return this.capacity.removePto(principal, ctx, id, ptoId);
  }
}

function monthOr(value: string | undefined): string {
  if (value && /^\d{4}-\d{2}(-01)?$/.test(value)) return `${value.slice(0, 7)}-01`;
  if (value) throw new BadRequestException({ code: 'bad_month', month: value });
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

@ApiTags('capacity')
@ApiBearerAuth()
@Controller()
export class CapacityController {
  constructor(private readonly capacity: CapacityService) {}

  @Get('capacity')
  @RequirePermission('capacity:view')
  view(
    @CurrentPrincipal() principal: Principal,
    @Query('month') month?: string,
    @Query('group') group?: string,
    @Query('role') role?: string,
    @Query('account') account?: string,
  ) {
    return this.capacity.view(principal, monthOr(month), { group, role, account });
  }

  @Get('capacity/check')
  @RequirePermission('tickets:work')
  check(
    @CurrentPrincipal() principal: Principal,
    @Query('person_ids') personIds?: string,
    @Query('month') month?: string,
  ) {
    const ids = (personIds ?? '').split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) throw new BadRequestException({ code: 'person_ids_required' });
    return this.capacity.check(principal, ids.slice(0, 50), monthOr(month));
  }

  @Get('capacity/skills-matrix')
  @RequirePermission('capacity:view')
  skillsMatrix(
    @CurrentPrincipal() principal: Principal,
    @Query('lens') lens?: string,
    @Query('account') account?: string,
  ) {
    if (lens !== undefined && lens !== 'people' && lens !== 'account')
      throw new BadRequestException({ code: 'bad_lens', lens });
    return this.capacity.skillsMatrix(principal, lens === 'account' ? 'account' : 'people', account);
  }

  @Get('capacity/variance')
  @RequirePermission('capacity:view')
  variance(
    @CurrentPrincipal() principal: Principal,
    @Query('month') month?: string,
    @Query('account') account?: string,
    @Query('person') person?: string,
  ) {
    return this.capacity.variance(principal, monthOr(month), { account, person });
  }

  @Get('demand')
  @RequirePermission('capacity:view')
  demand(
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('account') account?: string,
  ) {
    return this.capacity.demand(principal, { from: monthOr(from), to: to ? monthOr(to) : monthOr(from), account });
  }

  @Post('demand')
  @RequirePermission('capacity:manage')
  addDemand(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateDemandDto) {
    return this.capacity.addDemand(principal, ctx, dto);
  }

  @Post('demand/import')
  @RequirePermission('capacity:manage')
  importDemand(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: ImportDemandDto,
  ) {
    return this.capacity.importDemand(principal, ctx, dto.content);
  }

  @Delete('demand/:id')
  @HttpCode(200)
  @RequirePermission('capacity:manage')
  removeDemand(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.capacity.removeDemand(principal, ctx, id);
  }

  @Get('allocations')
  @RequirePermission('capacity:view')
  allocations(
    @CurrentPrincipal() principal: Principal,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.capacity.allocations(principal, { account, from: monthOr(from), to: monthOr(to) });
  }

  @Put('allocations')
  @RequirePermission('capacity:manage')
  putAllocations(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: PutAllocationsDto,
  ) {
    return this.capacity.putAllocations(principal, ctx, dto);
  }
}

@Module({
  imports: [RosterCoreModule],
  providers: [CapacityRepository, CapacityService],
  exports: [CapacityService],
})
export class CapacityCoreModule {}

@Module({
  imports: [CapacityCoreModule],
  controllers: [PtoController, CapacityController],
  exports: [CapacityCoreModule],
})
export class CapacityModule {}
