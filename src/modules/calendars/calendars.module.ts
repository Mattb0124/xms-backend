import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
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
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import {
  BusinessCalendar,
  isValidTimeZone,
  validateHours,
  type CalendarHours,
} from '../../domain/calendar/business-calendar.js';
import { WALL_CLOCK, type Calendar } from '../../domain/sla/engine.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';

/**
 * Business calendars (Accounts & Administration technical 2.4, 3.2, section
 * 4; TM-06; P3.26.1 core): one document per calendar with its hours and the
 * holiday library it follows, the account default, a preview route that
 * answers "when is this due", and the loader the SLA engine calls. Clocks
 * keep the calendar id they started on; `24x7` is the wall clock and the
 * fallback for an account without a default.
 */
export const WALL_CLOCK_ID = '24x7';

export interface CalendarRow {
  id: string;
  account_id: string;
  name: string;
  time_zone: string;
  effective_from: string;
  holiday_calendar_id: string | null;
  status: 'active' | 'retired';
  version: number;
  created_at: string;
  updated_at: string;
}

export interface HoursRow {
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface HolidayCalendarRow {
  id: string;
  country: string;
  name: string;
}

@Injectable()
export class CalendarsRepository extends RepositoryBase {
  list(tx: Tx, accountId: string): Promise<CalendarRow[]> {
    return this.many(tx, 'select * from acct.business_calendars where account_id = $1 order by name', [accountId]);
  }

  byId(tx: Tx, id: string): Promise<CalendarRow> {
    return this.one(tx, 'calendar', 'select * from acct.business_calendars where id = $1', [id]);
  }

  insert(
    tx: Tx,
    input: {
      accountId: string;
      name: string;
      timeZone: string;
      holidayCalendarId: string | null;
      effectiveFrom?: string;
    },
  ): Promise<CalendarRow> {
    return this.one(
      tx,
      'calendar',
      `insert into acct.business_calendars (account_id, name, time_zone, holiday_calendar_id, effective_from)
       values ($1, $2, $3, $4, coalesce($5::date, current_date)) returning *`,
      [input.accountId, input.name, input.timeZone, input.holidayCalendarId, input.effectiveFrom ?? null],
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<CalendarRow> {
    return this.updateVersioned(tx, 'calendar', 'acct.business_calendars', id, version, assignments);
  }

  hours(tx: Tx, calendarId: string): Promise<HoursRow[]> {
    return this.many(
      tx,
      'select weekday, start_minute, end_minute from acct.calendar_hours where calendar_id = $1 order by weekday, start_minute',
      [calendarId],
    );
  }

  async replaceHours(tx: Tx, accountId: string, calendarId: string, hours: readonly CalendarHours[]): Promise<void> {
    await tx.query('delete from acct.calendar_hours where calendar_id = $1', [calendarId]);
    for (const entry of hours) {
      await tx.query(
        'insert into acct.calendar_hours (account_id, calendar_id, weekday, start_minute, end_minute) values ($1, $2, $3, $4, $5)',
        [accountId, calendarId, entry.weekday, entry.startMinute, entry.endMinute],
      );
    }
  }

  holidayCalendars(tx: Tx): Promise<HolidayCalendarRow[]> {
    return this.many(tx, 'select id, country, name from op.holiday_calendars order by country, name');
  }

  holidayCalendar(tx: Tx, id: string): Promise<HolidayCalendarRow> {
    return this.one(tx, 'holiday_calendar', 'select id, country, name from op.holiday_calendars where id = $1', [id]);
  }

  holidays(tx: Tx, calendarId: string): Promise<{ date: string; label: string }[]> {
    return this.many(tx, 'select date::text as date, label from op.holidays where calendar_id = $1 order by date', [
      calendarId,
    ]);
  }

  insertHolidayCalendar(
    tx: Tx,
    input: { country: string; name: string; holidays: { date: string; label: string }[] },
  ): Promise<HolidayCalendarRow> {
    return this.one<HolidayCalendarRow>(
      tx,
      'holiday_calendar',
      'insert into op.holiday_calendars (country, name) values ($1, $2) returning id, country, name',
      [input.country, input.name],
    ).then(async (row) => {
      for (const holiday of input.holidays) {
        await tx.query(
          'insert into op.holidays (calendar_id, date, label) values ($1, $2, $3) on conflict do nothing',
          [row.id, holiday.date, holiday.label],
        );
      }
      return row;
    });
  }

  async setAccountDefault(tx: Tx, accountId: string, calendarId: string | null): Promise<void> {
    await tx.query('update op.accounts set default_calendar_id = $2 where id = $1', [accountId, calendarId]);
  }

  accountDefault(tx: Tx, accountId: string): Promise<string | null> {
    return this.maybeOne<{ default_calendar_id: string | null }>(
      tx,
      'select default_calendar_id from op.accounts where id = $1',
      [accountId],
    ).then((row) => row?.default_calendar_id ?? null);
  }
}

// DTOs ---------------------------------------------------------------------

class HoursDto {
  @IsInt() @Min(0) @Max(6) weekday!: number;
  @IsInt() @Min(0) @Max(1440) start_minute!: number;
  @IsInt() @Min(0) @Max(1440) end_minute!: number;
}

class CreateCalendarDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsString() @MaxLength(64) time_zone!: string;
  @IsOptional() @IsUUID('4') holiday_calendar_id?: string | null;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) effective_from?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => HoursDto)
  hours!: HoursDto[];
  @IsOptional() @IsBoolean() make_default?: boolean;
}

class PatchCalendarDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(64) time_zone?: string;
  @IsOptional() @IsUUID('4') holiday_calendar_id?: string | null;
  @IsOptional() @IsIn(['active', 'retired']) status?: 'active' | 'retired';
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => HoursDto)
  hours?: HoursDto[];
  @IsOptional() @IsBoolean() make_default?: boolean;
}

class PreviewDto {
  @IsString() start!: string;
  @IsInt() @Min(0) @Max(1_000_000) minutes!: number;
}

class HolidayDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsString() @MinLength(1) @MaxLength(120) label!: string;
}

class CreateHolidayCalendarDto {
  @IsString() @MinLength(2) @MaxLength(2) country!: string;
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsArray() @ArrayMaxSize(400) @ValidateNested({ each: true }) @Type(() => HolidayDto) holidays!: HolidayDto[];
}

// Service --------------------------------------------------------------------

interface CalendarDocument extends CalendarRow {
  hours: HoursRow[];
  holidays: { date: string; label: string }[];
  is_default: boolean;
}

@Injectable()
export class CalendarService {
  private readonly cache = new Map<string, { at: number; calendar: Calendar }>();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: CalendarsRepository,
    private readonly audit: AuditService,
  ) {}

  // The loader the SLA engine uses ------------------------------------------

  /** The calendar a clock references; `24x7` and unknown ids resolve to the wall clock so a clock never fails to render. */
  async byId(tx: Tx, calendarId: string | null | undefined): Promise<Calendar> {
    if (!calendarId || calendarId === WALL_CLOCK_ID) return WALL_CLOCK;
    const cached = this.cache.get(calendarId);
    if (cached && Date.now() - cached.at < 60_000) return cached.calendar;
    let calendar: Calendar = WALL_CLOCK;
    try {
      const row = await this.repo.byId(tx, calendarId);
      const hours = await this.repo.hours(tx, calendarId);
      const holidays = row.holiday_calendar_id
        ? (await this.repo.holidays(tx, row.holiday_calendar_id)).map((h) => h.date)
        : [];
      calendar = new BusinessCalendar({
        id: row.id,
        timeZone: row.time_zone,
        hours: hours.map((h) => ({ weekday: h.weekday, startMinute: h.start_minute, endMinute: h.end_minute })),
        holidays,
      });
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    this.cache.set(calendarId, { at: Date.now(), calendar });
    return calendar;
  }

  /** The account's default calendar, or the wall clock. */
  async forAccount(tx: Tx, accountId: string): Promise<Calendar> {
    return this.byId(tx, await this.repo.accountDefault(tx, accountId));
  }

  async forClocks(tx: Tx, clocks: readonly { calendar_id: string }[]): Promise<Map<string, Calendar>> {
    const result = new Map<string, Calendar>();
    for (const clock of clocks)
      if (!result.has(clock.calendar_id)) result.set(clock.calendar_id, await this.byId(tx, clock.calendar_id));
    return result;
  }

  invalidate(calendarId?: string): void {
    if (calendarId) this.cache.delete(calendarId);
    else this.cache.clear();
  }

  // Administration -------------------------------------------------------------

  list(principal: Principal, accountId: string) {
    return this.uow.run(principal, async (tx) => {
      const defaultId = await this.repo.accountDefault(tx, accountId);
      const rows = await this.repo.list(tx, accountId);
      return Promise.all(rows.map((row) => this.document(tx, row, defaultId)));
    });
  }

  get(principal: Principal, id: string) {
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.byId(tx, id);
      return this.document(tx, row, await this.repo.accountDefault(tx, row.account_id));
    });
  }

  create(principal: Principal, ctx: RequestContext, accountId: string, dto: CreateCalendarDto) {
    this.validate(dto.time_zone, dto.hours);
    return this.uow.run(principal, async (tx) => {
      if (dto.holiday_calendar_id) await this.repo.holidayCalendar(tx, dto.holiday_calendar_id);
      const row = await this.repo.insert(tx, {
        accountId,
        name: dto.name,
        timeZone: dto.time_zone,
        holidayCalendarId: dto.holiday_calendar_id ?? null,
        effectiveFrom: dto.effective_from,
      });
      await this.repo.replaceHours(tx, accountId, row.id, toHours(dto.hours));
      const existing = await this.repo.accountDefault(tx, accountId);
      const makeDefault = dto.make_default ?? existing === null;
      if (makeDefault) await this.repo.setAccountDefault(tx, accountId, row.id);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'calendar',
          entityId: row.id,
          eventType: 'admin.calendar.updated',
          field: 'created',
          newValue: { name: row.name, time_zone: row.time_zone, hours: dto.hours, is_default: makeDefault },
        },
      ]);
      this.invalidate(row.id);
      return this.document(tx, row, makeDefault ? row.id : existing);
    });
  }

  patch(principal: Principal, ctx: RequestContext, id: string, dto: PatchCalendarDto) {
    if (dto.time_zone !== undefined || dto.hours !== undefined)
      this.validate(dto.time_zone ?? 'UTC', dto.hours ?? [{ weekday: 1, start_minute: 0, end_minute: 1 }]);
    return this.uow.run(principal, async (tx) => {
      const before = await this.repo.byId(tx, id);
      const assignments: Record<string, unknown> = {};
      for (const field of ['name', 'time_zone', 'holiday_calendar_id', 'status'] as const)
        if (dto[field] !== undefined) assignments[field] = dto[field];
      if (dto.holiday_calendar_id) await this.repo.holidayCalendar(tx, dto.holiday_calendar_id);
      const after =
        Object.keys(assignments).length > 0 ? await this.repo.update(tx, id, dto.version, assignments) : before;
      if (dto.hours) await this.repo.replaceHours(tx, before.account_id, id, toHours(dto.hours));
      if (dto.make_default === true) await this.repo.setAccountDefault(tx, before.account_id, id);
      if (dto.status === 'retired' && (await this.repo.accountDefault(tx, before.account_id)) === id)
        await this.repo.setAccountDefault(tx, before.account_id, null);
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'calendar',
          entityId: id,
          eventType: 'admin.calendar.updated',
          oldValue: { name: before.name, time_zone: before.time_zone, status: before.status },
          newValue: {
            name: after.name,
            time_zone: after.time_zone,
            status: after.status,
            hours: dto.hours,
            make_default: dto.make_default,
          },
        },
      ]);
      this.invalidate(id);
      return this.document(tx, after, await this.repo.accountDefault(tx, before.account_id));
    });
  }

  /** Answers "when is this due" for the editor (TM-06 check). */
  preview(principal: Principal, id: string, dto: PreviewDto) {
    const start = new Date(dto.start);
    if (Number.isNaN(start.getTime())) throw new BadRequestException({ code: 'bad_start' });
    return this.uow.run(principal, async (tx) => {
      await this.repo.byId(tx, id);
      this.invalidate(id);
      const calendar = await this.byId(tx, id);
      const due = calendar.addMinutes(start, dto.minutes);
      return {
        start: start.toISOString(),
        minutes: dto.minutes,
        due_at: due.toISOString(),
        working_minutes_between: calendar.minutesBetween(start, due),
        wall_minutes_between: Math.round((due.getTime() - start.getTime()) / 60_000),
        starts_in_working_time: calendar instanceof BusinessCalendar ? calendar.isWorkingTime(start) : true,
      };
    });
  }

  holidayCalendars(_principal: Principal) {
    return this.uow.operator(async (tx) => {
      const rows = await this.repo.holidayCalendars(tx);
      return Promise.all(rows.map(async (row) => ({ ...row, holidays: await this.repo.holidays(tx, row.id) })));
    });
  }

  createHolidayCalendar(principal: Principal, ctx: RequestContext, dto: CreateHolidayCalendarDto) {
    return this.uow.operator(async (tx) => {
      const row = await this.repo.insertHolidayCalendar(tx, {
        country: dto.country.toUpperCase(),
        name: dto.name,
        holidays: dto.holidays,
      });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'holiday_calendar',
          entityId: row.id,
          eventType: 'created',
          newValue: { country: row.country, name: row.name, holidays: dto.holidays.length },
        },
      ]);
      this.invalidate();
      return { ...row, holidays: dto.holidays };
    });
  }

  private validate(timeZone: string, hours: HoursDto[]): void {
    if (!isValidTimeZone(timeZone)) throw new BadRequestException({ code: 'invalid_time_zone', time_zone: timeZone });
    const problems = validateHours(toHours(hours));
    if (problems.length > 0) throw new BadRequestException({ code: 'invalid_hours', problems });
  }

  private async document(tx: Tx, row: CalendarRow, defaultId: string | null): Promise<CalendarDocument> {
    return {
      ...row,
      hours: await this.repo.hours(tx, row.id),
      holidays: row.holiday_calendar_id ? await this.repo.holidays(tx, row.holiday_calendar_id) : [],
      is_default: defaultId === row.id,
    };
  }
}

