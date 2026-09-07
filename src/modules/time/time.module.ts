import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createHash, randomUUID } from 'node:crypto';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { position, type BillableClassSpec, type ContractPosition } from '../../domain/time/burn.js';
import { DEFAULT_PERSON_CALENDAR, unloggedByDay, weekBounds } from '../../domain/time/unlogged.js';
import { classifyPerformed, multiplierFor } from '../../domain/calendar/after-hours.js';
import { amountOf, carryOver, forecast, overageDecision, rateFor, thresholdsToFire } from '../../domain/time/budget.js';
import {
  billingTransition,
  FINANCE_COLUMNS,
  financeRows,
  periodSummary,
  toCsv,
  type BillingAction,
} from '../../domain/time/billing.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { OBJECT_STORE, StorageModule } from '../../common/storage/storage.module.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import { Inject } from '@nestjs/common';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import type { ContractRow } from '../contracts/contracts.module.js';
import type { Calendar } from '../../domain/sla/engine.js';
import { CalendarsCoreModule, CalendarService } from '../calendars/calendars.module.js';
import { ConfigService } from '../admin/config/config.service.js';
import { ContractsRepository } from '../contracts/contracts.module.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TicketsRepository } from '../tickets/tickets.repository.js';
import { TimeRepository, type TimeEntryRow } from './time.repository.js';

/**
 * Time, Contracts & Budget (02-modules/time-and-budget, cut per Thirty-Day
 * Build section 5): entries are immutable work records validated against
 * the activity and billable-class catalogs and the contract period; a
 * correction is an adjustment row; the position endpoint computes burn on
 * the server; locked billing periods reject writes at the database.
 */
interface CatalogItem {
  key: string;
  label: string;
  billable_class?: string;
  consumes_contract?: boolean;
}

export class LogTimeDto {
  @IsISO8601({ strict: true })
  performed_on!: string;

  @IsInt()
  @Min(1)
  minutes!: number;

  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  activity_type!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  billable_class?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** The person's own word that the work was after hours; the calendar wins when a start time lets it judge. */
  @IsOptional()
  @IsBoolean()
  after_hours?: boolean;

  /** Local start time (HH:MM in the account calendar's zone) for a finer after-hours class (TB-13). */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  performed_start?: string;

  /** Log on behalf of another person (needs time:adjust). */
  @IsOptional()
  @IsUUID('4')
  person_id?: string;
}

function summary(contract: ContractRow) {
  return {
    id: contract.id,
    key: contract.key,
    name: contract.name,
    model: contract.model,
    currency: contract.currency,
    overage_rule: contract.overage_rule,
    rollover_rule: contract.rollover_rule,
    after_hours_handling: contract.after_hours_handling,
  };
}

export class RateEntryDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  role!: string;

  @IsNumber()
  @Min(0)
  @Max(100000)
  bill_rate!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  overage_rate?: number | null;
}

/** A new rate card version (TB-05): never edits an old one. */
export class CreateRateCardDto {
  @IsOptional()
  @IsUUID('4')
  contract_id?: string | null;

  @IsISO8601({ strict: true })
  effective_from!: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RateEntryDto)
  entries!: RateEntryDto[];
}

export class VersionDto {
  @IsInt()
  @Min(1)
  version!: number;
}

export class AdjustTimeDto {
  @IsUUID('4')
  entry_id!: string;

  @IsInt()
  delta_minutes!: number;

  @IsIn(['correction', 'write_off', 'reclass'])
  kind!: 'correction' | 'write_off' | 'reclass';

  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  new_billable_class?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class CreateBucketDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,40}$/)
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;

  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  billable_class!: string;
}

export class CreatePeriodDto {
  @IsISO8601({ strict: true })
  starts_on!: string;

  @IsISO8601({ strict: true })
  ends_on!: string;

  @IsInt()
  @Min(0)
  contracted_minutes!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  carried_over_minutes?: number;
}

export class CreateBillingPeriodDto {
  @IsISO8601({ strict: true })
  starts_on!: string;

  @IsISO8601({ strict: true })
  ends_on!: string;
}

