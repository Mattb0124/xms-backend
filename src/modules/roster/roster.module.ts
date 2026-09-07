import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
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
import type { Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService, type AuditEntry } from '../../common/audit/audit.service.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';

/**
 * The roster (Capacity & Allocation technical 2.1 to 2.3, section 4; CAP-01;
 * P2.12.1 cut): people with their working calendar, skills and
 * certifications, imported from the sign-in directory or created by hand.
 * Operator scope, no account content. Rates, PTO, allocations and the
 * capacity view arrive in Month 3 with the finance column grants.
 */
export interface PersonRow {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string;
  role: string;
  fte_percent: number;
  hours_base_per_week: number;
  admin_overhead_percent: number | null;
  currency: string;
  country: string | null;
  time_zone: string;
  holiday_calendar_id: string | null;
  assignment_group_ids: string[];
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CalendarRow {
  person_id: string;
  working_days: number[];
  day_start: string;
  day_end: string;
  hours_per_day: string;
}

export interface SkillRow {
  id: string;
  kind: 'technology' | 'account' | 'process';
  code: string;
  name: string;
  account_id: string | null;
  is_active: boolean;
}

export interface PersonSkillRow {
  skill_id: string;
  code: string;
  name: string;
  kind: string;
  level: number;
  assessed_on: string;
  assessed_by: string;
}

export interface CertificationRow {
  id: string;
  person_id: string;
  name: string;
  issuer: string | null;
  obtained_on: string;
  expires_on: string | null;
}

/** Postgres returns numeric columns as strings; the API speaks numbers (Capacity technical section 4). */
function numeric<T extends { fte_percent: unknown; hours_base_per_week: unknown; admin_overhead_percent: unknown }>(
  row: T,
): T {
  return {
    ...row,
    fte_percent: Number(row.fte_percent),
    hours_base_per_week: Number(row.hours_base_per_week),
    admin_overhead_percent: row.admin_overhead_percent === null ? null : Number(row.admin_overhead_percent),
  };
}

@Injectable()
export class RosterRepository extends RepositoryBase {
  list(
    tx: Tx,
    filter: { active?: boolean; role?: string; group?: string; skill?: string; q?: string },
  ): Promise<(PersonRow & { skills: PersonSkillRow[] })[]> {
    return this.many<PersonRow & { skills: PersonSkillRow[] }>(
      tx,
      `select p.*,
              coalesce((select json_agg(json_build_object('skill_id', s.id, 'code', s.code, 'name', s.name, 'kind', s.kind, 'level', ps.level, 'assessed_on', ps.assessed_on, 'assessed_by', ps.assessed_by) order by s.name)
                          from op.person_skills ps join op.skills s on s.id = ps.skill_id where ps.person_id = p.id), '[]'::json) as skills
         from op.people p
        where ($1::boolean is null or p.is_active = $1)
          and ($2::text is null or p.role = $2)
          and ($3::uuid is null or $3 = any (p.assignment_group_ids))
          and ($4::text is null or exists (select 1 from op.person_skills ps join op.skills s on s.id = ps.skill_id where ps.person_id = p.id and s.code = $4))
          and ($5::text is null or p.display_name ilike '%' || $5 || '%' or p.email ilike '%' || $5 || '%')
        order by p.display_name`,
      [filter.active ?? null, filter.role ?? null, filter.group ?? null, filter.skill ?? null, filter.q ?? null],
    ).then((rows) => rows.map(numeric));
  }

  person(tx: Tx, id: string): Promise<PersonRow> {
    return this.one<PersonRow>(tx, 'person', 'select * from op.people where id = $1', [id]).then(numeric);
  }

  byEmail(tx: Tx, email: string): Promise<PersonRow | undefined> {
    return this.maybeOne<PersonRow>(tx, 'select * from op.people where email = $1', [email]).then((row) =>
      row ? numeric(row) : undefined,
    );
  }