function toHours(hours: HoursDto[]): CalendarHours[] {
  return hours.map((h) => ({ weekday: h.weekday, startMinute: h.start_minute, endMinute: h.end_minute }));
}

// Controllers ------------------------------------------------------------------

@ApiTags('calendars')
@ApiBearerAuth()
@Controller()
export class CalendarsController {
  constructor(private readonly calendars: CalendarService) {}

  @Get('accounts/:id/calendars')
  @RequirePermission('tickets:view')
  list(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.calendars.list(principal, id);
  }

  @Post('accounts/:id/calendars')
  @RequirePermission('admin:config')
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCalendarDto,
  ) {
    return this.calendars.create(principal, ctx, id, dto);
  }

  @Get('calendars/:id')
  @RequirePermission('tickets:view')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.calendars.get(principal, id);
  }

  @Patch('calendars/:id')
  @RequirePermission('admin:config')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchCalendarDto,
  ) {
    return this.calendars.patch(principal, ctx, id, dto);
  }

  @Post('calendars/:id/preview')
  @RequirePermission('admin:config')
  preview(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PreviewDto) {
    return this.calendars.preview(principal, id, dto);
  }

  @Get('holiday-calendars')
  @RequirePermission('admin:config')
  holidayCalendars(@CurrentPrincipal() principal: Principal) {
    return this.calendars.holidayCalendars(principal);
  }

  @Post('holiday-calendars')
  @RequirePermission('admin:config')
  createHolidayCalendar(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: CreateHolidayCalendarDto,
  ) {
    return this.calendars.createHolidayCalendar(principal, ctx, dto);
  }
}

@Module({
  providers: [CalendarsRepository, CalendarService],
  exports: [CalendarsRepository, CalendarService],
})
export class CalendarsCoreModule {}

@Module({
  imports: [CalendarsCoreModule],
  controllers: [CalendarsController],
  exports: [CalendarsCoreModule],
})
export class CalendarsModule {}