@Injectable()
export class TimeService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly time: TimeRepository,
    private readonly tickets: TicketsRepository,
    private readonly contracts: ContractsRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly calendars: CalendarService,
    private readonly notifications: NotificationsRepository,
    private readonly security: SecurityEventsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async logOnTicket(principal: Principal, ctx: RequestContext, key: string, dto: LogTimeDto): Promise<TimeEntryRow> {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.loadTicket(tx, key);
      if (ticket.state === 'closed' || ticket.state === 'cancelled')
        throw new ConflictException({ code: 'ticket_closed' });
      const entry = await this.insertEntry(
        tx,
        principal,
        ctx,
        { accountId: ticket.account_id, contractId: ticket.contract_id, ticketId: ticket.id },
        dto,
      );
      await this.outbox.write(tx, {
        accountId: ticket.account_id,
        aggregate: 'ticket',
        aggregateId: ticket.id,
        eventType: 'time.logged',
        correlationId: ctx.requestId,
        payload: { entry_id: entry.id, minutes: entry.minutes },
      });
      return entry;
    });
  }

  async logOnBucket(
    principal: Principal,
    ctx: RequestContext,
    bucketId: string,
    dto: LogTimeDto,
  ): Promise<TimeEntryRow> {
    return this.uow.run(principal, async (tx) => {
      const bucket = await this.time.bucketById(tx, bucketId);
      if (bucket.status !== 'active') throw new ConflictException({ code: 'bucket_retired' });
      const contract = await this.singleContract(tx, bucket.account_id);
      return this.insertEntry(
        tx,
        principal,
        ctx,
        { accountId: bucket.account_id, contractId: contract.id, bucketId: bucket.id },
        { ...dto, billable_class: dto.billable_class ?? bucket.billable_class },
      );
    });
  }

  entriesOfTicket(principal: Principal, key: string) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.loadTicket(tx, key);
      const entries = await this.time.entriesOfTicket(tx, ticket.id);
      const total = entries.reduce((sum, entry) => sum + entry.adjusted_minutes, 0);
      return { entries, total_minutes: total };
    });
  }

  mine(principal: Principal, from: string, to: string) {
    return this.uow.run(principal, (tx) => this.time.entriesOfPerson(tx, principal.userId, from, to));
  }

  /** My week: entries grouped by day with totals and the unlogged minutes per day (P2.18.3). */
  myWeek(principal: Principal, week: string | undefined) {
    const bounds = weekBounds(week ?? new Date().toISOString().slice(0, 10));
    return this.uow.run(principal, async (tx) => {
      const entries = await this.time.entriesOfPerson(tx, principal.userId, bounds.from, bounds.to);
      const { days, calendar } = await this.unloggedDays(tx, principal, bounds.from, bounds.to, entries);
      return {
        ...bounds,
        calendar,
        days: days.map((day) => ({ ...day, entries: entries.filter((entry) => entry.performed_on === day.date) })),
        total_minutes: entries.reduce((sum, entry) => sum + Number(entry.adjusted_minutes ?? entry.minutes), 0),
        unlogged_minutes: days.reduce((sum, day) => sum + day.unlogged_minutes, 0),
      };
    });
  }

  /** Per day, calendar minutes minus logged minutes (the data behind the nudges). */
  unlogged(principal: Principal, from: string, to: string) {
    return this.uow.run(principal, async (tx) => {
      const entries = await this.time.entriesOfPerson(tx, principal.userId, from, to);
      const { days, calendar } = await this.unloggedDays(tx, principal, from, to, entries);
      return { from, to, calendar, days, unlogged_minutes: days.reduce((sum, day) => sum + day.unlogged_minutes, 0) };
    });
  }

  private async unloggedDays(
    tx: Tx,
    principal: Principal,
    from: string,
    to: string,
    entries: (TimeEntryRow & { adjusted_minutes?: number })[],
  ) {
    const calendar = await this.time.personCalendarOfUser(tx, principal.userId);
    const logged = new Map<string, number>();
    for (const entry of entries)
      logged.set(
        entry.performed_on,
        (logged.get(entry.performed_on) ?? 0) + Number(entry.adjusted_minutes ?? entry.minutes),
      );
    const spec = calendar
      ? { workingDays: calendar.workingDays, hoursPerDay: calendar.hoursPerDay }
      : DEFAULT_PERSON_CALENDAR;
    return {
      /** What produced the expectation, so the timesheet can say so. */
      calendar: {
        source: calendar ? 'person' : 'default',
        hours_per_day: spec.hoursPerDay,
        working_days: [...spec.workingDays],
        holiday_calendar_name: calendar?.holidayCalendarName ?? null,
      },
      days: unloggedByDay({ from, to, calendar: spec, holidays: new Set(calendar?.holidays ?? []), logged }),
    };
  }

  ofAccount(principal: Principal, accountId: string, from: string, to: string) {
    return this.uow.run(principal, (tx) => this.time.entriesOfAccount(tx, accountId, from, to));
  }

  /** The comp-time report: non-standard entries on comp-time contracts, per person (TB-13). */
  compTime(principal: Principal, accountId: string, from: string, to: string) {
    return this.uow.run(principal, async (tx) => {
      const entries = await this.time.compTimeOfAccount(tx, accountId, from, to);
      const byPerson = new Map<string, { person_id: string; person_name: string; minutes: number; entries: number }>();
      for (const entry of entries) {
        const row = byPerson.get(entry.person_id) ?? {
          person_id: entry.person_id,
          person_name: entry.person_name,
          minutes: 0,
          entries: 0,
        };
        row.minutes += entry.minutes;
        row.entries += 1;
        byPerson.set(entry.person_id, row);
      }
      return {
        from,
        to,
        entries,
        total_minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
        by_person: [...byPerson.values()].sort((a, b) => b.minutes - a.minutes),
      };
    });
  }

  async adjust(principal: Principal, ctx: RequestContext, dto: AdjustTimeDto) {
    return this.uow.run(principal, async (tx) => {
      const entry = await this.time.entryById(tx, dto.entry_id);
      const classes = await this.classes(tx, entry.account_id);
      if (dto.new_billable_class && !classes.some((spec) => spec.key === dto.new_billable_class))
        throw new BadRequestException({ code: 'unknown_billable_class' });
      if (dto.kind === 'reclass' && !dto.new_billable_class)
        throw new BadRequestException({ code: 'new_billable_class_required' });
      const adjusted =
        entry.minutes +
        (await this.time.adjustmentsOfEntry(tx, entry.id)).reduce((sum, row) => sum + row.delta_minutes, 0);
      if (adjusted + dto.delta_minutes < 0)
        throw new ConflictException({ code: 'adjustment_below_zero', current: adjusted });
      // Functional 5.7: a correction to an entry in an approved or later period is dated in the current open period.
      const entryPeriod = await this.time.billingPeriodFor(tx, entry.account_id, entry.performed_on);
      const closed = entryPeriod && entryPeriod.status !== 'open' && entryPeriod.status !== 'submitted';
      const performedOn = closed ? new Date().toISOString().slice(0, 10) : entry.performed_on;
      if (closed) {
        const todayPeriod = await this.time.billingPeriodFor(tx, entry.account_id, performedOn);
        if (todayPeriod && todayPeriod.status !== 'open' && todayPeriod.status !== 'submitted')
          throw new ConflictException({ code: 'billing_period_locked', status: todayPeriod.status });
      }
      const row = await this.time.insertAdjustment(tx, {
        accountId: entry.account_id,
        entryId: entry.id,
        contractId: entry.contract_id,
        performedOn,
        deltaMinutes: dto.delta_minutes,
        kind: dto.kind,
        newBillableClass: dto.new_billable_class,
        reason: dto.reason,
        createdBy: principal.userId,
        createdByName: principal.displayName,
      });
      await this.audit.account(tx, entry.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'time_entry',
          entityId: entry.id,
          ticketId: entry.ticket_id ?? undefined,
          eventType: 'updated',
          field: 'adjustment',
          newValue: { id: row.id, delta: row.delta_minutes, kind: row.kind, reason: row.reason },
        },
      ]);
      // An adjustment moves the consumption too; thresholds are judged again.
      const period = await this.time.periodFor(tx, entry.contract_id, entry.performed_on);
      if (period) {
        const contract = await this.contracts.byId(tx, entry.contract_id);
        const classes = await this.classes(tx, entry.account_id);
        const consumed = await this.consumedIn(tx, entry.contract_id, period, classes);
        await this.evaluateThresholds(
          tx,
          principal,
          ctx,
          contract,
          period,
          consumed,
          period.contracted_minutes + period.carried_over_minutes,
        );
      }
      return row;
    });
  }

  async contractPosition(
    principal: Principal,
    accountId: string,
    contractId: string,
    on = new Date(),
  ): Promise<ContractPosition & { contract: { id: string; key: string; name: string; model: string } }> {
    return this.uow.run(principal, async (tx) => {
      const contract = await this.contracts.byId(tx, contractId);
      if (contract.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'contract' });
      const day = on.toISOString().slice(0, 10);
      const period =
        (await this.time.periodFor(tx, contract.id, day)) ?? (await this.time.periodsOf(tx, contract.id))[0];
      if (!period) throw new NotFoundException({ code: 'no_contract_period' });
      const lines = await this.time.consumption(tx, contract.id, period.starts_on, period.ends_on);
      const classes = await this.classes(tx, accountId);
      return {
        contract: { id: contract.id, key: contract.key, name: contract.name, model: contract.model },
        ...position(period, lines, classes, on),
      };
    });
  }

  buckets(principal: Principal, accountId: string) {
    return this.uow.run(principal, (tx) => this.time.buckets(tx, accountId));
  }

  createBucket(principal: Principal, ctx: RequestContext, accountId: string, dto: CreateBucketDto) {
    return this.uow.run(principal, async (tx) => {
      const classes = await this.classes(tx, accountId);
      if (!classes.some((spec) => spec.key === dto.billable_class))
        throw new BadRequestException({ code: 'unknown_billable_class' });
      const bucket = await this.time.insertBucket(tx, {
        accountId,
        key: dto.key,
        label: dto.label,
        billableClass: dto.billable_class,
      });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        { entityKind: 'non_ticket_bucket', entityId: bucket.id, eventType: 'created', newValue: dto },
      ]);
      return bucket;
    });
  }

  periods(principal: Principal, accountId: string, contractId: string) {
    return this.uow.run(principal, async (tx) => {
      const contract = await this.contracts.byId(tx, contractId);
      if (contract.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'contract' });
      return this.time.periodsOf(tx, contractId);
    });
  }

  createPeriod(principal: Principal, ctx: RequestContext, accountId: string, contractId: string, dto: CreatePeriodDto) {
    return this.uow.run(principal, async (tx) => {
      const contract = await this.contracts.byId(tx, contractId);
      if (contract.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'contract' });
      // Carry-over from the rollover rule when the caller does not state it (technical section 2).
      let carried = dto.carried_over_minutes;
      if (carried === undefined) {
        const previous = await this.time.previousPeriod(tx, contractId, dto.starts_on);
        const classes = await this.classes(tx, accountId);
        carried = carryOver(
          contract.rollover_rule,
          contract.rollover_cap_hours === null ? null : Number(contract.rollover_cap_hours),
          previous ? { ...previous, consumed_minutes: await this.consumedIn(tx, contractId, previous, classes) } : null,
          dto.starts_on,
        );
      }
      const period = await this.time.insertPeriod(tx, {
        accountId,
        contractId,
        startsOn: dto.starts_on,
        endsOn: dto.ends_on,
        contractedMinutes: dto.contracted_minutes,
        carriedOverMinutes: carried,
      });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        { entityKind: 'contract', entityId: contractId, eventType: 'updated', field: 'period', newValue: dto },
      ]);
      return period;
    });
  }

  createBillingPeriod(principal: Principal, ctx: RequestContext, accountId: string, dto: CreateBillingPeriodDto) {
    return this.uow.run(principal, async (tx) => {
      const period = await this.time.insertBillingPeriod(tx, accountId, dto.starts_on, dto.ends_on);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        { entityKind: 'billing_period', entityId: period.id, eventType: 'created', newValue: dto },
      ]);
      return period;
    });
  }

  billingPeriods(principal: Principal, accountId: string) {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.time.billingPeriodsOf(tx, accountId);
      const names = await this.time.userNames(
        tx,
        rows.flatMap((row) => [row.submitted_by, row.approved_by, row.locked_by]),
      );
      const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
      return rows.map((row) => ({
        ...row,
        submitted_by_name: nameOf(row.submitted_by),
        approved_by_name: nameOf(row.approved_by),
        locked_by_name: nameOf(row.locked_by),
      }));
    });
  }

  /**
   * Functional 5.7: the period moves through open, submitted, approved,
   * locked and exported; submit and lock refresh the summary the export
   * must match to the cent; lock writes the outbox event the finance
   * connector will deliver (INT-02).
   */
  transitionBillingPeriod(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    periodId: string,
    action: BillingAction,
    version: number,
  ) {
    return this.uow.run(principal, async (tx) => {
      const before = await this.time.billingPeriod(tx, periodId);
      if (before.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'billing_period' });
      const step = billingTransition(before.status, action);
      if (!step.ok) throw new ConflictException({ code: step.code, status: before.status, allowed: step.allowed });
      const now = new Date();
      const assignments: Record<string, unknown> = { status: step.to };
      if (action === 'submit') {
        assignments.submitted_at = now;
        assignments.submitted_by = principal.userId;
        assignments.summary = periodSummary(
          await this.time.financeLines(tx, accountId, before.starts_on, before.ends_on),
        );
      }
      if (action === 'approve') {
        assignments.approved_at = now;
        assignments.approved_by = principal.userId;
        assignments.auto_lock_at = new Date(now.getTime() + 5 * 86_400_000);
      }
      if (action === 'lock') {
        assignments.locked_at = now;
        assignments.locked_by = principal.userId;
        assignments.summary = periodSummary(
          await this.time.financeLines(tx, accountId, before.starts_on, before.ends_on),
        );
      }
      const after = await this.time.updateBillingPeriod(tx, periodId, version, assignments);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'billing_period',
          entityId: periodId,
          eventType: 'updated',
          field: 'status',
          oldValue: before.status,
          newValue: after.status,
        },
      ]);
      if (action === 'lock')
        await this.outbox.write(tx, {
          accountId,
          aggregate: 'billing_period',
          aggregateId: periodId,
          eventType: 'billing_period.locked',
          correlationId: ctx.requestId ?? randomUUID(),
          origin: ctx.origin,
          payload: { starts_on: after.starts_on, ends_on: after.ends_on, summary: after.summary },
        });
      return after;
    });
  }

  /** Kept for the route table: lock is one transition of the period. */
  lockBillingPeriod(principal: Principal, ctx: RequestContext, accountId: string, periodId: string, version?: number) {
    return this.uow.run(principal, async (tx) => {
      const before = await this.time.billingPeriod(tx, periodId);
      return this.transitionBillingPeriod(principal, ctx, accountId, periodId, 'lock', version ?? before.version);
    });
  }

  billingExports(principal: Principal, accountId: string, periodId: string) {
    return this.uow.run(principal, async (tx) => {
      const period = await this.time.billingPeriod(tx, periodId);
      if (period.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'billing_period' });
      return this.time.billingExportsOf(tx, periodId);
    });
  }

  /**
   * TB-14: the finance file for a locked period, one row per entry or
   * adjustment in the THG finance layout; stored, checksummed on the
   * period and recorded as an append-only export row.
   */
  exportBillingPeriod(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    periodId: string,
    format: 'xlsx' | 'csv',
  ): Promise<{ fileName: string; contentType: string; body: Buffer; rows: number; checksum: string }> {
    return this.uow.run(principal, async (tx) => {
      const period = await this.time.billingPeriod(tx, periodId);
      if (period.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'billing_period' });
      if (period.status !== 'locked' && period.status !== 'exported')
        throw new ConflictException({ code: 'period_not_locked', status: period.status });
      const lines = await this.time.financeLines(tx, accountId, period.starts_on, period.ends_on);
      const label = period.starts_on.slice(0, 7);
      const rows = financeRows(lines, label);
      let body: Buffer;
      if (format === 'csv') body = Buffer.from(toCsv(FINANCE_COLUMNS, rows), 'utf8');
      else {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Finance');
        sheet.addRow([...FINANCE_COLUMNS]);
        for (const row of rows)
          sheet.addRow(row.map((value) => (typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value)));
        sheet.getRow(1).font = { bold: true };
        body = Buffer.from(await workbook.xlsx.writeBuffer());
      }
      const checksum = createHash('sha256').update(body).digest('hex');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const objectKey = `accounts/${accountId}/billing/${periodId}/finance-${stamp}.${format}`;
      await this.store.putObject(
        objectKey,
        body,
        format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      const record = await this.time.insertBillingExport(tx, {
        accountId,
        periodId,
        format,
        objectKey,
        checksum,
        rowCount: rows.length,
        producedBy: principal.userId,
      });
      const summary = periodSummary(lines);
      await this.time.updateBillingPeriod(tx, periodId, period.version, { checksum, summary });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'billing_period',
          entityId: periodId,
          eventType: 'updated',
          field: 'export',
          newValue: { export_id: record.id, format, rows: rows.length, checksum },
        },
      ]);
      await this.security.write(
        {
          type: 'data.export.produced',
          outcome: 'success',
          accountId,
          actorKind: 'user',
          actorId: principal.userId,
          actorName: principal.displayName,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          attrs: { kind: 'finance', format, rows: rows.length, checksum, period: label },
        },
        tx,
      );
      return {
        fileName: `finance-${label}-${accountId.slice(0, 8)}.${format}`,
        contentType:
          format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body,
        rows: rows.length,
        checksum,
      };
    });
  }

  // Helpers -------------------------------------------------------------------

  private async insertEntry(
    tx: Tx,
    principal: Principal,
    ctx: RequestContext,
    target: { accountId: string; contractId: string; ticketId?: string; bucketId?: string },
    dto: LogTimeDto,
  ): Promise<TimeEntryRow> {
    const activities = (
      await this.config.resolve<{ items: CatalogItem[] }>(tx, 'activity_types', '*', target.accountId)
    ).body.items;
    const activity = activities.find((item) => item.key === dto.activity_type);
    if (!activity) throw new BadRequestException({ code: 'unknown_activity_type', activity_type: dto.activity_type });
    const classes = await this.classes(tx, target.accountId);
    const billableClass = dto.billable_class ?? activity.billable_class ?? 'billable';
    if (!classes.some((spec) => spec.key === billableClass))
      throw new BadRequestException({ code: 'unknown_billable_class', billable_class: billableClass });
    if (dto.person_id && dto.person_id !== principal.userId && !principal.permissions.has('time:adjust')) {
      throw new ForbiddenException({ code: 'forbidden', permission: 'time:adjust' });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (dto.performed_on > today) throw new BadRequestException({ code: 'future_date' });
    const period = await this.time.periodFor(tx, target.contractId, dto.performed_on);
    if (period?.locked) throw new ConflictException({ code: 'contract_period_locked' });
    // Functional 5.7: an approved period refuses entries dated inside it; the database trigger holds the same line.
    const billing = await this.time.billingPeriodFor(tx, target.accountId, dto.performed_on);
    if (billing && billing.status !== 'open' && billing.status !== 'submitted')
      throw new ConflictException({ code: 'billing_period_locked', status: billing.status });
    // After-hours class from the account calendar, handling from the contract (TB-13); both frozen on the row.
    const contract = await this.contracts.byId(tx, target.contractId);
    const calendar = await this.calendars.forAccount(tx, target.accountId);
    const afterHoursClass = classifyPerformed(calendar, dto.performed_on, dto.performed_start, dto.after_hours);
    const rateMultiplier = multiplierFor(
      contract.after_hours_handling,
      contract.after_hours_multiplier === null ? null : Number(contract.after_hours_multiplier),
      afterHoursClass,
    );
    // Budget rules (TB-05, TB-11): the rate in force for the person's role, and the overage decision.
    const consumes = classes.find((spec) => spec.key === billableClass)?.consumes_contract ?? false;
    const available = period ? period.contracted_minutes + period.carried_over_minutes : 0;
    const consumedBefore = period && consumes ? await this.consumedIn(tx, target.contractId, period, classes) : 0;
    const overage =
      period && consumes
        ? overageDecision(
            contract.overage_rule,
            available,
            consumedBefore,
            dto.minutes,
            contract.overage_multiplier === null ? null : Number(contract.overage_multiplier),
          )
        : { blocked: false, overBudget: false, overageMinutes: 0, multiplier: 1 };
    if (overage.blocked)
      throw new ConflictException({
        code: 'overage_blocked',
        available_minutes: available,
        consumed_minutes: consumedBefore,
        requested_minutes: dto.minutes,
      });
    const role = await this.time.roleOfUser(tx, dto.person_id ?? principal.userId);
    const rate = rateFor(
      await this.time.rateCards(tx, target.accountId, target.contractId),
      role ?? '',
      dto.performed_on,
    );
    const rateSnapshot = overage.overBudget && rate.overageRate !== null ? rate.overageRate : rate.rate;
    const multiplier = Math.round(rateMultiplier * overage.multiplier * 1000) / 1000;
    const entry = await this.time.insertEntry(tx, {
      accountId: target.accountId,
      ticketId: target.ticketId,
      bucketId: target.bucketId,
      contractId: target.contractId,
      personId: dto.person_id ?? principal.userId,
      personName: dto.person_id && dto.person_id !== principal.userId ? '' : principal.displayName,
      performedOn: dto.performed_on,
      minutes: dto.minutes,
      activityType: dto.activity_type,
      billableClass,
      description: dto.description ?? '',
      afterHours: afterHoursClass !== 'standard',
      performedStart: dto.performed_start ?? null,
      afterHoursClass,
      rateMultiplier: multiplier,
      rateSnapshot,
      amount: amountOf(dto.minutes, rateSnapshot, multiplier),
      overBudget: overage.overBudget,
      createdBy: principal.userId,
    });
    await this.audit.account(tx, target.accountId, actorOf(principal), ctx, [
      {
        entityKind: 'time_entry',
        entityId: entry.id,
        ticketId: target.ticketId,
        eventType: 'created',
        newValue: {
          minutes: entry.minutes,
          activity_type: entry.activity_type,
          billable_class: entry.billable_class,
          performed_on: entry.performed_on,
          after_hours_class: entry.after_hours_class,
          rate_multiplier: entry.rate_multiplier,
          over_budget: entry.over_budget,
        },
      },
    ]);
    if (period && consumes)
      await this.evaluateThresholds(tx, principal, ctx, contract, period, consumedBefore + dto.minutes, available);
    return entry;
  }

  /** Consuming minutes of a period: entries and adjustments in classes that consume the contract. */
  private async consumedIn(
    tx: Tx,
    contractId: string,
    period: { starts_on: string; ends_on: string },
    classes: BillableClassSpec[],
  ): Promise<number> {
    const consuming = new Set(classes.filter((spec) => spec.consumes_contract).map((spec) => spec.key));
    const lines = await this.time.consumption(tx, contractId, period.starts_on, period.ends_on);
    return lines.filter((line) => consuming.has(line.billable_class)).reduce((sum, line) => sum + line.minutes, 0);
  }

  /**
   * TB-09: every percentage crossed by the new consumption fires once per
   * period, in the same transaction as the entry: an append-only event,
   * a notification to the people who manage the account's contracts, an
   * outbox event for the mail pipeline, and an audit row on the contract.
   */
  private async evaluateThresholds(
    tx: Tx,
    principal: Principal,
    ctx: RequestContext,
    contract: ContractRow,
    period: { id: string; thresholds_fired: number[] },
    consumed: number,
    available: number,
  ): Promise<number[]> {
    const percents = thresholdsToFire(contract.threshold_percents, period.thresholds_fired, consumed, available);
    if (percents.length === 0) return [];
    const recipients = await this.time.budgetRecipients(tx, contract.account_id);
    const fired: number[] = [];
    for (const percent of percents) {
      const first = await this.time.fireThreshold(tx, {
        accountId: contract.account_id,
        contractId: contract.id,
        periodId: period.id,
        percent,
        consumed,
        available,
        notified: recipients.length,
      });
      if (!first) continue;
      fired.push(percent);
      const title = `${contract.key} ${contract.name}: ${percent}% of the period consumed`;
      const body = `${Math.round(consumed / 60)} of ${Math.round(available / 60)} hours used`;
      for (const recipientId of recipients)
        await this.notifications.upsert(tx, {
          accountId: contract.account_id,
          recipientId,
          type: 'budget.threshold',
          title,
          body,
          targetKind: 'contract',
          targetId: contract.id,
          link: `/accounts/${contract.account_id}?tab=budget`,
          collapseKey: `budget:${period.id}:${percent}`,
        });
      await this.outbox.write(tx, {
        accountId: contract.account_id,
        aggregate: 'contract',
        aggregateId: contract.id,
        eventType: 'threshold.crossed',
        correlationId: ctx.requestId ?? randomUUID(),
        origin: ctx.origin,
        payload: {
          contract_key: contract.key,
          period_id: period.id,
          percent,
          consumed_minutes: consumed,
          available_minutes: available,
          notify_client: contract.threshold_notify_client,
        },
      });
    }
    await this.audit.account(tx, contract.account_id, actorOf(principal), ctx, [
      {
        entityKind: 'contract',
        entityId: contract.id,
        eventType: 'budget.threshold_crossed',
        field: 'thresholds_fired',
        newValue: { period_id: period.id, percents: fired, consumed_minutes: consumed, available_minutes: available },
      },
    ]);
    return fired;
  }

  private isBusinessDay(calendar: Calendar): (date: string) => boolean {
    const classify = (calendar as { classify?: (date: string) => string }).classify;
    return classify ? (date) => classify.call(calendar, date) === 'standard' : () => true;
  }

  /** TB-07, TB-08: per active contract, the current period position, the forecast and the thresholds. */
  budget(principal: Principal, accountId: string, on = new Date()) {
    return this.uow.run(principal, async (tx) => {
      const day = on.toISOString().slice(0, 10);
      const classes = await this.classes(tx, accountId);
      const calendar = await this.calendars.forAccount(tx, accountId);
      const contracts = await this.contracts.activeForAccount(tx, accountId);
      const consuming = new Set(classes.filter((spec) => spec.consumes_contract).map((spec) => spec.key));
      const cards = [];
      for (const contract of contracts) {
        const period =
          (await this.time.periodFor(tx, contract.id, day)) ?? (await this.time.periodsOf(tx, contract.id))[0];
        if (!period) {
          cards.push({ contract: summary(contract), period: null, position: null, forecast: null, thresholds: null });
          continue;
        }
        const lines = await this.time.consumption(tx, contract.id, period.starts_on, period.ends_on);
        const pos = position(period, lines, classes, on);
        const byDay = new Map<string, number>();
        for (const row of await this.time.consumptionByDay(tx, contract.id, period.starts_on, period.ends_on))
          if (consuming.has(row.billable_class))
            byDay.set(row.performed_on, (byDay.get(row.performed_on) ?? 0) + row.minutes);
        const projection = forecast({
          periodStart: period.starts_on,
          periodEnd: period.ends_on,
          today: day,
          available: pos.available_minutes,
          consumed: pos.consumed_minutes,
          consumedByDay: byDay,
          windowDays: contract.forecast_window_days,
          isBusinessDay: this.isBusinessDay(calendar),
        });
        const next = contract.threshold_percents
          .filter((percent) => !period.thresholds_fired.includes(percent))
          .sort((a, b) => a - b)[0];
        cards.push({
          contract: summary(contract),
          period: { id: period.id, starts_on: period.starts_on, ends_on: period.ends_on, locked: period.locked },
          position: pos,
          forecast: projection,
          thresholds: {
            percents: contract.threshold_percents,
            fired: period.thresholds_fired,
            next_percent: next ?? null,
            next_at_minutes: next === undefined ? null : Math.round((pos.available_minutes * next) / 100),
            events: await this.time.thresholdEvents(tx, contract.id),
          },
          unrated_minutes: await this.time.unratedMinutes(tx, contract.id, period.starts_on, period.ends_on),
        });
      }
      return { account_id: accountId, as_of: day, calendar_id: calendar.id, contracts: cards };
    });
  }

  budgetEntries(
    principal: Principal,
    accountId: string,
    filter: {
      contractId?: string;
      personId?: string;
      activity?: string;
      billableClass?: string;
      from: string;
      to: string;
    },
  ) {
    return this.uow.run(principal, async (tx) => {
      const entries = await this.time.entriesFiltered(tx, accountId, filter);
      return {
        ...filter,
        entries,
        total_minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
        total_amount: Math.round(entries.reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0) * 100) / 100,
      };
    });
  }

  rateCards(principal: Principal, accountId: string, contractId?: string) {
    return this.uow.run(principal, (tx) => this.time.rateCards(tx, accountId, contractId));
  }

  /** TB-05: a new version for the contract or the account default; the same effective date twice is a conflict. */
  createRateCard(principal: Principal, ctx: RequestContext, accountId: string, dto: CreateRateCardDto) {
    return this.uow.run(principal, async (tx) => {
      if (dto.contract_id) {
        const contract = await this.contracts.byId(tx, dto.contract_id);
        if (contract.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'contract' });
      }
      const roles = dto.entries.map((entry) => entry.role);
      if (new Set(roles).size !== roles.length) throw new BadRequestException({ code: 'duplicate_role' });
      let card: { id: string };
      try {
        card = await this.time.insertRateCard(tx, {
          accountId,
          contractId: dto.contract_id ?? null,
          effectiveFrom: dto.effective_from,
          currency: (dto.currency ?? 'USD').toUpperCase(),
          note: dto.note ?? '',
          createdBy: principal.userId,
          entries: dto.entries,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new ConflictException({ code: 'rate_card_exists', effective_from: dto.effective_from });
        throw error;
      }
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'rate_card',
          entityId: card.id,
          eventType: 'created',
          newValue: { contract_id: dto.contract_id ?? null, effective_from: dto.effective_from, roles },
        },
      ]);
      const cards = await this.time.rateCards(tx, accountId, dto.contract_id ?? null);
      return cards.find((row) => row.id === card.id);
    });
  }

  private async classes(tx: Tx, accountId: string): Promise<BillableClassSpec[]> {
    const resolved = await this.config.resolve<{ items: CatalogItem[] }>(tx, 'billable_classes', '*', accountId);
    return resolved.body.items.map((item) => ({ key: item.key, consumes_contract: Boolean(item.consumes_contract) }));
  }

  private async loadTicket(tx: Tx, key: string) {
    const number = key.match(/^CS(\d{7,})$/i) ? String(Number(key.slice(2))) : undefined;
    return number ? this.tickets.byNumber(tx, number) : this.tickets.byId(tx, key);
  }

  private async singleContract(tx: Tx, accountId: string) {
    const active = await this.contracts.activeForAccount(tx, accountId);
    if (active.length === 0) throw new ConflictException({ code: 'no_active_contract' });
    return active[0];
  }
}