  insert(tx: Tx, values: Record<string, unknown>): Promise<PersonRow> {
    const keys = Object.keys(values);
    return this.one<PersonRow>(
      tx,
      'person',
      `insert into op.people (${keys.map((key) => `"${key}"`).join(', ')}) values (${keys.map((_, index) => `$${index + 1}`).join(', ')}) returning *`,
      keys.map((key) => values[key]),
    ).then(numeric);
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<PersonRow> {
    return this.updateVersioned<PersonRow>(tx, 'person', 'op.people', id, version, assignments).then(numeric);
  }

  /** Internal users without a person row, with their highest system role name. */
  importable(tx: Tx): Promise<
    {
      id: string;
      email: string;
      first_name: string;
      last_name: string;
      time_zone: string | null;
      role: string | null;
    }[]
  > {
    return this.many(
      tx,
      `select u.id, u.email, u.first_name, u.last_name, u.time_zone,
              (select r.name from op.role_assignments ur join op.roles r on r.id = ur.role_id where ur.user_id = u.id order by r.name limit 1) as role
         from op.users u
        where u.kind = 'internal' and u.status = 'active'
          and not exists (select 1 from op.people p where p.user_id = u.id or p.email = u.email)
        order by u.email`,
    );
  }

  groupsOfUser(tx: Tx, userId: string): Promise<string[]> {
    return this.many<{ group_id: string }>(tx, 'select group_id from op.group_members where user_id = $1', [
      userId,
    ]).then((rows) => rows.map((row) => row.group_id));
  }

  calendar(tx: Tx, personId: string): Promise<CalendarRow | undefined> {
    return this.maybeOne(tx, 'select * from op.person_calendars where person_id = $1', [personId]);
  }

  upsertCalendar(
    tx: Tx,
    personId: string,
    input: { working_days: number[]; day_start: string; day_end: string },
  ): Promise<CalendarRow> {
    return this.one(
      tx,
      'calendar',
      `insert into op.person_calendars (person_id, working_days, day_start, day_end, hours_per_day)
       values ($1, $2, $3, $4, extract(epoch from ($4::time - $3::time)) / 3600)
       on conflict (person_id) do update set working_days = excluded.working_days, day_start = excluded.day_start, day_end = excluded.day_end,
         hours_per_day = excluded.hours_per_day, updated_at = now()
       returning *`,
      [personId, input.working_days, input.day_start, input.day_end],
    );
  }

  skills(tx: Tx, activeOnly = true): Promise<SkillRow[]> {
    return this.many(tx, `select * from op.skills where ($1::boolean is false or is_active) order by kind, name`, [
      activeOnly,
    ]);
  }

  skillByCode(tx: Tx, code: string): Promise<SkillRow | undefined> {
    return this.maybeOne(tx, 'select * from op.skills where code = $1', [code]);
  }

  insertSkill(
    tx: Tx,
    input: { kind: string; code: string; name: string; accountId?: string | null },
  ): Promise<SkillRow> {
    return this.one(
      tx,
      'skill',
      'insert into op.skills (kind, code, name, account_id) values ($1, $2, $3, $4) returning *',
      [input.kind, input.code, input.name, input.accountId ?? null],
    );
  }

  personSkills(tx: Tx, personId: string): Promise<PersonSkillRow[]> {
    return this.many(
      tx,
      `select s.id as skill_id, s.code, s.name, s.kind, ps.level, ps.assessed_on, ps.assessed_by
         from op.person_skills ps join op.skills s on s.id = ps.skill_id where ps.person_id = $1 order by s.name`,
      [personId],
    );
  }

  async replaceSkills(
    tx: Tx,
    personId: string,
    entries: { skillId: string; level: number }[],
    by: string,
  ): Promise<void> {
    await tx.query('delete from op.person_skills where person_id = $1', [personId]);
    for (const entry of entries) {
      await tx.query('insert into op.person_skills (person_id, skill_id, level, assessed_by) values ($1, $2, $3, $4)', [
        personId,
        entry.skillId,
        entry.level,
        by,
      ]);
    }
  }

  certifications(tx: Tx, personId: string): Promise<CertificationRow[]> {
    return this.many(tx, 'select * from op.certifications where person_id = $1 order by expires_on nulls last, name', [
      personId,
    ]);
  }

  insertCertification(
    tx: Tx,
    input: { personId: string; name: string; issuer?: string | null; obtainedOn: string; expiresOn?: string | null },
  ): Promise<CertificationRow> {
    return this.one(
      tx,
      'certification',
      `insert into op.certifications (person_id, name, issuer, obtained_on, expires_on) values ($1, $2, $3, $4, $5) returning *`,
      [input.personId, input.name, input.issuer ?? null, input.obtainedOn, input.expiresOn ?? null],
    );
  }

  deleteCertification(tx: Tx, personId: string, id: string): Promise<number> {
    return this.count(tx, 'delete from op.certifications where id = $1 and person_id = $2', [id, personId]);
  }
}

// DTOs -------------------------------------------------------------------------

const ROLE = /^[a-z][a-z0-9_]{1,39}$/;

class CreatePersonDto {
  @IsString() @MinLength(1) @MaxLength(120) display_name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @Matches(ROLE) role!: string;
  @IsOptional() @IsUUID('4') user_id?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) fte_percent?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(80) hours_base_per_week?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) admin_overhead_percent?: number | null;
  @IsOptional() @IsString() @MaxLength(3) @MinLength(3) currency?: string;
  @IsOptional() @IsString() @MaxLength(2) @MinLength(2) country?: string | null;
  @IsOptional() @IsString() @MaxLength(64) time_zone?: string;
  @IsOptional() @IsUUID('4') holiday_calendar_id?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('4', { each: true }) assignment_group_ids?: string[];
  @IsOptional() @IsString() start_date?: string | null;
  @IsOptional() @IsString() end_date?: string | null;
}

