import {
  BadRequestException,
  Body,
  ConflictException,
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
import type { AuditEventType } from '../../contracts/events.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Principal } from '../../common/auth/principal.js';
import type { MailTransport } from '../../common/mail/mail-transport.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import { MAIL_TRANSPORT, OBJECT_STORE, StorageCoreModule } from '../../common/storage/storage.module.js';
import { DbPools } from '../../db/pool.js';
import { RepositoryBase, type Tx, quoteIdent } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import {
  narrativeText,
  packNarrative,
  WSR_NARRATIVE_KEYS,
  type NarrativeSection,
  type WsrNarrativeKey,
} from '../../domain/reporting/pdf.js';
import { nextRunAt, periodBefore, type Cadence, type PeriodKind } from '../../domain/reporting/schedule.js';
import type { Job } from '../../worker/jobs.js';
import { CalendarsCoreModule, CalendarService } from '../calendars/calendars.module.js';
import { EmailCoreModule } from '../email/email.module.js';
import { EmailRepository } from '../email/email.repository.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { ReportingCoreModule } from './reporting.module.js';
import { PDF_CONTENT_TYPE, PPTX_CONTENT_TYPE, ReportingService } from './reporting.service.js';

/**
 * Report schedules and distribution (Dashboards & Report Packs functional
 * 5.7, technical 2.3 and 3; DR-05): administrators keep one or more
 * schedules per account; the worker claims the due ones behind its lease,
 * builds the pack through the shared builder, and delivers it: a
 * notification with the download for internal recipients, an email with
 * the link from the account's sender identity for portal users and
 * contacts. The per-recipient outcome lives on the run.
 *
 * A schedule with `review_required` (functional 5.8) does not deliver when
 * it renders: the run is held at `ready_for_review` with the deadline its
 * grace period gives it, and the reviewers are notified. Approve delivers
 * the run exactly as it would have gone; cancel records the reason and
 * stops it. Nothing delivers on the deadline: the sweep moves an unreviewed
 * run to `awaiting_review`, reminds the reviewers and leaves it approvable,
 * because unreviewed narrative never reaches a client.
 */

/**
 * Presigned delivery and review links live as long as the delivery email
 * says they do: fourteen days (Dashboards & Report Packs functional 5.7).
 * The number is written once, and the email copy words it from the same
 * constant, so a link cannot outlive or undercut what the client was told.
 */
const DELIVERY_LINK_DAYS = 14;
const LINK_SECONDS = DELIVERY_LINK_DAYS * 24 * 3600;

/** Recipient ids are user uuids; a distribution row may carry an address instead. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** A run of a schedule, as the review routes and the deadline sweep read it. */
export interface RunRow {
  id: string;
  account_id: string;
  schedule_id: string | null;
  pack_type: string;
  period_start: string;
  period_end: string;
  status: string;
  pack_id: string | null;
  reviewer_id: string | null;
  reviewed_at: string | null;
  review_due_at: string | null;
  review_note: string | null;
  delivery: DeliveryOutcome[] | null;
  requested_by: string;
  created_at: string;
}

/** The stored pack behind a run: the frozen numbers and the two rendition keys. */
export interface PackRow {
  id: string;
  period_start: string;
  period_end: string;
  measures: unknown;
  notable: unknown;
  narrative_source: string;
  narrative_versions: unknown[];
  pptx_key: string | null;
  pdf_key: string | null;
}

/**
 * One entry of `acct.report_packs.narrative_versions`, which is append
 * only: version one is the templated narrative, and every reviewer edit is
 * one more entry naming who wrote it. `rendered` says whether the two
 * stored renditions were built from this entry, which is what lets
 * "Approve and send" ship an edit the reviewer never regenerated.
 */
export interface NarrativeVersion {
  version: number;
  text: string;
  sections: NarrativeSection[];
  author_kind: string;
  author_id: string;
  at: string;
  rendered: boolean;
}

/**
 * Where the words in a pack came from, as the review screen says it
 * (functional 5.8; AI functionality 117). The stored vocabulary is the
 * column's: `template`, `axel` and `edited`. `axel` cannot occur yet, the
 * `wsr_narrative` capability having no builder, so a pack is templated
 * until somebody rewrites it.
 */
export type NarrativeSourceView = 'templated' | 'ai' | 'edited';

export function narrativeSourceView(stored: string | null | undefined): NarrativeSourceView {
  return stored === 'edited' ? 'edited' : stored === 'axel' ? 'ai' : 'templated';
}

/** The versions of a pack's narrative, oldest first, from whatever the column holds. */
export function narrativeVersions(pack: Pick<PackRow, 'narrative_versions'>): NarrativeVersion[] {
  return (Array.isArray(pack.narrative_versions) ? pack.narrative_versions : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry, index) => ({
      version: typeof entry.version === 'number' ? entry.version : index + 1,
      text: typeof entry.text === 'string' ? entry.text : '',
      sections: packNarrative(entry.sections ? { sections: entry.sections } : entry.text).sections.map((section) => ({
        ...section,
      })),
      author_kind: typeof entry.author_kind === 'string' ? entry.author_kind : 'template',
      author_id: typeof entry.author_id === 'string' ? entry.author_id : 'template',
      at: typeof entry.at === 'string' ? entry.at : new Date(0).toISOString(),
      // A pack written before the editor existed has no flag and was
      // rendered from the only narrative it has ever had.
      rendered: entry.rendered !== false,
    }));
}