@ApiTags('time')
@ApiBearerAuth()
@Controller()
export class TimeController {
  constructor(private readonly time: TimeService) {}

  @Get('tickets/:key/time')
  @RequirePermission('tickets:view')
  ofTicket(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.time.entriesOfTicket(principal, key);
  }

  @Post('tickets/:key/time')
  @RequirePermission('time:log')
  logOnTicket(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: LogTimeDto,
  ) {
    return this.time.logOnTicket(principal, ctx, key, dto);
  }

  @Get('time/mine')
  @RequirePermission('time:log')
  mine(@CurrentPrincipal() principal: Principal, @Query('from') from: string, @Query('to') to: string) {
    return this.time.mine(principal, dateOr(from, -6), dateOr(to, 0));
  }

  @Get('timesheets/me')
  @RequirePermission('time:log')
  myWeek(@CurrentPrincipal() principal: Principal, @Query('week') week?: string) {
    return this.time.myWeek(principal, week);
  }

  @Get('timesheets/me/unlogged')
  @RequirePermission('time:log')
  unlogged(@CurrentPrincipal() principal: Principal, @Query('from') from: string, @Query('to') to: string) {
    return this.time.unlogged(principal, dateOr(from, -6), dateOr(to, 0));
  }

  @Post('time/adjustments')
  @RequirePermission('time:adjust')
  adjust(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: AdjustTimeDto) {
    return this.time.adjust(principal, ctx, dto);
  }