class PatchPersonDto extends CreatePersonDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) declare display_name: string;
  @IsOptional() @IsEmail() @MaxLength(254) declare email: string;
  @IsOptional() @Matches(ROLE) declare role: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

class CalendarDto {
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  working_days!: number[];
  @Matches(/^\d{2}:\d{2}$/) day_start!: string;
  @Matches(/^\d{2}:\d{2}$/) day_end!: string;
}

class SkillLevelDto {
  @IsOptional() @IsUUID('4') skill_id?: string;
  @IsOptional() @Matches(/^[a-z0-9][a-z0-9_.-]{0,59}$/) code?: string;
  @IsInt() @Min(1) @Max(4) level!: number;
}

class SkillsDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SkillLevelDto) skills!: SkillLevelDto[];
}

class CreateSkillDto {
  @IsIn(['technology', 'account', 'process']) kind!: 'technology' | 'account' | 'process';
  @Matches(/^[a-z0-9][a-z0-9_.-]{0,59}$/) code!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsUUID('4') account_id?: string;
}

class CertificationDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(160) issuer?: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) obtained_on!: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) expires_on?: string;
}

// Service -------------------------------------------------------------------------

const PERSON_FIELDS = [
  'display_name',
  'email',
  'role',
  'user_id',
  'fte_percent',
  'hours_base_per_week',
  'admin_overhead_percent',
  'currency',
  'country',
  'time_zone',
  'holiday_calendar_id',
  'assignment_group_ids',
  'start_date',
  'end_date',
] as const;

