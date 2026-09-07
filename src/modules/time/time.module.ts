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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { position, type BillableClassSpec, type ContractPosition } from '../../domain/time/burn.js';
import { unloggedByDay, weekBounds } from '../../domain/time/unlogged.js';
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

  @IsOptional()
  @IsBoolean()
  after_hours?: boolean;

  /** Log on behalf of another person (needs time:adjust). */
  @IsOptional()
  @IsUUID('4')
  person_id?: string;
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
      const days = await this.unloggedDays(tx, principal, bounds.from, bounds.to, entries);
      return {
        ...bounds,
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
      const days = await this.unloggedDays(tx, principal, from, to, entries);
      return { from, to, days, unlogged_minutes: days.reduce((sum, day) => sum + day.unlogged_minutes, 0) };
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
    return unloggedByDay({
      from,
      to,
      calendar: calendar ? { workingDays: calendar.workingDays, hoursPerDay: calendar.hoursPerDay } : null,
      holidays: new Set(calendar?.holidays ?? []),
      logged,
    });
  }

  ofAccount(principal: Principal, accountId: string, from: string, to: string) {
    return this.uow.run(principal, (tx) => this.time.entriesOfAccount(tx, accountId, from, to));
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
      const row = await this.time.insertAdjustment(tx, {
        accountId: entry.account_id,
        entryId: entry.id,
        contractId: entry.contract_id,
        performedOn: entry.performed_on,
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
      const period = await this.time.insertPeriod(tx, {
        accountId,
        contractId,
        startsOn: dto.starts_on,
        endsOn: dto.ends_on,
        contractedMinutes: dto.contracted_minutes,
        carriedOverMinutes: dto.carried_over_minutes,
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

  lockBillingPeriod(principal: Principal, ctx: RequestContext, accountId: string, periodId: string) {
    return this.uow.run(principal, async (tx) => {
      const period = await this.time.lockBillingPeriod(tx, periodId, principal.userId);
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'billing_period',
          entityId: period.id,
          eventType: 'updated',
          field: 'status',
          newValue: 'locked',
        },
      ]);
      return period;
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
    const billing = await this.time.billingPeriodFor(tx, target.accountId, dto.performed_on);
    if (billing && (billing.status === 'locked' || billing.status === 'exported'))
      throw new ConflictException({ code: 'billing_period_locked' });
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
      afterHours: Boolean(dto.after_hours),
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
        },
      },
    ]);
    return entry;
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
}

function dateOr(value: string | undefined, offsetDays: number): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

@Module({
  imports: [TicketsCoreModule],
  controllers: [TimeController],
  providers: [TimeService, TimeRepository],
  exports: [TimeService],
})
export class TimeModule {}
