import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { randomUUID } from 'node:crypto';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService, SYSTEM_ACTOR, type AuditActor } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import type { MailTransport } from '../../common/mail/mail-transport.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import { MAIL_TRANSPORT, OBJECT_STORE, StorageCoreModule } from '../../common/storage/storage.module.js';
import { DbPools } from '../../db/pool.js';
import { RepositoryBase, type Tx, quoteIdent } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { nextRunAt, periodBefore, type Cadence, type PeriodKind } from '../../domain/reporting/schedule.js';
import type { Job } from '../../worker/jobs.js';
import { CalendarsCoreModule, CalendarService } from '../calendars/calendars.module.js';
import { EmailCoreModule } from '../email/email.module.js';
import { EmailRepository } from '../email/email.repository.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { ReportingCoreModule } from './reporting.module.js';
import { ReportingService } from './reporting.service.js';

/**
 * Report schedules and distribution (Dashboards & Report Packs functional
 * 5.7, technical 2.3 and 3; DR-05): administrators keep one or more
 * schedules per account; the worker claims the due ones behind its lease,
 * builds the pack through the shared builder, and delivers it: a
 * notification with the download for internal recipients, an email with
 * the link from the account's sender identity for portal users and
 * contacts. The per-recipient outcome lives on the run.
 */

export interface ScheduleRow {
  id: string;
  account_id: string;
  name: string;
  pack_type: 'wsr' | 'qbr' | 'custom';
  cadence: Cadence;
  run_day: number;
  run_time: string;
  period_kind: PeriodKind;
  formats: string[];
  template_id: string | null;
  distribution: Recipient[];
  review_required: boolean;
  review_grace_hours: number;
  enabled: boolean;
  next_run_at: string | null;
  last_run_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Recipient {
  kind: 'internal' | 'portal_user' | 'contact';
  id?: string;
  email?: string;
  name?: string;
}

export interface DeliveryOutcome {
  kind: Recipient['kind'];
  to: string;
  /** Who the recipient is, so the run detail names a person rather than an id. */
  name?: string;
  outcome: 'notified' | 'emailed' | 'skipped';
  reason?: string;
}

/** `run_time` is a time column; every route speaks HH:MM, which is what the PATCH accepts. */
export function hhmm<T extends { run_time: string }>(row: T): T {
  return { ...row, run_time: String(row.run_time).slice(0, 5) };
}

// Repository -------------------------------------------------------------------

@Injectable()
export class SchedulesRepository extends RepositoryBase {
  async list(tx: Tx, accountId?: string): Promise<ScheduleRow[]> {
    const rows = await this.many<ScheduleRow>(
      tx,
      `select *, run_time::text as run_time from acct.report_schedules where ($1::uuid is null or account_id = $1) order by account_id, name`,
      [accountId ?? null],
    );
    return rows.map(hhmm);
  }

  async byId(tx: Tx, id: string): Promise<ScheduleRow> {
    return hhmm(
      await this.one<ScheduleRow>(
        tx,
        'report_schedule',
        'select *, run_time::text as run_time from acct.report_schedules where id = $1',
        [id],
      ),
    );
  }