  @Get('accounts/:accountId/time')
  @RequirePermission('tickets:view')
  ofAccount(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.time.ofAccount(principal, accountId, dateOr(from, -30), dateOr(to, 0));
  }

  @Get('accounts/:accountId/budget')
  @RequirePermission('tickets:view')
  budget(@CurrentPrincipal() principal: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.time.budget(principal, accountId);
  }

  @Get('accounts/:accountId/budget/entries')
  @RequirePermission('tickets:view')
  budgetEntries(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('contract') contract?: string,
    @Query('person') person?: string,
    @Query('activity') activity?: string,
    @Query('class') billableClass?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.time.budgetEntries(principal, accountId, {
      contractId: contract,
      personId: person,
      activity,
      billableClass,
      from: dateOr(from, -30),
      to: dateOr(to, 0),
    });
  }

  @Get('accounts/:accountId/rate-cards')
  @RequirePermission('tickets:view')
  rateCards(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('contract_id') contractId?: string,
  ) {
    return this.time.rateCards(principal, accountId, contractId);
  }

  @Put('accounts/:accountId/rate-cards')
  @RequirePermission('contracts:manage')
  createRateCard(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateRateCardDto,
  ) {
    return this.time.createRateCard(principal, ctx, accountId, dto);
  }

  @Get('accounts/:accountId/time/comp-time')
  @RequirePermission('tickets:view')
  compTime(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.time.compTime(principal, accountId, dateOr(from, -30), dateOr(to, 0));
  }