/** The narrative a pack currently stands on: its newest version. */
export function currentNarrative(pack: Pick<PackRow, 'narrative_versions'>): NarrativeVersion | undefined {
  const versions = narrativeVersions(pack);
  return versions[versions.length - 1];
}

/** Presigned links to the two renditions of a pack. */
export interface PackLinks {
  pptx: string | null;
  pdf: string | null;
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

  run(tx: Tx, id: string): Promise<RunRow> {
    return this.one<RunRow>(tx, 'report_run', 'select * from acct.report_runs where id = $1', [id]);
  }

  packOfRun(tx: Tx, runId: string): Promise<PackRow | undefined> {
    return this.maybeOne<PackRow>(
      tx,
      `select id, period_start, period_end, measures, notable, narrative_source, narrative_versions, pptx_key, pdf_key
         from acct.report_packs where run_id = $1`,
      [runId],
    );
  }

  /**
   * The narrative history of a pack, written whole. The column is an
   * append-only array in practice (an edit adds an entry, a re-render
   * stamps the newest one rendered), and rewriting it in one statement
   * keeps the version numbers and the rendered flags consistent with each
   * other rather than patching jsonb in place.
   */
  async setNarrativeVersions(
    tx: Tx,
    packId: string,
    versions: readonly NarrativeVersion[],
    source?: string,
  ): Promise<void> {
    await tx.query(
      `update acct.report_packs
          set narrative_versions = $2::jsonb, narrative_source = coalesce($3, narrative_source)
        where id = $1`,
      [packId, JSON.stringify(versions), source ?? null],
    );
  }

  /** The keys of the two renditions after a re-render; the same keys in practice, rewritten in place. */
  async setPackRenditions(tx: Tx, packId: string, pptxKey: string, pdfKey: string): Promise<void> {
    await tx.query('update acct.report_packs set pptx_key = $2, pdf_key = $3 where id = $1', [packId, pptxKey, pdfKey]);
  }

  /**
   * Whether Axel is on for this account (`acct.ai_settings.enabled`; an
   * account with no row is off), so the review screen can say why the
   * narrative in front of the reviewer is the templated one.
   */
  async aiEnabled(tx: Tx, accountId: string): Promise<boolean> {
    const row = await this.maybeOne<{ enabled: boolean }>(
      tx,
      'select enabled from acct.ai_settings where account_id = $1',
      [accountId],
    );
    return row?.enabled ?? false;
  }

  accountKey(tx: Tx, accountId: string): Promise<{ key: string; name: string }> {
    return this.one(tx, 'account', 'select key, name from op.accounts where id = $1', [accountId]);
  }