  insert(tx: Tx, values: Record<string, unknown>): Promise<ScheduleRow> {
    const keys = Object.keys(values);
    return this.one<ScheduleRow>(
      tx,
      'report_schedule',
      `insert into acct.report_schedules (${keys.map(quoteIdent).join(', ')})
       values (${keys.map((_, index) => `$${index + 1}`).join(', ')}) returning *, run_time::text as run_time`,
      keys.map((key) => values[key]),
    ).then((row) => hhmm(row));
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<ScheduleRow> {
    const values = { ...assignments };
    if ('distribution' in values) values.distribution = JSON.stringify(values.distribution);
    return this.updateVersioned<ScheduleRow>(tx, 'report_schedule', 'acct.report_schedules', id, version, values).then(
      (row) => hhmm(row),
    );
  }

  /** Claims due, enabled schedules: SKIP LOCKED so two workers never run the same one. */
  async claimDue(tx: Tx, now: Date, batch: number): Promise<ScheduleRow[]> {
    return (
      await this.many<ScheduleRow>(
        tx,
        `select *, run_time::text as run_time from acct.report_schedules
        where enabled and next_run_at is not null and next_run_at <= $1
        order by next_run_at limit $2 for update skip locked`,
        [now, batch],
      )
    ).map(hhmm);
  }

  async advance(tx: Tx, id: string, nextRunAt: Date, lastRunId: string | null): Promise<void> {
    await tx.query('update acct.report_schedules set next_run_at = $2, last_run_id = $3 where id = $1', [
      id,
      nextRunAt,
      lastRunId,
    ]);
  }

  async setDelivery(tx: Tx, runId: string, delivery: DeliveryOutcome[], status: 'sent' | 'failed'): Promise<void> {
    await tx.query(`update acct.report_runs set delivery = $2, status = $3 where id = $1`, [
      runId,
      JSON.stringify(delivery),
      status,
    ]);
  }

  runs(
    tx: Tx,
    filter: { accountId?: string; status?: string; scheduleId?: string },
  ): Promise<Record<string, unknown>[]> {
    return this.many(
      tx,
      `select r.*, p.pptx_key from acct.report_runs r left join acct.report_packs p on p.run_id = r.id
        where ($1::uuid is null or r.account_id = $1) and ($2::text is null or r.status = $2) and ($3::uuid is null or r.schedule_id = $3)
        order by r.created_at desc limit 100`,
      [filter.accountId ?? null, filter.status ?? null, filter.scheduleId ?? null],
    );
  }
}

// DTOs ----------------------------------------------------------------------------

export class RecipientDto {
  @IsIn(['internal', 'portal_user', 'contact']) kind!: Recipient['kind'];
  @IsOptional() @IsUUID('4') id?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}

export class ScheduleFieldsDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(['weekly', 'monthly', 'quarterly']) cadence?: Cadence;
  @IsOptional() @IsInt() @Min(1) @Max(31) run_day?: number;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) run_time?: string;
  @IsOptional() @IsIn(['previous_week', 'previous_month', 'previous_quarter']) period_kind?: PeriodKind;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RecipientDto)
  distribution?: RecipientDto[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class CreateScheduleDto extends ScheduleFieldsDto {
  @IsUUID('4') account_id!: string;
  @IsString() @MinLength(1) @MaxLength(120) declare name: string;
  @IsIn(['weekly', 'monthly', 'quarterly']) declare cadence: Cadence;
  @IsInt() @Min(1) @Max(31) declare run_day: number;
}

export class PatchScheduleDto extends ScheduleFieldsDto {
  @IsInt() @Min(1) version!: number;
}

export class RunNowDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) period_start?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) period_end?: string;
}

// Service -------------------------------------------------------------------------

function defaultPeriodKind(cadence: Cadence): PeriodKind {
  return cadence === 'weekly' ? 'previous_week' : cadence === 'monthly' ? 'previous_month' : 'previous_quarter';
}