  @Get('accounts/:accountId/contracts/:contractId/position')
  @RequirePermission('tickets:view')
  position(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('contractId', ParseUUIDPipe) contractId: string,
  ) {
    return this.time.contractPosition(principal, accountId, contractId);
  }

  @Get('accounts/:accountId/contracts/:contractId/periods')
  @RequirePermission('tickets:view')
  periods(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('contractId', ParseUUIDPipe) contractId: string,
  ) {
    return this.time.periods(principal, accountId, contractId);
  }

  @Post('accounts/:accountId/contracts/:contractId/periods')
  @RequirePermission('contracts:manage')
  createPeriod(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('contractId', ParseUUIDPipe) contractId: string,
    @Body() dto: CreatePeriodDto,
  ) {
    return this.time.createPeriod(principal, ctx, accountId, contractId, dto);
  }

  @Get('accounts/:accountId/buckets')
  @RequirePermission('time:log')
  buckets(@CurrentPrincipal() principal: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.time.buckets(principal, accountId);
  }

  @Post('accounts/:accountId/buckets')
  @RequirePermission('contracts:manage')
  createBucket(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateBucketDto,
  ) {
    return this.time.createBucket(principal, ctx, accountId, dto);
  }

  @Post('accounts/:accountId/buckets/:bucketId/time')
  @RequirePermission('time:log')
  logOnBucket(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('bucketId', ParseUUIDPipe) bucketId: string,
    @Body() dto: LogTimeDto,
  ) {
    return this.time.logOnBucket(principal, ctx, bucketId, dto);
  }