  /** Holds a rendered run for a reviewer, with the deadline its grace period gives it. */
  async holdForReview(tx: Tx, runId: string, dueAt: Date): Promise<void> {
    await tx.query(`update acct.report_runs set status = 'ready_for_review', review_due_at = $2 where id = $1`, [
      runId,
      dueAt,
    ]);
  }

  /** The reviewer's decision on the run; delivery follows and writes the outcome. */
  async markApproved(tx: Tx, runId: string, reviewerId: string): Promise<void> {
    await tx.query(
      `update acct.report_runs set status = 'approved', reviewer_id = $2, reviewed_at = now(), review_due_at = null where id = $1`,
      [runId, reviewerId],
    );
  }

  /** A cancelled run takes the closed vocabulary's `skipped`, with the reason on the row. */
  async markCancelled(tx: Tx, runId: string, reviewerId: string, reason: string): Promise<void> {
    await tx.query(
      `update acct.report_runs set status = 'skipped', reviewer_id = $2, reviewed_at = now(), review_due_at = null, review_note = $3 where id = $1`,
      [runId, reviewerId, reason],
    );
  }

  /** The deadline passed with nobody reviewing: the run waits, it never sends itself. */
  async markAwaitingReview(tx: Tx, runId: string): Promise<void> {
    await tx.query(`update acct.report_runs set status = 'awaiting_review' where id = $1`, [runId]);
  }

  /** Held runs past their grace period; SKIP LOCKED so two workers never expire the same one. */
  claimReviewDue(tx: Tx, now: Date, batch: number): Promise<RunRow[]> {
    return this.many<RunRow>(
      tx,
      `select * from acct.report_runs
        where status = 'ready_for_review' and review_due_at is not null and review_due_at <= $1
        order by review_due_at limit $2 for update skip locked`,
      [now, batch],
    );
  }

  /**
   * Internal users who may review this account's packs: an active role
   * carrying `reports:manage`, granted on the account, plus administrators
   * (bound to every account by definition). The same shape as the budget
   * recipients sweep in Time & Budget.
   */
  reviewRecipients(tx: Tx, accountId: string): Promise<string[]> {
    return this.many<{ id: string }>(
      tx,
      `select distinct u.id from op.users u
         join op.role_assignments ra on ra.user_id = u.id and (ra.account_id is null or ra.account_id = $1)
         join op.roles r on r.id = ra.role_id
        where u.kind = 'internal' and u.status = 'active' and r.status = 'active'
          and 'reports:manage' = any (r.permissions)
          and (exists (select 1 from op.account_grants g where g.user_id = u.id and g.account_id = $1)
               or (ra.account_id is null and 'admin:accounts' = any (r.permissions)))`,
      [accountId],
    ).then((rows) => rows.map((row) => row.id));
  }