@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly pools: DbPools,
    private readonly repo: SchedulesRepository,
    private readonly reporting: ReportingService,
    private readonly calendars: CalendarService,
    private readonly email: EmailRepository,
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  list(principal: Principal, accountId?: string) {
    return this.uow.run(principal, (tx) => this.repo.list(tx, accountId));
  }

  runs(principal: Principal, filter: { accountId?: string; status?: string; scheduleId?: string }) {
    return this.uow.run(principal, (tx) => this.repo.runs(tx, filter));
  }

  create(principal: Principal, ctx: RequestContext, dto: CreateScheduleDto) {
    if (!principal.accountIds.includes(dto.account_id))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    if (dto.cadence === 'weekly' && dto.run_day > 7) throw new BadRequestException({ code: 'run_day_weekly', max: 7 });
    return this.uow.run(principal, async (tx) => {
      const timeZone = await this.timeZoneOf(tx, dto.account_id);
      const spec = {
        cadence: dto.cadence,
        runDay: dto.run_day,
        runTime: dto.run_time ?? '06:00',
        periodKind: dto.period_kind ?? defaultPeriodKind(dto.cadence),
      };
      const row = await this.repo.insert(tx, {
        account_id: dto.account_id,
        name: dto.name,
        cadence: spec.cadence,
        run_day: spec.runDay,
        run_time: spec.runTime,
        period_kind: spec.periodKind,
        distribution: JSON.stringify(dto.distribution ?? []),
        enabled: dto.enabled ?? true,
        next_run_at: (dto.enabled ?? true) ? nextRunAt(spec, new Date(), timeZone) : null,
      });
      await this.audit.account(tx, dto.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'report_schedule',
          entityId: row.id,
          eventType: 'created',
          newValue: { name: row.name, cadence: row.cadence, run_day: row.run_day, next_run_at: row.next_run_at },
        },
      ]);
      return row;
    });
  }

  patch(principal: Principal, ctx: RequestContext, id: string, dto: PatchScheduleDto) {
    return this.uow.run(principal, async (tx) => {
      const before = await this.repo.byId(tx, id);
      const next = {
        name: dto.name ?? before.name,
        cadence: dto.cadence ?? before.cadence,
        run_day: dto.run_day ?? before.run_day,
        run_time: dto.run_time ?? before.run_time.slice(0, 5),
        period_kind:
          dto.period_kind ??
          (dto.cadence && dto.cadence !== before.cadence ? defaultPeriodKind(dto.cadence) : before.period_kind),
        distribution: dto.distribution ?? before.distribution,
        enabled: dto.enabled ?? before.enabled,
      };
      if (next.cadence === 'weekly' && next.run_day > 7)
        throw new BadRequestException({ code: 'run_day_weekly', max: 7 });
      const timeZone = await this.timeZoneOf(tx, before.account_id);
      const spec = {
        cadence: next.cadence,
        runDay: next.run_day,
        runTime: next.run_time,
        periodKind: next.period_kind,
      };
      const after = await this.repo.update(tx, id, dto.version, {
        ...next,
        next_run_at: next.enabled ? nextRunAt(spec, new Date(), timeZone) : null,
      });
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'report_schedule',
          entityId: id,
          eventType: 'updated',
          oldValue: { cadence: before.cadence, run_day: before.run_day, enabled: before.enabled },
          newValue: {
            cadence: after.cadence,
            run_day: after.run_day,
            enabled: after.enabled,
            next_run_at: after.next_run_at,
          },
        },
      ]);
      return after;
    });
  }

  /** An off-cycle run now, for the schedule's period or the one given; delivered like a scheduled run. */
  runNow(principal: Principal, ctx: RequestContext, id: string, dto: RunNowDto) {
    return this.uow.run(principal, async (tx) => {
      const schedule = await this.repo.byId(tx, id);
      const timeZone = await this.timeZoneOf(tx, schedule.account_id);
      const period =
        dto.period_start && dto.period_end
          ? { start: dto.period_start, end: dto.period_end }
          : periodBefore(schedule.period_kind, new Date(), timeZone);
      if (period.end < period.start) throw new BadRequestException({ code: 'invalid_range' });
      return this.execute(tx, schedule, period, actorOf(principal), principal.userId, ctx);
    });
  }

  /** Builds the pack and delivers it; returns the run with the delivery outcome. */
  private async execute(
    tx: Tx,
    schedule: ScheduleRow,
    period: { start: string; end: string },
    actor: AuditActor,
    requestedBy: string,
    ctx: Parameters<AuditService['account']>[3],
  ) {
    const built = await this.reporting.buildWsr(tx, {
      accountId: schedule.account_id,
      period: {
        start: new Date(`${period.start}T00:00:00Z`),
        end: new Date(new Date(`${period.end}T00:00:00Z`).getTime() + 86_400_000),
      },
      requestedBy,
      scheduleId: schedule.id,
      actor,
      ctx,
    });
    const download = await this.store.presignDownload(built.pptx_key, {
      fileName: built.file_name,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      expiresSeconds: 7 * 24 * 3600,
    });
    const delivery = await this.deliver(tx, schedule, built, download, period);
    const failed = delivery.length > 0 && delivery.every((row) => row.outcome === 'skipped');
    await this.repo.setDelivery(tx, built.run_id, delivery, failed ? 'failed' : 'sent');
    await this.repo.advance(
      tx,
      schedule.id,
      schedule.next_run_at ? new Date(schedule.next_run_at) : new Date(),
      built.run_id,
    );
    return { run_id: built.run_id, pack_id: built.pack_id, period, delivery, status: failed ? 'failed' : 'sent' };
  }

  private async deliver(
    tx: Tx,
    schedule: ScheduleRow,
    built: { run_id: string; pack_id: string; file_name: string },
    download: string,
    period: { start: string; end: string },
  ): Promise<DeliveryOutcome[]> {
    const outcomes: DeliveryOutcome[] = [];
    const identity = await this.email.defaultIdentity(tx, schedule.account_id);
    for (const recipient of schedule.distribution) {
      if (recipient.kind === 'internal') {
        if (!recipient.id) {
          outcomes.push({ kind: recipient.kind, to: recipient.email ?? '', outcome: 'skipped', reason: 'no_user_id' });
          continue;
        }
        const named =
          recipient.name ??
          (
            await tx.query<{ name: string }>(
              `select nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '') as name from op.users where id = $1`,
              [recipient.id],
            )
          ).rows[0]?.name ??
          recipient.email;
        await this.notifications.upsert(tx, {
          accountId: schedule.account_id,
          recipientId: recipient.id,
          type: 'report.pack.ready',
          title: `${schedule.name}: report pack for ${period.start} to ${period.end}`,
          body: built.file_name,
          targetKind: 'report_pack',
          targetId: built.pack_id,
          link: `/reports/packs/${built.pack_id}`,
          collapseKey: `report:${built.run_id}`,
        });
        outcomes.push({ kind: recipient.kind, to: recipient.id, name: named, outcome: 'notified' });
        continue;
      }
      if (!recipient.email) {
        outcomes.push({ kind: recipient.kind, to: recipient.id ?? '', outcome: 'skipped', reason: 'no_email' });
        continue;
      }
      if (!identity) {
        outcomes.push({ kind: recipient.kind, to: recipient.email, outcome: 'skipped', reason: 'no_sender_identity' });
        continue;
      }
      try {
        const messageId = `<${randomUUID()}@${identity.address.split('@')[1] ?? 'xms'}>`;
        const composer = new MailComposer({
          from: { name: identity.display_name, address: identity.address },
          to: recipient.email,
          subject: `${schedule.name}: ${period.start} to ${period.end}`,
          text: `Your report pack for ${period.start} to ${period.end} is ready.\n\nDownload (valid seven days): ${download}\n`,
          messageId,
          headers: { 'Auto-Submitted': 'auto-generated' },
        });
        const raw = await composer.compile().build();
        await this.transport.send({ from: identity.address, to: [recipient.email], raw, messageId });
        outcomes.push({ kind: recipient.kind, to: recipient.email, name: recipient.name, outcome: 'emailed' });
      } catch (error) {
        this.logger.warn(`report delivery to ${recipient.email} failed: ${(error as Error).message}`);
        outcomes.push({ kind: recipient.kind, to: recipient.email, outcome: 'skipped', reason: 'send_failed' });
      }
    }
    return outcomes;
  }

  private async timeZoneOf(tx: Tx, accountId: string): Promise<string> {
    const calendar = await this.calendars.forAccount(tx, accountId);
    return (calendar as { timeZone?: string }).timeZone ?? 'UTC';
  }

  // The worker side -----------------------------------------------------------------

  scheduleJob(intervalMs = 5 * 60_000): Job {
    return { name: 'report.schedule', intervalMs, run: () => this.runDue() };
  }

  /** Claims every due schedule, builds and delivers its pack, and advances it past now. */
  async runDue(now = new Date(), batch = 20): Promise<string> {
    const accounts = (
      await this.pools
        .get('worker')
        .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding', 'offboarding')`)
    ).rows.map((row) => row.id);
    if (accounts.length === 0) return 'ran 0';
    let ran = 0;
    let failed = 0;
    await this.uow.perAccount(accounts, async (tx) => {
      const due = await this.repo.claimDue(tx, now, batch);
      for (const schedule of due) {
        const timeZone = await this.timeZoneOf(tx, schedule.account_id);
        const runAt = schedule.next_run_at ? new Date(schedule.next_run_at) : now;
        const spec = {
          cadence: schedule.cadence,
          runDay: schedule.run_day,
          runTime: schedule.run_time.slice(0, 5),
          periodKind: schedule.period_kind,
        };
        const period = periodBefore(schedule.period_kind, runAt, timeZone);
        try {
          const result = await this.execute(
            tx,
            { ...schedule, next_run_at: nextRunAt(spec, now, timeZone).toISOString() },
            period,
            SYSTEM_ACTOR,
            'system',
            { correlationId: `schedule:${schedule.id}:${period.start}` },
          );
          ran += 1;
          if (result.status === 'failed') failed += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(`schedule ${schedule.id} failed: ${(error as Error).message}`);
          await this.repo.advance(tx, schedule.id, nextRunAt(spec, now, timeZone), schedule.last_run_id);
        }
      }
    });
    return `ran ${ran}${failed ? ` (${failed} failed)` : ''}`;
  }
}