  @Post('accounts/:accountId/billing-periods')
  @RequirePermission('time:lock-period')
  createBillingPeriod(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: CreateBillingPeriodDto,
  ) {
    return this.time.createBillingPeriod(principal, ctx, accountId, dto);
  }

  @Post('accounts/:accountId/billing-periods/:periodId/lock')
  @RequirePermission('time:lock-period')
  lockBillingPeriod(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
  ) {
    return this.time.lockBillingPeriod(principal, ctx, accountId, periodId);
  }

  @Get('accounts/:accountId/billing-periods')
  @RequirePermission('tickets:view')
  billingPeriods(@CurrentPrincipal() principal: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.time.billingPeriods(principal, accountId);
  }

  @Post('accounts/:accountId/billing-periods/:periodId/submit')
  @RequirePermission('contracts:manage')
  submitBillingPeriod(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
    @Body() dto: VersionDto,
  ) {
    return this.time.transitionBillingPeriod(principal, ctx, accountId, periodId, 'submit', dto.version);
  }

  @Post('accounts/:accountId/billing-periods/:periodId/reopen')
  @RequirePermission('contracts:manage')
  reopenBillingPeriod(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
    @Body() dto: VersionDto,
  ) {
    return this.time.transitionBillingPeriod(principal, ctx, accountId, periodId, 'reopen', dto.version);
  }