  runs(
    tx: Tx,
    filter: { accountId?: string; status?: string; scheduleId?: string },
  ): Promise<Record<string, unknown>[]> {
    return this.many(
      tx,
      `select r.*, p.pptx_key, p.pdf_key from acct.report_runs r left join acct.report_packs p on p.run_id = r.id
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
  @IsOptional() @IsBoolean() review_required?: boolean;
  /** The grace period a held run gets, one hour to one week; the spec's default is 24. */
  @IsOptional() @IsInt() @Min(1) @Max(168) review_grace_hours?: number;
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

/**
 * The reason a run was cancelled is the only record of why nothing shipped
 * that period, so it is required. It is optional to the validator on
 * purpose: a missing, empty or blank reason is one refusal in one shape,
 * `400 { code: 'reason_required' }` from the service, rather than the
 * validator's generic message for one of the three and silence for the
 * other two.
 */
export class CancelRunDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class RunNowDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) period_start?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) period_end?: string;
}

/** One section of the narrative panel on the review screen (functional 5.8). */
export class NarrativeSectionDto {
  @IsIn([...WSR_NARRATIVE_KEYS]) key!: WsrNarrativeKey;
  @IsString() @MaxLength(6000) text!: string;
}

/**
 * The narrative a reviewer wrote, section by section. Only the prose is
 * editable: the measures and the notable rows are frozen on the pack when
 * it renders, and a review that could move a number would not be a review.
 * A section left out says nothing about that part of the pack, which is
 * how the panel clears one.
 */
export class PatchNarrativeDto {
  @IsArray()
  @ArrayMaxSize(WSR_NARRATIVE_KEYS.length)
  @ValidateNested({ each: true })
  @Type(() => NarrativeSectionDto)
  sections!: NarrativeSectionDto[];
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
    private readonly outbox: OutboxService,
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
        review_required: dto.review_required ?? false,
        review_grace_hours: dto.review_grace_hours ?? 24,
        enabled: dto.enabled ?? true,
        next_run_at: (dto.enabled ?? true) ? nextRunAt(spec, new Date(), timeZone) : null,
      });
      await this.audit.account(tx, dto.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'report_schedule',
          entityId: row.id,
          eventType: 'created',
          newValue: {
            name: row.name,
            cadence: row.cadence,
            run_day: row.run_day,
            review_required: row.review_required,
            next_run_at: row.next_run_at,
          },
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
        review_required: dto.review_required ?? before.review_required,
        review_grace_hours: dto.review_grace_hours ?? before.review_grace_hours,
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
          oldValue: {
            cadence: before.cadence,
            run_day: before.run_day,
            review_required: before.review_required,
            enabled: before.enabled,
          },
          newValue: {
            cadence: after.cadence,
            run_day: after.run_day,
            review_required: after.review_required,
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
    const links = await this.links(built);
    const advance = () =>
      this.repo.advance(
        tx,
        schedule.id,
        schedule.next_run_at ? new Date(schedule.next_run_at) : new Date(),
        built.run_id,
      );
    if (schedule.review_required) {
      const held = await this.hold(tx, schedule, built, period, actor, ctx);
      await advance();
      return held;
    }
    const delivery = await this.deliver(tx, schedule, built, links, period);
    const failed = delivery.length > 0 && delivery.every((row) => row.outcome === 'skipped');
    await this.repo.setDelivery(tx, built.run_id, delivery, failed ? 'failed' : 'sent');
    await advance();
    return {
      run_id: built.run_id,
      pack_id: built.pack_id,
      period,
      delivery,
      status: failed ? 'failed' : 'sent',
      review_due_at: null,
    };
  }

  /** Presigned links to both renditions, valid for the life of the delivery email. */
  private async links(built: { pptx_key: string; pdf_key: string; file_name: string; pdf_file_name: string }) {
    return {
      pptx: await this.store.presignDownload(built.pptx_key, {
        fileName: built.file_name,
        contentType: PPTX_CONTENT_TYPE,
        expiresSeconds: LINK_SECONDS,
      }),
      pdf: await this.store.presignDownload(built.pdf_key, {
        fileName: built.pdf_file_name,
        contentType: PDF_CONTENT_TYPE,
        expiresSeconds: LINK_SECONDS,
      }),
    };
  }

  /**
   * Holds a rendered run for its reviewers (functional 5.8). The deadline
   * is frozen on the run, so changing the schedule's grace hours never
   * moves a deadline a reviewer was already told about.
   */
  private async hold(
    tx: Tx,
    schedule: ScheduleRow,
    built: { run_id: string; pack_id: string; file_name: string },
    period: { start: string; end: string },
    actor: AuditActor,
    ctx: Parameters<AuditService['account']>[3],
  ) {
    const dueAt = new Date(Date.now() + schedule.review_grace_hours * 3_600_000);
    await this.repo.holdForReview(tx, built.run_id, dueAt);
    const reviewers = await this.notifyReviewers(tx, schedule.account_id, built.run_id, {
      type: 'report.review.requested',
      collapse: 'report-review',
      title: `${schedule.name}: report pack for ${period.start} to ${period.end} is ready for review`,
      body: `Approve or cancel it before ${dueAt.toISOString()}.`,
    });
    await this.transition(tx, schedule.account_id, built.run_id, 'report.run.held_for_review', actor, ctx, {
      schedule_id: schedule.id,
      pack_id: built.pack_id,
      period: [period.start, period.end],
      review_due_at: dueAt.toISOString(),
      reviewers: reviewers.length,
    });
    return {
      run_id: built.run_id,
      pack_id: built.pack_id,
      period,
      delivery: [] as DeliveryOutcome[],
      status: 'ready_for_review',
      review_due_at: dueAt.toISOString(),
    };
  }

  /** One notification per reviewer, collapsed per run so a reminder never doubles the feed. */
  private async notifyReviewers(
    tx: Tx,
    accountId: string,
    runId: string,
    note: { type: string; title: string; body: string; collapse: string },
    extra: readonly string[] = [],
  ): Promise<string[]> {
    const holders = await this.repo.reviewRecipients(tx, accountId);
    const recipients = [...new Set([...holders, ...extra.filter((id) => UUID.test(id))])];
    for (const recipientId of recipients)
      await this.notifications.upsert(tx, {
        accountId,
        recipientId,
        type: note.type,
        title: note.title,
        body: note.body,
        targetKind: 'report_run',
        targetId: runId,
        link: `/reports/runs/${runId}`,
        collapseKey: `${note.collapse}:${runId}`,
      });
    return recipients;
  }

  /** One audit row and one outbox row for every move a held run makes. */
  private async transition(
    tx: Tx,
    accountId: string,
    runId: string,
    eventType: AuditEventType,
    actor: AuditActor,
    ctx: Parameters<AuditService['account']>[3],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.account(tx, accountId, actor, ctx, [
      { entityKind: 'report_run', entityId: runId, eventType, newValue: payload },
    ]);
    await this.outbox.write(tx, {
      accountId,
      aggregate: 'report_run',
      aggregateId: runId,
      eventType,
      correlationId: ctx.correlationId ?? randomUUID(),
      origin: actor.kind === 'system' ? 'system' : 'user',
      payload,
    });
  }

  // Review before send (functional 5.8) ----------------------------------------

  /**
   * A held run with its frozen pack, a link to each rendition and the
   * narrative the review screen edits (functional 5.8). `narrative_source`
   * says whose words these are, and `ai_enabled` says whether Axel was
   * available to write them, so the screen can tell the reviewer that the
   * templated narrative is in front of them because AI is off for this
   * account rather than leaving them to guess. `narrative_rendered` is
   * false while an edit is waiting to be regenerated.
   */
  runDetail(principal: Principal, id: string) {
    return this.uow.run(principal, async (tx) => {
      const run = await this.repo.run(tx, id);
      const pack = await this.repo.packOfRun(tx, run.id);
      const current = pack ? currentNarrative(pack) : undefined;
      return {
        ...run,
        pack: pack ?? null,
        files: await this.packLinks(tx, run, pack),
        narrative: current ? { sections: current.sections } : null,
        narrative_source: pack ? narrativeSourceView(pack.narrative_source) : null,
        narrative_version: current?.version ?? null,
        narrative_rendered: current?.rendered ?? null,
        ai_enabled: await this.repo.aiEnabled(tx, run.account_id),
      };
    });
  }

  /**
   * The narrative a reviewer wrote, on a run that is still held
   * (functional 5.8: the editable panel). It lands as one more version on
   * the frozen pack, naming the editor, and the pack's source becomes
   * `edited`; the numbers are untouched, because they are the thing the
   * review is about. The renditions are not rebuilt here: the screen's
   * "Regenerate with my edits" does that, and "Approve and send" does it
   * for a reviewer who never asked, so an edit can never be lost between
   * the panel and the client.
   */
  editNarrative(principal: Principal, ctx: RequestContext, id: string, dto: PatchNarrativeDto) {
    const keys = dto.sections.map((section) => section.key);
    if (new Set(keys).size !== keys.length) throw new BadRequestException({ code: 'duplicate_section' });
    return this.uow.run(principal, async (tx) => {
      const { run, pack } = await this.heldRun(tx, id);
      const versions = narrativeVersions(pack);
      const sections: NarrativeSection[] = dto.sections
        .filter((section) => section.text.trim().length > 0)
        .map((section) => ({ key: section.key, text: section.text }));
      const next: NarrativeVersion = {
        version: (versions[versions.length - 1]?.version ?? 0) + 1,
        text: narrativeText({ sections }),
        sections,
        author_kind: 'user',
        author_id: principal.userId,
        at: new Date().toISOString(),
        rendered: false,
      };
      await this.repo.setNarrativeVersions(tx, pack.id, [...versions, next], 'edited');
      await this.transition(tx, run.account_id, run.id, 'report.run.narrative_edited', actorOf(principal), ctx, {
        pack_id: pack.id,
        version: next.version,
        editor: principal.userId,
        sections: sections.map((section) => section.key),
        characters: next.text.length,
      });
      return {
        run_id: run.id,
        pack_id: pack.id,
        status: run.status,
        narrative: { sections },
        narrative_source: 'edited' as NarrativeSourceView,
        narrative_version: next.version,
        narrative_rendered: false,
      };
    });
  }

  /**
   * "Regenerate with my edits" (functional 5.8): both renditions again
   * from the measures already frozen on the pack and the narrative it now
   * carries. The run does not move; its status, its deadline and its
   * reviewer are what they were, and only the two files and the links to
   * them are new. The links are minted fresh because the old ones were
   * signed against the objects as they were.
   */
  regenerate(principal: Principal, ctx: RequestContext, id: string) {
    return this.uow.run(principal, async (tx) => {
      const { run, pack, period } = await this.heldRun(tx, id);
      const { links, version } = await this.rerender(tx, run, pack);
      await this.transition(tx, run.account_id, run.id, 'report.run.regenerated', actorOf(principal), ctx, {
        pack_id: pack.id,
        period: [period.start, period.end],
        version,
        status: run.status,
      });
      return {
        run_id: run.id,
        pack_id: pack.id,
        status: run.status,
        period,
        files: links,
        narrative_source: narrativeSourceView(pack.narrative_source),
        narrative_version: version,
        narrative_rendered: true,
      };
    });
  }

  /**
   * Rebuilds both renditions of a pack from its own frozen numbers and its
   * newest narrative, stamps that version rendered and hands back fresh
   * links. Nothing is recomputed from the fact tables: a figure the
   * reviewer has already read must not move under them.
   */
  private async rerender(tx: Tx, run: RunRow, pack: PackRow): Promise<{ links: PackLinks; version: number }> {
    const versions = narrativeVersions(pack);
    const current = versions[versions.length - 1];
    const keys = await this.reporting.rerenderPack(tx, {
      accountId: run.account_id,
      runId: run.id,
      periodStart: pack.period_start,
      periodEnd: pack.period_end,
      measures: pack.measures,
      notable: pack.notable,
      narrative: packNarrative({ sections: current?.sections ?? [] }),
    });
    await this.repo.setPackRenditions(tx, pack.id, keys.pptxKey, keys.pdfKey);
    await this.repo.setNarrativeVersions(
      tx,
      pack.id,
      versions.map((entry, index) => (index === versions.length - 1 ? { ...entry, rendered: true } : entry)),
    );
    const links = await this.packLinks(tx, run, { ...pack, pptx_key: keys.pptxKey, pdf_key: keys.pdfKey });
    return { links, version: current?.version ?? 1 };
  }

  /**
   * Approve and send: the run is delivered exactly as an unheld run would
   * have been, from the pack that was rendered when it was held, so the
   * deck the reviewer read is the deck the client receives. A run past its
   * deadline (`awaiting_review`) is still approvable; nothing else is.
   *
   * Where the narrative was edited and never regenerated, the renditions
   * are rebuilt first (functional 5.8 offers "Approve and send" beside
   * "Regenerate with my edits", and the edit is what the reviewer means to
   * send either way). "Send without changes" is the same route on a pack
   * nobody edited, and rebuilds nothing.
   */
  approve(principal: Principal, ctx: RequestContext, id: string) {
    return this.uow.run(principal, async (tx) => {
      const { run, schedule, pack, period } = await this.heldRun(tx, id);
      // Review before send is a second reader, not a pause (functional 5.8,
      // DR-05). The person who asked for the run is the person whose
      // narrative is under review, so a second `reports:manage` holder
      // approves it, exactly as the out-of-scope flagger cannot decide
      // their own flag.
      if (run.requested_by === principal.userId)
        throw new ConflictException({ code: 'requester_cannot_approve', requested_by: run.requested_by });
      await this.repo.markApproved(tx, run.id, principal.userId);
      const stale = currentNarrative(pack)?.rendered === false;
      const links = stale ? (await this.rerender(tx, run, pack)).links : await this.packLinks(tx, run, pack);
      const account = await this.repo.accountKey(tx, run.account_id);
      const delivery = await this.deliver(
        tx,
        schedule,
        { run_id: run.id, pack_id: pack.id, file_name: `${account.key}-WSR-${period.start}.pptx` },
        links,
        period,
      );
      const failed = delivery.length > 0 && delivery.every((row) => row.outcome === 'skipped');
      await this.repo.setDelivery(tx, run.id, delivery, failed ? 'failed' : 'sent');
      await this.transition(tx, run.account_id, run.id, 'report.run.approved', actorOf(principal), ctx, {
        schedule_id: schedule.id,
        pack_id: pack.id,
        period: [period.start, period.end],
        was: run.status,
        delivered: delivery.filter((row) => row.outcome !== 'skipped').length,
        narrative_source: narrativeSourceView(pack.narrative_source),
        rerendered: stale,
        // Requester and reviewer are recorded apart, so the audit stream
        // shows two people rather than one completed review.
        requested_by: run.requested_by,
        reviewed_by: principal.userId,
      });
      return {
        run_id: run.id,
        pack_id: pack.id,
        period,
        delivery,
        status: failed ? 'failed' : 'sent',
        review_due_at: null,
      };
    });
  }

  /**
   * Cancel with a reason: nothing is delivered and the reason stays on the
   * run. A reason of spaces is no reason, so it is refused in the same
   * shape as a missing one, and what is stored is the trimmed text.
   */
  cancel(principal: Principal, ctx: RequestContext, id: string, dto: CancelRunDto) {
    const reason = (dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException({ code: 'reason_required' });
    return this.uow.run(principal, async (tx) => {
      const { run, schedule, pack, period } = await this.heldRun(tx, id);
      await this.repo.markCancelled(tx, run.id, principal.userId, reason);
      await this.transition(tx, run.account_id, run.id, 'report.run.cancelled', actorOf(principal), ctx, {
        schedule_id: schedule.id,
        pack_id: pack.id,
        period: [period.start, period.end],
        was: run.status,
        reason,
      });
      return { run_id: run.id, status: 'skipped', reason };
    });
  }

  /** The run, its schedule and its pack, refusing anything that is not held for a reviewer. */
  private async heldRun(tx: Tx, id: string) {
    const run = await this.repo.run(tx, id);
    if (run.status !== 'ready_for_review' && run.status !== 'awaiting_review')
      throw new ConflictException({ code: 'not_under_review', status: run.status });
    if (!run.schedule_id) throw new ConflictException({ code: 'run_without_schedule' });
    const schedule = await this.repo.byId(tx, run.schedule_id);
    const pack = await this.repo.packOfRun(tx, run.id);
    if (!pack) throw new ConflictException({ code: 'run_without_pack' });
    return { run, schedule, pack, period: { start: pack.period_start, end: pack.period_end } };
  }

  /** Presigned links to the stored renditions of a run's pack. */
  private async packLinks(tx: Tx, run: RunRow, pack: PackRow | undefined): Promise<PackLinks> {
    if (!pack) return { pptx: null, pdf: null };
    const account = await this.repo.accountKey(tx, run.account_id);
    const stem = `${account.key}-WSR-${pack.period_start}`;
    return {
      pptx: pack.pptx_key
        ? await this.store.presignDownload(pack.pptx_key, {
            fileName: `${stem}.pptx`,
            contentType: PPTX_CONTENT_TYPE,
            expiresSeconds: LINK_SECONDS,
          })
        : null,
      pdf: pack.pdf_key
        ? await this.store.presignDownload(pack.pdf_key, {
            fileName: `${stem}.pdf`,
            contentType: PDF_CONTENT_TYPE,
            expiresSeconds: LINK_SECONDS,
          })
        : null,
    };
  }

  private async deliver(
    tx: Tx,
    schedule: ScheduleRow,
    built: { run_id: string; pack_id: string; file_name: string },
    links: PackLinks,
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
          text: [
            `Your report pack for ${period.start} to ${period.end} is ready.`,
            '',
            ...(links.pdf ? [`PDF (valid ${DELIVERY_LINK_DAYS} days): ${links.pdf}`] : []),
            ...(links.pptx ? [`Slides (valid ${DELIVERY_LINK_DAYS} days): ${links.pptx}`] : []),
            '',
          ].join('\n'),
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

  reviewDeadlineJob(intervalMs = 10 * 60_000): Job {
    return { name: 'report.review.deadline', intervalMs, run: () => this.expireReviews() };
  }

  /**
   * The grace period (functional 5.8): a held run nobody reviewed moves to
   * `awaiting_review` and its reviewers are reminded. It is deliberately not
   * delivered. Unreviewed narrative never reaches a client, so the deadline
   * expires the hold rather than releasing it, and the run stays approvable
   * for as long as somebody wants to send it.
   */
  async expireReviews(now = new Date(), batch = 50): Promise<string> {
    const accounts = (
      await this.pools
        .get('worker')
        .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding', 'offboarding')`)
    ).rows.map((row) => row.id);
    if (accounts.length === 0) return 'expired 0';
    let expired = 0;
    await this.uow.perAccount(accounts, async (tx) => {
      for (const run of await this.repo.claimReviewDue(tx, now, batch)) {
        await this.repo.markAwaitingReview(tx, run.id);
        await this.notifyReviewers(
          tx,
          run.account_id,
          run.id,
          {
            type: 'report.review.overdue',
            collapse: 'report-review-overdue',
            title: `Report pack for ${run.period_start} to ${run.period_end} is still awaiting review`,
            body: 'The grace period passed; nothing was sent. Approve or cancel it.',
          },
          [run.requested_by],
        );
        await this.transition(
          tx,
          run.account_id,
          run.id,
          'report.run.review_expired',
          SYSTEM_ACTOR,
          { correlationId: `report-review:${run.id}` },
          {
            schedule_id: run.schedule_id,
            pack_id: run.pack_id,
            period: [run.period_start, run.period_end],
            review_due_at: run.review_due_at,
            delivered: false,
          },
        );
        expired += 1;
      }
    });
    return `expired ${expired}`;
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

  @Get('runs/:id')
  @RequirePermission('reports:manage')
  run(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.runDetail(principal, id);
  }

  @Patch('runs/:id/narrative')
  @RequirePermission('reports:manage')
  editNarrative(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchNarrativeDto,
  ) {
    return this.schedules.editNarrative(principal, ctx, id, dto);
  }

  @Post('runs/:id/regenerate')
  @RequirePermission('reports:manage')
  regenerate(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.schedules.regenerate(principal, ctx, id);
  }

  @Post('runs/:id/approve')
  @RequirePermission('reports:manage')
  approve(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.schedules.approve(principal, ctx, id);
  }

  @Post('runs/:id/cancel')
  @RequirePermission('reports:manage')
  cancelRun(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelRunDto,
  ) {
    return this.schedules.cancel(principal, ctx, id, dto);
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