@Injectable()
export class RosterService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: RosterRepository,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal, filter: { active?: string; role?: string; group?: string; skill?: string; q?: string }) {
    return this.uow.operator((tx) =>
      this.repo.list(tx, {
        active:
          filter.active === undefined
            ? true
            : filter.active === 'true'
              ? true
              : filter.active === 'false'
                ? false
                : undefined,
        role: filter.role,
        group: filter.group,
        skill: filter.skill,
        q: filter.q,
      }),
    );
  }

  get(principal: Principal, id: string) {
    return this.uow.operator(async (tx) => {
      const person = await this.repo.person(tx, id);
      return {
        ...person,
        calendar: (await this.repo.calendar(tx, id)) ?? null,
        skills: await this.repo.personSkills(tx, id),
        certifications: await this.repo.certifications(tx, id),
      };
    });
  }

  create(principal: Principal, ctx: RequestContext, dto: CreatePersonDto) {
    return this.uow.operator(async (tx) => {
      const email = dto.email.toLowerCase();
      if (await this.repo.byEmail(tx, email)) throw new BadRequestException({ code: 'person_exists', email });
      const values: Record<string, unknown> = { email };
      for (const field of PERSON_FIELDS) if (field !== 'email' && dto[field] !== undefined) values[field] = dto[field];
      const row = await this.repo.insert(tx, values);
      await this.repo.upsertCalendar(tx, row.id, {
        working_days: [1, 2, 3, 4, 5],
        day_start: '09:00',
        day_end: '17:00',
      });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'person',
          entityId: row.id,
          eventType: 'roster.person.created',
          newValue: { email, role: row.role, display_name: row.display_name },
        },
      ]);
      return row;
    });
  }

  patch(principal: Principal, ctx: RequestContext, id: string, dto: PatchPersonDto) {
    return this.uow.operator(async (tx) => {
      const before = await this.repo.person(tx, id);
      const assignments: Record<string, unknown> = {};
      for (const field of PERSON_FIELDS)
        if (dto[field] !== undefined)
          assignments[field] = field === 'email' ? String(dto.email).toLowerCase() : dto[field];
      if (dto.is_active !== undefined) assignments.is_active = dto.is_active;
      if (Object.keys(assignments).length === 0) return before;
      const after = await this.repo.update(tx, id, dto.version, assignments);
      const entries: AuditEntry[] = Object.keys(assignments).map((field) => ({
        entityKind: 'person',
        entityId: id,
        eventType: 'roster.person.updated',
        field,
        oldValue: before[field as keyof PersonRow] ?? null,
        newValue: after[field as keyof PersonRow] ?? null,
      }));
      await this.audit.operator(tx, actorOf(principal), ctx, entries);
      return after;
    });
  }

  /** Creates a person for every active internal user without one; idempotent. */
  importFromDirectory(principal: Principal, ctx: RequestContext) {
    return this.uow.operator(async (tx) => {
      const candidates = await this.repo.importable(tx);
      const created: { id: string; email: string; role: string }[] = [];
      for (const user of candidates) {
        const role = (user.role ?? 'consultant')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        const row = await this.repo.insert(tx, {
          user_id: user.id,
          display_name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email,
          email: user.email.toLowerCase(),
          role: ROLE.test(role) ? role : 'consultant',
          time_zone: user.time_zone ?? 'UTC',
          assignment_group_ids: await this.repo.groupsOfUser(tx, user.id),
        });
        await this.repo.upsertCalendar(tx, row.id, {
          working_days: [1, 2, 3, 4, 5],
          day_start: '09:00',
          day_end: '17:00',
        });
        created.push({ id: row.id, email: row.email, role: row.role });
      }
      if (created.length > 0) {
        await this.audit.operator(
          tx,
          actorOf(principal),
          ctx,
          created.map((row) => ({
            entityKind: 'person',
            entityId: row.id,
            eventType: 'roster.person.imported' as const,
            newValue: row,
          })),
        );
      }
      return { created: created.length, people: created };
    });
  }

  setCalendar(principal: Principal, ctx: RequestContext, id: string, dto: CalendarDto) {
    if (dto.day_end <= dto.day_start) throw new BadRequestException({ code: 'day_end_before_start' });
    if (new Set(dto.working_days).size !== dto.working_days.length)
      throw new BadRequestException({ code: 'duplicate_working_day' });
    return this.uow.operator(async (tx) => {
      await this.repo.person(tx, id);
      const before = await this.repo.calendar(tx, id);
      const after = await this.repo.upsertCalendar(tx, id, dto);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'person',
          entityId: id,
          eventType: 'roster.calendar.updated',
          field: 'calendar',
          oldValue: before ?? null,
          newValue: after,
        },
      ]);
      return after;
    });
  }

  skillsCatalog(principal: Principal, includeInactive: boolean) {
    return this.uow.operator((tx) => this.repo.skills(tx, !includeInactive));
  }

  createSkill(principal: Principal, ctx: RequestContext, dto: CreateSkillDto) {
    return this.uow.operator(async (tx) => {
      if (await this.repo.skillByCode(tx, dto.code))
        throw new BadRequestException({ code: 'skill_exists', skill: dto.code });
      const row = await this.repo.insertSkill(tx, {
        kind: dto.kind,
        code: dto.code,
        name: dto.name,
        accountId: dto.account_id ?? null,
      });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        { entityKind: 'skill', entityId: row.id, eventType: 'created', newValue: { code: row.code, kind: row.kind } },
      ]);
      return row;
    });
  }

  personSkills(principal: Principal, id: string) {
    return this.uow.operator(async (tx) => {
      await this.repo.person(tx, id);
      return this.repo.personSkills(tx, id);
    });
  }

  setSkills(principal: Principal, ctx: RequestContext, id: string, dto: SkillsDto) {
    return this.uow.operator(async (tx) => {
      await this.repo.person(tx, id);
      const before = await this.repo.personSkills(tx, id);
      const entries: { skillId: string; level: number }[] = [];
      for (const item of dto.skills) {
        const skill = item.skill_id
          ? (await this.repo.skills(tx, false)).find((row) => row.id === item.skill_id)
          : item.code
            ? await this.repo.skillByCode(tx, item.code)
            : undefined;
        if (!skill)
          throw new NotFoundException({ code: 'not_found', entity: 'skill', skill: item.skill_id ?? item.code });
        if (entries.some((entry) => entry.skillId === skill.id))
          throw new BadRequestException({ code: 'duplicate_skill', skill: skill.code });
        entries.push({ skillId: skill.id, level: item.level });
      }
      await this.repo.replaceSkills(tx, id, entries, principal.userId);
      const after = await this.repo.personSkills(tx, id);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'person',
          entityId: id,
          eventType: 'roster.skills.updated',
          field: 'skills',
          oldValue: before.map((row) => `${row.code}:${row.level}`),
          newValue: after.map((row) => `${row.code}:${row.level}`),
        },
      ]);
      return after;
    });
  }

  certifications(principal: Principal, id: string) {
    return this.uow.operator(async (tx) => {
      await this.repo.person(tx, id);
      return this.repo.certifications(tx, id);
    });
  }

  addCertification(principal: Principal, ctx: RequestContext, id: string, dto: CertificationDto) {
    if (dto.expires_on && dto.expires_on < dto.obtained_on)
      throw new BadRequestException({ code: 'expires_before_obtained' });
    return this.uow.operator(async (tx) => {
      await this.repo.person(tx, id);
      const row = await this.repo.insertCertification(tx, {
        personId: id,
        name: dto.name,
        issuer: dto.issuer,
        obtainedOn: dto.obtained_on,
        expiresOn: dto.expires_on,
      });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'person',
          entityId: id,
          eventType: 'roster.certification.added',
          newValue: { id: row.id, name: row.name, expires_on: row.expires_on },
        },
      ]);
      return row;
    });
  }

  removeCertification(principal: Principal, ctx: RequestContext, id: string, certificationId: string) {
    return this.uow.operator(async (tx) => {
      const removed = await this.repo.deleteCertification(tx, id, certificationId);
      if (removed === 0) throw new NotFoundException({ code: 'not_found', entity: 'certification' });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'person',
          entityId: id,
          eventType: 'roster.certification.removed',
          oldValue: { id: certificationId },
        },
      ]);
    });
  }
}