// Controller ----------------------------------------------------------------------

@ApiTags('reporting')
@ApiBearerAuth()
@Controller('reporting')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get('schedules')
  @RequirePermission('reports:manage')
  list(@CurrentPrincipal() principal: Principal, @Query('account') account?: string) {
    return this.schedules.list(principal, account);
  }

  @Post('schedules')
  @RequirePermission('reports:manage')
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateScheduleDto) {
    return this.schedules.create(principal, ctx, dto);
  }

  @Patch('schedules/:id')
  @RequirePermission('reports:manage')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchScheduleDto,
  ) {
    return this.schedules.patch(principal, ctx, id, dto);
  }

  @Post('schedules/:id/run-now')
  @RequirePermission('reports:manage')
  runNow(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RunNowDto,
  ) {
    return this.schedules.runNow(principal, ctx, id, dto);
  }

  @Get('runs')
  @RequirePermission('reports:manage')
  runs(
    @CurrentPrincipal() principal: Principal,
    @Query('account') account?: string,
    @Query('status') status?: string,
    @Query('schedule') schedule?: string,
  ) {
    return this.schedules.runs(principal, { accountId: account, status, scheduleId: schedule });
  }
}

@Module({
  imports: [ReportingCoreModule, CalendarsCoreModule, EmailCoreModule, TicketsCoreModule, StorageCoreModule],
  providers: [SchedulesRepository, SchedulesService],
  exports: [SchedulesService],
})
export class ReportSchedulesCoreModule {}

@Module({
  imports: [ReportSchedulesCoreModule],
  controllers: [SchedulesController],
  exports: [ReportSchedulesCoreModule],
})
export class ReportSchedulesModule {}