  @Post('accounts/:accountId/billing-periods/:periodId/approve')
  @RequirePermission('time:lock-period')
  approveBillingPeriod(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
    @Body() dto: VersionDto,
  ) {
    return this.time.transitionBillingPeriod(principal, ctx, accountId, periodId, 'approve', dto.version);
  }

  @Get('accounts/:accountId/billing-periods/:periodId/exports')
  @RequirePermission('time:lock-period')
  billingExports(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
  ) {
    return this.time.billingExports(principal, accountId, periodId);
  }

  @Get('accounts/:accountId/billing-periods/:periodId/export')
  @RequirePermission('time:lock-period')
  async exportBillingPeriod(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Res() response: Response,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
    @Query('format') format?: string,
  ) {
    const result = await this.time.exportBillingPeriod(
      principal,
      ctx,
      accountId,
      periodId,
      format === 'csv' ? 'csv' : 'xlsx',
    );
    response.setHeader('content-type', result.contentType);
    response.setHeader('content-disposition', `attachment; filename="${result.fileName}"`);
    response.setHeader('x-row-count', String(result.rows));
    response.setHeader('x-checksum', result.checksum);
    response.send(result.body);
  }
}

function dateOr(value: string | undefined, offsetDays: number): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

@Module({
  imports: [TicketsCoreModule, CalendarsCoreModule, StorageModule],
  controllers: [TimeController],
  providers: [TimeService, TimeRepository],
  exports: [TimeService],
})
export class TimeModule {}