// Controller ----------------------------------------------------------------------

@ApiTags('roster')
@ApiBearerAuth()
@Controller('roster')
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  @Get('people')
  @RequirePermission('capacity:view')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('active') active?: string,
    @Query('role') role?: string,
    @Query('group') group?: string,
    @Query('skill') skill?: string,
    @Query('q') q?: string,
  ) {
    return this.roster.list(principal, { active, role, group, skill, q });
  }

  @Post('people')
  @RequirePermission('admin:users')
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreatePersonDto) {
    return this.roster.create(principal, ctx, dto);
  }

  @Post('import')
  @RequirePermission('admin:users')
  importFromDirectory(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext) {
    return this.roster.importFromDirectory(principal, ctx);
  }

  @Get('skills')
  @RequirePermission('capacity:view')
  skills(@CurrentPrincipal() principal: Principal, @Query('include_inactive') includeInactive?: string) {
    return this.roster.skillsCatalog(principal, includeInactive === 'true');
  }

  @Post('skills')
  @RequirePermission('capacity:manage')
  createSkill(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: CreateSkillDto,
  ) {
    return this.roster.createSkill(principal, ctx, dto);
  }

  @Get('people/:id')
  @RequirePermission('capacity:view')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.roster.get(principal, id);
  }

  @Patch('people/:id')
  @RequirePermission('admin:users')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchPersonDto,
  ) {
    return this.roster.patch(principal, ctx, id, dto);
  }

  @Put('people/:id/calendar')
  @RequirePermission('capacity:manage')
  calendar(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CalendarDto,
  ) {
    return this.roster.setCalendar(principal, ctx, id, dto);
  }

  @Get('people/:id/skills')
  @RequirePermission('capacity:view')
  personSkills(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.roster.personSkills(principal, id);
  }

  @Put('people/:id/skills')
  @RequirePermission('capacity:manage')
  setSkills(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SkillsDto,
  ) {
    return this.roster.setSkills(principal, ctx, id, dto);
  }

  @Get('people/:id/certifications')
  @RequirePermission('capacity:view')
  certifications(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.roster.certifications(principal, id);
  }

  @Post('people/:id/certifications')
  @RequirePermission('capacity:manage')
  addCertification(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CertificationDto,
  ) {
    return this.roster.addCertification(principal, ctx, id, dto);
  }

  @Delete('people/:id/certifications/:certificationId')
  @HttpCode(204)
  @RequirePermission('capacity:manage')
  removeCertification(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('certificationId', ParseUUIDPipe) certificationId: string,
  ) {
    return this.roster.removeCertification(principal, ctx, id, certificationId);
  }
}

@Module({
  providers: [RosterRepository, RosterService],
  exports: [RosterRepository, RosterService],
})
export class RosterCoreModule {}

@Module({
  imports: [RosterCoreModule],
  controllers: [RosterController],
  exports: [RosterCoreModule],
})
export class RosterModule {}
