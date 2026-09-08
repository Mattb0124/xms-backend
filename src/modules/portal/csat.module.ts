import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { randomUUID } from 'node:crypto';
import {
  Authenticated,
  CurrentPrincipal,
  RealmOf,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../common/auth/decorators.js';
import { Public } from '../../common/auth/public.decorator.js';
import { actorOf, AuditService, SYSTEM_ACTOR } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import type { MailTransport } from '../../common/mail/mail-transport.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import { MAIL_TRANSPORT, StorageCoreModule } from '../../common/storage/storage.module.js';
import { loadEnv } from '../../config/env.js';
import { DbPools } from '../../db/pool.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import {
  firstBusinessDayAfter,
  isLowScore,
  isWeekday,
  newToken,
  nextRemindAt,
  QUARTERLY_KEYS,
  quarterEndedBefore,
  questionsFor,
  summarise,
  summariseQuarterly,
  suppressionReason,
  surveyTimings,
  tokenMatches,
  type SurveyKind,
} from '../../domain/portal/csat.js';
import type { Job } from '../../worker/jobs.js';
import type { OutboxRow } from '../../worker/outbox-dispatcher.js';
import { WALL_CLOCK, type Calendar } from '../../domain/sla/engine.js';
import { AccountsRepository } from '../admin/accounts/accounts.repository.js';
import { CalendarService, CalendarsCoreModule } from '../calendars/calendars.module.js';
import { EmailCoreModule } from '../email/email.module.js';
import { EmailRepository } from '../email/email.repository.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TicketsRepository, ticketKey } from '../tickets/tickets.repository.js';
import { TimeRepository } from '../time/time.repository.js';

/**
 * CSAT (Client Portal functional 5.7, technical 2.3 and 3; CP-07). Two
 * surveys share one table, one token scheme and one reminder tick:
 *
 * - **On ticket close.** The worker creates one survey for the requester
 *   unless suppressed, mails a one-time link, reminds once after three
 *   days, expires it after ten, and a low score tells the account's
 *   contract managers.
 * - **Quarterly relationship.** On or after the first business day
 *   following a quarter end, one survey per period and recipient for the
 *   account's portal admins and the contacts flagged executive sponsor:
 *   five keyed questions plus a comment, two reminders over three weeks,
 *   then expiry.
 *
 * The recipient answers from the portal or from the link without a
 * session; the operator reads both kinds per account.
 */

export interface SurveyRow {
  id: string;
  account_id: string;
  kind: 'ticket_close' | 'quarterly';
  ticket_id: string | null;
  period: string | null;
  contact_id: string;
  token_hash: string;
  status: 'sent' | 'reminded' | 'answered' | 'expired' | 'suppressed';
  sent_at: string;
  remind_at: string | null;
  expires_at: string | null;
  answered_at: string | null;
  suppression_reason: string | null;
  created_at: string;
}

export interface ResponseRow {
  id: string;
  account_id: string;
  survey_id: string;
  /** `{ score }` on ticket close; the five keyed scores for a quarterly survey. */
  answers: Record<string, number>;
  comment: string | null;
  anonymous: boolean;
  created_at: string;
}

/** The contact columns the survey needs to address someone. */
export interface ContactLike {
  id: string;
  email: string;
  display_name: string;
}

/** A person the quarterly survey goes to, and the contact row it is recorded against. */
export interface QuarterlyRecipient {
  readonly contact_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly source: 'account_admin' | 'executive_sponsor';
}

// Repository -------------------------------------------------------------------

@Injectable()
export class CsatRepository extends RepositoryBase {
  survey(tx: Tx, id: string): Promise<SurveyRow> {
    return this.one(tx, 'survey', 'select * from acct.csat_surveys where id = $1', [id]);
  }

  surveyForTicket(tx: Tx, ticketId: string, contactId: string): Promise<SurveyRow | undefined> {
    return this.maybeOne(
      tx,
      `select * from acct.csat_surveys where kind = 'ticket_close' and ticket_id = $1 and contact_id = $2`,
      [ticketId, contactId],
    );
  }

  /** Whether the contact already received a survey today (the daily cap). */
  async surveyedToday(tx: Tx, contactId: string): Promise<boolean> {
    const result = await tx.query(
      `select 1 from acct.csat_surveys where contact_id = $1 and status <> 'suppressed' and sent_at::date = current_date limit 1`,
      [contactId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Whether this recipient already holds the survey for that quarter (the once-per-period rule). */
  surveyForPeriod(tx: Tx, period: string, contactId: string): Promise<SurveyRow | undefined> {
    return this.maybeOne(
      tx,
      `select * from acct.csat_surveys where kind = 'quarterly' and period = $1 and contact_id = $2`,
      [period, contactId],
    );
  }

  insertSurvey(
    tx: Tx,
    input: {
      accountId: string;
      kind: SurveyKind;
      ticketId: string | null;
      period: string | null;
      contactId: string;
      tokenHash: string;
      status: 'sent' | 'suppressed';
      remindAt: Date | null;
      expiresAt: Date | null;
      suppressionReason: string | null;
    },
  ): Promise<SurveyRow> {
    return this.one(
      tx,
      'survey',
      `insert into acct.csat_surveys (account_id, kind, ticket_id, period, contact_id, token_hash, status, remind_at, expires_at, suppression_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [
        input.accountId,
        input.kind,
        input.ticketId,
        input.period,
        input.contactId,
        input.tokenHash,
        input.status,
        input.remindAt,
        input.expiresAt,
        input.suppressionReason,
      ],
    );
  }

  async setStatus(tx: Tx, id: string, status: SurveyRow['status'], answeredAt?: Date): Promise<void> {
    await tx.query('update acct.csat_surveys set status = $2, answered_at = coalesce($3, answered_at) where id = $1', [
      id,
      status,
      answeredAt ?? null,
    ]);
  }

  /**
   * Records a reminder and stamps when the next one is due, or clears it
   * when the cadence is spent. The row carries the schedule, so a second
   * reminder needs no counter in the worker.
   */
  async setReminded(tx: Tx, id: string, nextAt: Date | null): Promise<void> {
    await tx.query(`update acct.csat_surveys set status = 'reminded', remind_at = $2 where id = $1`, [id, nextAt]);
  }

  insertResponse(
    tx: Tx,
    input: {
      accountId: string;
      surveyId: string;
      answers: Record<string, number>;
      comment: string | null;
      anonymous: boolean;
    },
  ): Promise<ResponseRow> {
    return this.one(
      tx,
      'response',
      `insert into acct.csat_responses (account_id, survey_id, answers, comment, anonymous)
       values ($1, $2, $3, $4, $5) returning *`,
      [input.accountId, input.surveyId, JSON.stringify(input.answers), input.comment, input.anonymous],
    );
  }

  /**
   * Who the quarterly survey goes to (functional 5.7): the account's portal
   * users holding the account-admin role, named by the permission that role
   * carries rather than by its label, plus every contact flagged executive
   * sponsor. An admin with no contact row yet is created one by the caller,
   * so this asks only for the people.
   */
  accountAdmins(
    tx: Tx,
    accountId: string,
  ): Promise<{ id: string; email: string; first_name: string; last_name: string }[]> {
    return this.many(
      tx,
      `select distinct u.id, u.email::text as email, u.first_name, u.last_name
         from op.users u
         join op.role_assignments ra on ra.user_id = u.id
         join op.roles r on r.id = ra.role_id and r.catalog = 'portal' and r.status = 'active'
        where u.kind = 'portal' and u.status <> 'deactivated' and u.account_id = $1
          and 'portal:manage-users' = any (r.permissions)
        order by email`,
      [accountId],
    );
  }

  flaggedContacts(tx: Tx, accountId: string, flag: string): Promise<ContactLike[]> {
    return this.many(
      tx,
      `select id, email::text as email, display_name from acct.contacts
        where account_id = $1 and status = 'active' and $2 = any (flags) order by email`,
      [accountId, flag],
    );
  }

  contactByEmail(
    tx: Tx,
    accountId: string,
    email: string,
  ): Promise<(ContactLike & { portal_user_id: string | null }) | undefined> {
    return this.maybeOne(
      tx,
      'select id, email::text as email, display_name, portal_user_id from acct.contacts where account_id = $1 and email = $2',
      [accountId, email],
    );
  }

  insertContact(
    tx: Tx,
    accountId: string,
    email: string,
    displayName: string,
    portalUserId: string,
  ): Promise<ContactLike> {
    return this.one(
      tx,
      'contact',
      `insert into acct.contacts (account_id, email, display_name, portal_user_id)
       values ($1, $2, $3, $4) returning id, email::text as email, display_name`,
      [accountId, email, displayName, portalUserId],
    );
  }

  /** Binds an existing contact to the portal user, so their own surveys list finds it. */
  async bindPortalUser(tx: Tx, contactId: string, portalUserId: string): Promise<void> {
    await tx.query('update acct.contacts set portal_user_id = $2 where id = $1 and portal_user_id is null', [
      contactId,
      portalUserId,
    ]);
  }

  /** The recipient's own surveys of both kinds, newest first, with the ticket key and the answers when answered. */
  surveysOfContact(
    tx: Tx,
    contactId: string,
  ): Promise<
    (SurveyRow & {
      ticket_key: string | null;
      short_description: string | null;
      score: number | null;
      answers: Record<string, number> | null;
    })[]
  > {
    return this.many(
      tx,
      `select s.*, case when t.number is null then null else 'CS' || lpad(t.number::text, 7, '0') end as ticket_key,
              t.short_description, (r.answers->>'score')::int as score, r.answers
         from acct.csat_surveys s
         left join acct.tickets t on t.id = s.ticket_id
         left join acct.csat_responses r on r.survey_id = s.id
        where s.contact_id = $1 and s.status <> 'suppressed'
        order by s.sent_at desc limit 100`,
      [contactId],
    );
  }

  /**
   * Reminders due and surveys past their expiry, for the worker tick. A
   * reminded survey is claimed again when its row still names a later
   * reminder, which is how the quarterly survey gets its second one.
   */
  due(tx: Tx, now: Date, batch: number): Promise<SurveyRow[]> {
    return this.many(
      tx,
      `select * from acct.csat_surveys
        where status in ('sent', 'reminded') and (remind_at <= $1 or expires_at <= $1)
        order by sent_at limit $2 for update skip locked`,
      [now, batch],
    );
  }

  responsesOfAccount(
    tx: Tx,
    accountId: string,
    from: string,
    to: string,
  ): Promise<
    (ResponseRow & { ticket_key: string | null; contact_name: string | null; contact_email: string | null })[]
  > {
    return this.many(
      tx,
      `select r.*, case when t.number is null then null else 'CS' || lpad(t.number::text, 7, '0') end as ticket_key,
              case when r.anonymous then null else c.display_name end as contact_name,
              case when r.anonymous then null else c.email::text end as contact_email
         from acct.csat_responses r
         join acct.csat_surveys s on s.id = r.survey_id
         left join acct.tickets t on t.id = s.ticket_id
         left join acct.contacts c on c.id = s.contact_id
        where r.account_id = $1 and s.kind = 'ticket_close'
          and r.created_at >= $2 and r.created_at < ($3::date + 1)
        order by r.created_at desc`,
      [accountId, from, to],
    );
  }

  /**
   * Every quarterly answer of the account with the period it belongs to.
   * The window is the last periods, not the last days, so the trend is
   * still there when the from-to window of the ticket-close view is short.
   */
  quarterlyResponses(
    tx: Tx,
    accountId: string,
    periods = 8,
  ): Promise<{ period: string; answers: Record<string, number> }[]> {
    return this.many(
      tx,
      `select s.period, r.answers from acct.csat_responses r
         join acct.csat_surveys s on s.id = r.survey_id
        where r.account_id = $1 and s.kind = 'quarterly' and s.period is not null
          and s.period in (select distinct period from acct.csat_surveys
                            where account_id = $1 and kind = 'quarterly' and period is not null
                            order by period desc limit $2)`,
      [accountId, periods],
    );
  }

  contactOfPortalUser(tx: Tx, userId: string): Promise<{ id: string; account_id: string } | undefined> {
    return this.maybeOne(tx, 'select id, account_id from acct.contacts where portal_user_id = $1', [userId]);
  }

  async surveyStats(tx: Tx, accountId: string): Promise<{ sent: number; answered: number; suppressed: number }> {
    const row = await this.one<{ sent: number; answered: number; suppressed: number }>(
      tx,
      'stats',
      `select count(*) filter (where status <> 'suppressed')::int as sent,
              count(*) filter (where status = 'answered')::int as answered,
              count(*) filter (where status = 'suppressed')::int as suppressed
         from acct.csat_surveys where account_id = $1`,
      [accountId],
    );
    return row;
  }
}

// DTOs ---------------------------------------------------------------------------

/** The five keyed scores of the quarterly relationship survey (functional 5.7). */
export class QuarterlyScoresDto {
  @IsInt() @Min(1) @Max(5) responsiveness!: number;
  @IsInt() @Min(1) @Max(5) quality!: number;
  @IsInt() @Min(1) @Max(5) communication!: number;
  @IsInt() @Min(1) @Max(5) value!: number;
  @IsInt() @Min(1) @Max(5) recommend!: number;
}

/**
 * One body for both kinds: `score` answers a ticket-close survey, `scores`
 * answers a quarterly one, and the survey's own kind decides which is
 * required, so a client cannot answer the wrong shape and be believed.
 */
export class AnswerDto {
  @IsOptional() @IsInt() @Min(1) @Max(5) score?: number;
  @IsOptional() @ValidateNested() @Type(() => QuarterlyScoresDto) scores?: QuarterlyScoresDto;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

export class TokenAnswerDto extends AnswerDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
}

// Service --------------------------------------------------------------------------

@Injectable()
export class CsatService {
  private readonly logger = new Logger(CsatService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly pools: DbPools,
    private readonly repo: CsatRepository,
    private readonly tickets: TicketsRepository,
    private readonly accounts: AccountsRepository,
    private readonly email: EmailRepository,
    private readonly notifications: NotificationsRepository,
    private readonly time: TimeRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly calendars: CalendarService,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  // The close hook ----------------------------------------------------------------

  /** Outbox handler: a ticket reaching Closed earns its requester one survey, unless suppressed. */
  async onOutbox(row: OutboxRow): Promise<void> {
    if (row.event_type !== 'ticket.transitioned' || String(row.payload.to) !== 'closed') return;
    await this.uow.worker([row.account_id], async (tx) => {
      const ticket = await this.tickets.byId(tx, row.aggregate_id).catch(() => undefined);
      if (!ticket || !ticket.requester_contact_id) return;
      // The account switch (Accounts & Administration settings): no surveys until the account turns them on.
      const settings = await this.accounts.settings(tx, ticket.account_id).catch(() => undefined);
      if (!settings?.csat_enabled) return;
      if (await this.repo.surveyForTicket(tx, ticket.id, ticket.requester_contact_id)) return;
      const contact = await this.tickets.contactById(tx, ticket.requester_contact_id);
      const reason = suppressionReason(
        {
          state: ticket.state,
          resolution_code: ticket.resolution_code,
          created_at: ticket.created_at,
          closed_at: ticket.closed_at,
          cancelled_at: ticket.cancelled_at,
        },
        await this.repo.surveyedToday(tx, contact.id),
      );
      const { token, hash } = newToken();
      const timings = surveyTimings(new Date());
      const survey = await this.repo.insertSurvey(tx, {
        accountId: ticket.account_id,
        kind: 'ticket_close',
        ticketId: ticket.id,
        period: null,
        contactId: contact.id,
        tokenHash: hash,
        status: reason ? 'suppressed' : 'sent',
        remindAt: reason ? null : timings.remindAt,
        expiresAt: reason ? null : timings.expiresAt,
        suppressionReason: reason,
      });
      if (reason) return;
      await this.sendPrompt(tx, survey, contact.email, token, false, {
        key: ticketKey(ticket.number),
        shortDescription: ticket.short_description,
      });
      await this.audit.account(tx, ticket.account_id, SYSTEM_ACTOR, { correlationId: row.correlation_id }, [
        { entityKind: 'csat_survey', entityId: survey.id, ticketId: ticket.id, eventType: 'csat.survey.sent' },
      ]);
    });
  }

  private async sendPrompt(
    tx: Tx,
    survey: SurveyRow,
    to: string,
    token: string | null,
    reminder: boolean,
    ticket?: { key: string; shortDescription: string },
  ): Promise<boolean> {
    const identity = await this.email.defaultIdentity(tx, survey.account_id);
    if (!identity) {
      this.logger.warn(`survey ${survey.id}: no sender identity for the account, prompt not sent`);
      return false;
    }
    const env = loadEnv();
    // The token is the sole credential for the public answer route, so it
    // travels in the fragment: a fragment is never sent to a server and so
    // never lands in a proxy, load balancer or browser history entry that
    // someone else can read (security review finding 9).
    const link = token
      ? `${env.WEB_BASE_URL}/portal/surveys/${survey.id}#token=${token}`
      : `${env.WEB_BASE_URL}/portal/surveys/${survey.id}`;
    const until = survey.expires_at ? String(survey.expires_at).slice(0, 10) : 'the survey expires';
    const prefix = reminder ? 'Reminder: ' : '';
    const opening = reminder ? 'A short reminder: ' : '';
    const quarterly = survey.kind === 'quarterly';
    const subject = quarterly
      ? `${prefix}How are we doing? Your ${survey.period ?? 'quarterly'} review`
      : `${prefix}How satisfied are you with the handling of ${ticket?.key ?? 'your request'}?`;
    const text = quarterly
      ? `${opening}Every quarter we ask the people we work with how the service is going.\n\nFive short questions about ${survey.period ?? 'the quarter'} (${questionsFor(
          'quarterly',
        )
          .map((question) => question.text)
          .join(' ')}) and room for anything else you want to tell us: ${link}\n\nThe link works until ${until}.\n`
      : `${opening}We would value one answer about ${ticket?.key ?? 'your request'} (${ticket?.shortDescription ?? ''}).\n\nRate the handling from 1 (very dissatisfied) to 5 (very satisfied): ${link}\n\nThe link works until ${until}.\n`;
    try {
      const messageId = `<${randomUUID()}@${identity.address.split('@')[1] ?? 'xms'}>`;
      const composer = new MailComposer({
        from: { name: identity.display_name, address: identity.address },
        to,
        subject,
        text,
        messageId,
        headers: ticket
          ? { 'Auto-Submitted': 'auto-generated', 'X-XMS-Ticket': ticket.key }
          : { 'Auto-Submitted': 'auto-generated' },
      });
      const raw = await composer.compile().build();
      await this.transport.send({ from: identity.address, to: [to], raw, messageId });
      return true;
    } catch (error) {
      this.logger.warn(`survey ${survey.id}: prompt to ${to} failed: ${(error as Error).message}`);
      return false;
    }
  }

  // Answers -----------------------------------------------------------------------------

  /**
   * The portal user's own surveys of both kinds: pending first, then
   * answered. Each row carries the questions of its kind, so the portal
   * renders a quarterly survey without a second vocabulary of its own.
   */
  mine(principal: Principal) {
    return this.uow.portalWrite(principal, async (tx) => {
      const contact = await this.repo.contactOfPortalUser(tx, principal.userId);
      if (!contact) return { pending: [], answered: [] };
      const rows = (await this.repo.surveysOfContact(tx, contact.id)).map((row) => ({
        ...row,
        questions: questionsFor(row.kind),
      }));
      return {
        pending: rows.filter((row) => row.status === 'sent' || row.status === 'reminded'),
        answered: rows.filter((row) => row.status === 'answered'),
      };
    });
  }

  /** Answers as the signed-in portal user; the survey must be theirs and still open. */
  answerAsPortalUser(principal: Principal, ctx: RequestContext, surveyId: string, dto: AnswerDto) {
    return this.uow.portalWrite(principal, async (tx) => {
      const contact = await this.repo.contactOfPortalUser(tx, principal.userId);
      const survey = await this.repo.survey(tx, surveyId);
      if (!contact || survey.contact_id !== contact.id)
        throw new NotFoundException({ code: 'not_found', entity: 'survey' });
      return this.record(tx, survey, dto, actorOf(principal), ctx);
    });
  }

  /** Answers from the email link: the token must hash to the survey's; no session is needed. */
  async answerWithToken(surveyId: string, dto: TokenAnswerDto) {
    const lookup = await this.pools
      .get('app')
      .query<{ id: string | null }>('select sys.csat_survey_account($1) as id', [surveyId]);
    const accountId = lookup.rows[0]?.id;
    if (!accountId) throw new NotFoundException({ code: 'not_found', entity: 'survey' });
    return this.uow.system([accountId], async (tx) => {
      const survey = await this.repo.survey(tx, surveyId).catch(() => undefined);
      if (!survey || !tokenMatches(survey.token_hash, dto.token))
        throw new NotFoundException({ code: 'not_found', entity: 'survey' });
      return this.record(tx, survey, dto, SYSTEM_ACTOR, { correlationId: `csat-link:${surveyId}` });
    });
  }

  private async record(
    tx: Tx,
    survey: SurveyRow,
    dto: AnswerDto,
    actor: Parameters<AuditService['account']>[2],
    ctx: Parameters<AuditService['account']>[3],
  ) {
    if (survey.status === 'answered') throw new ConflictException({ code: 'already_answered' });
    if (survey.status === 'expired' || survey.status === 'suppressed')
      throw new ConflictException({ code: 'survey_closed', status: survey.status });
    if (survey.expires_at && new Date(survey.expires_at) < new Date()) {
      await this.repo.setStatus(tx, survey.id, 'expired');
      throw new ConflictException({ code: 'survey_closed', status: 'expired' });
    }
    const answers = answersFor(survey.kind, dto);
    const response = await this.repo.insertResponse(tx, {
      accountId: survey.account_id,
      surveyId: survey.id,
      answers,
      comment: dto.comment?.trim() || null,
      anonymous: false,
    });
    // The low-score rule is about the overall feeling, so a quarterly
    // survey is judged on the mean of its five answers, the same number
    // the account summary shows.
    const score = overallScore(answers);
    await this.repo.setStatus(tx, survey.id, 'answered', new Date());
    await this.audit.account(tx, survey.account_id, actor, ctx, [
      {
        entityKind: 'csat_survey',
        entityId: survey.id,
        ticketId: survey.ticket_id ?? undefined,
        eventType: 'csat.answered',
        newValue: { kind: survey.kind, period: survey.period, answers, low: isLowScore(score) },
      },
    ]);
    if (isLowScore(score)) await this.notifyLowScore(tx, survey, score, response.comment);
    return {
      survey_id: survey.id,
      kind: survey.kind,
      period: survey.period,
      answers,
      score,
      answered_at: new Date().toISOString(),
    };
  }

  /** A low score tells the people who manage the account's contracts, and the outbox. */
  private async notifyLowScore(tx: Tx, survey: SurveyRow, score: number, comment: string | null): Promise<void> {
    const ticket = survey.ticket_id ? await this.tickets.byId(tx, survey.ticket_id).catch(() => undefined) : undefined;
    const key = ticket ? ticketKey(ticket.number) : 'a ticket';
    const subject = survey.kind === 'quarterly' ? `the ${survey.period ?? 'quarterly'} relationship survey` : key;
    const recipients = await this.time.budgetRecipients(tx, survey.account_id);
    for (const recipientId of recipients)
      await this.notifications.upsert(tx, {
        accountId: survey.account_id,
        recipientId,
        type: 'csat.low_score',
        title: `Low satisfaction score (${score} of 5) on ${subject}`,
        body: comment ?? '',
        targetKind: survey.kind === 'quarterly' ? 'account' : 'ticket',
        targetId: survey.ticket_id ?? survey.id,
        link: ticket ? `/tickets/${key}` : `/accounts/${survey.account_id}?tab=satisfaction`,
        collapseKey: `csat:${survey.id}`,
      });
    await this.outbox.write(tx, {
      accountId: survey.account_id,
      aggregate: 'csat_survey',
      aggregateId: survey.id,
      eventType: 'csat.low_score',
      correlationId: randomUUID(),
      origin: 'system',
      payload: {
        kind: survey.kind,
        ticket_id: survey.ticket_id,
        period: survey.period,
        score,
        has_comment: comment !== null,
        notified: recipients.length,
      },
    });
  }

  // The operator view -------------------------------------------------------------------

  ofAccount(principal: Principal, accountId: string, from: string, to: string) {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.run(principal, async (tx) => {
      const responses = await this.repo.responsesOfAccount(tx, accountId, from, to);
      return {
        account_id: accountId,
        from,
        to,
        summary: summarise(responses.map((row) => Number(row.answers.score))),
        // The relationship survey answers a different question from the
        // ticket-close one, so it reads as its own block rather than being
        // averaged into the same number: the latest period, the mean per
        // question, and the trend over the last four periods.
        quarterly: {
          ...summariseQuarterly(await this.repo.quarterlyResponses(tx, accountId)),
          questions: questionsFor('quarterly'),
        },
        surveys: await this.repo.surveyStats(tx, accountId),
        responses: responses.map((row) => ({
          id: row.id,
          survey_id: row.survey_id,
          ticket_key: row.ticket_key,
          score: Number(row.answers.score),
          comment: row.comment,
          contact_name: row.contact_name,
          contact_email: row.contact_email,
          created_at: row.created_at,
        })),
      };
    });
  }

  // The worker tick ---------------------------------------------------------------------

  reminderJob(intervalMs = 60 * 60_000): Job {
    return { name: 'portal.csat', intervalMs, run: () => this.tick() };
  }

  /**
   * The reminder cadence of both kinds: one reminder after three days on a
   * ticket-close survey, two over three weeks on a quarterly one, then
   * expiry. The next reminder is stamped on the row as this one goes out,
   * so the schedule lives in one place (domain REMINDER_SCHEDULE) and the
   * worker keeps no counter.
   */
  async tick(now = new Date(), batch = 200): Promise<string> {
    const accounts = await this.liveAccounts();
    if (accounts.length === 0) return 'reminded 0, expired 0';
    let reminded = 0;
    let expired = 0;
    await this.uow.perAccount(accounts, async (tx) => {
      for (const survey of await this.repo.due(tx, now, batch)) {
        if (survey.expires_at && new Date(survey.expires_at) <= now) {
          await this.repo.setStatus(tx, survey.id, 'expired');
          expired += 1;
          continue;
        }
        if (!survey.remind_at || new Date(survey.remind_at) > now) continue;
        const ticket = survey.ticket_id
          ? await this.tickets.byId(tx, survey.ticket_id).catch(() => undefined)
          : undefined;
        const contact = await this.tickets.contactById(tx, survey.contact_id).catch(() => undefined);
        if (contact && (survey.kind === 'quarterly' || ticket))
          await this.sendPrompt(
            tx,
            survey,
            contact.email,
            null,
            true,
            ticket ? { key: ticketKey(ticket.number), shortDescription: ticket.short_description } : undefined,
          );
        await this.repo.setReminded(tx, survey.id, nextRemindAt(survey.kind, new Date(survey.sent_at), now));
        reminded += 1;
      }
    });
    return `reminded ${reminded}, expired ${expired}`;
  }

  // The quarterly relationship survey -----------------------------------------------------

  quarterlyJob(intervalMs = 6 * 60 * 60_000): Job {
    return { name: 'portal.csat.quarterly', intervalMs, run: () => this.quarterlyTick() };
  }

  /**
   * On or after the first business day following a quarter end, one survey
   * per period and recipient for every account with CSAT enabled
   * (functional 5.7). "On or after" is deliberate: a worker that was down
   * on the day still sends the survey when it comes back, and the
   * once-per-period-and-recipient rule stops it sending twice. The business
   * day comes from the account's default calendar when it has one, so an
   * account that does not work Mondays is not asked on a Monday, and from
   * plain weekdays otherwise.
   */
  async quarterlyTick(now = new Date()): Promise<string> {
    const accounts = await this.liveAccounts();
    if (accounts.length === 0) return 'created 0, skipped 0';
    const quarter = quarterEndedBefore(now);
    let created = 0;
    let skipped = 0;
    await this.uow.perAccount(accounts, async (tx, accountId) => {
      const settings = await this.accounts.settings(tx, accountId).catch(() => undefined);
      if (!settings?.csat_enabled) return;
      const calendar = await this.calendars.forAccount(tx, accountId);
      const opensOn = firstBusinessDayAfter(quarter.endsOn, (day) => this.isWorkingDay(calendar, day));
      if (now.toISOString().slice(0, 10) < opensOn) return;
      for (const recipient of await this.quarterlyRecipients(tx, accountId)) {
        if (await this.repo.surveyForPeriod(tx, quarter.period, recipient.contact_id)) {
          skipped += 1;
          continue;
        }
        const { token, hash } = newToken();
        const timings = surveyTimings(now, 'quarterly');
        const survey = await this.repo.insertSurvey(tx, {
          accountId,
          kind: 'quarterly',
          ticketId: null,
          period: quarter.period,
          contactId: recipient.contact_id,
          tokenHash: hash,
          status: 'sent',
          remindAt: timings.remindAt,
          expiresAt: timings.expiresAt,
          suppressionReason: null,
        });
        await this.sendPrompt(tx, survey, recipient.email, token, false);
        await this.audit.account(tx, accountId, SYSTEM_ACTOR, { correlationId: `csat-quarterly:${quarter.period}` }, [
          {
            entityKind: 'csat_survey',
            entityId: survey.id,
            eventType: 'csat.survey.sent',
            newValue: { kind: 'quarterly', period: quarter.period, recipient: recipient.source },
          },
        ]);
        created += 1;
      }
    });
    return `created ${created}, skipped ${skipped}`;
  }

  /**
   * The account's quarterly recipients: the portal users holding the
   * account-admin role and the contacts flagged executive sponsor, each
   * resolved to one contact row. An admin who has never raised a request
   * has no contact yet, so one is created and bound to them, which is also
   * what makes the survey visible in their own portal list.
   */
  private async quarterlyRecipients(tx: Tx, accountId: string): Promise<QuarterlyRecipient[]> {
    const recipients = new Map<string, QuarterlyRecipient>();
    for (const admin of await this.repo.accountAdmins(tx, accountId)) {
      const email = admin.email.toLowerCase();
      const name = `${admin.first_name} ${admin.last_name}`.trim() || email;
      const existing = await this.repo.contactByEmail(tx, accountId, email);
      let contact = existing;
      if (existing && !existing.portal_user_id) await this.repo.bindPortalUser(tx, existing.id, admin.id);
      if (!contact)
        contact = {
          ...(await this.repo.insertContact(tx, accountId, email, name, admin.id)),
          portal_user_id: admin.id,
        };
      recipients.set(contact.id, {
        contact_id: contact.id,
        email: contact.email,
        display_name: contact.display_name,
        source: 'account_admin',
      });
    }
    for (const contact of await this.repo.flaggedContacts(tx, accountId, 'executive_sponsor')) {
      if (recipients.has(contact.id)) continue;
      recipients.set(contact.id, {
        contact_id: contact.id,
        email: contact.email,
        display_name: contact.display_name,
        source: 'executive_sponsor',
      });
    }
    return [...recipients.values()];
  }

  /**
   * Whether the account's calendar works that day. The `Calendar` contract
   * exposes working minutes rather than a weekday flag, so a day with any
   * working minute in it is a working day; the wall clock means the account
   * has no calendar at all, and then plain weekdays decide.
   */
  private isWorkingDay(calendar: Calendar, day: string): boolean {
    if (calendar.id === WALL_CLOCK.id) return isWeekday(day);
    return calendar.minutesBetween(new Date(`${day}T00:00:00Z`), new Date(`${day}T23:59:59Z`)) > 0;
  }

  private async liveAccounts(): Promise<string[]> {
    const result = await this.pools
      .get('worker')
      .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding', 'offboarding')`);
    return result.rows.map((row) => row.id);
  }
}

/** The answer document for the survey's kind; the wrong shape is a 400, never a silent null. */
function answersFor(kind: SurveyKind, dto: AnswerDto): Record<string, number> {
  if (kind === 'quarterly') {
    const scores = dto.scores;
    if (!scores) throw new BadRequestException({ code: 'scores_required', questions: QUARTERLY_KEYS });
    return Object.fromEntries(QUARTERLY_KEYS.map((key) => [key, (scores as unknown as Record<string, number>)[key]]));
  }
  if (dto.score === undefined) throw new BadRequestException({ code: 'score_required' });
  return { score: dto.score };
}

/** One number for a survey of either kind: the score, or the mean of the five. */
function overallScore(answers: Record<string, number>): number {
  const values = Object.values(answers);
  return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100;
}

// Controllers ----------------------------------------------------------------------------

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal/surveys')
@RealmOf('portal')
export class PortalSurveysController {
  constructor(private readonly csat: CsatService) {}

  @Get()
  @Authenticated()
  mine(@CurrentPrincipal() principal: Principal) {
    return this.csat.mine(principal);
  }

  // Answering records a response against a survey that already exists.
  @Post(':id/answer')
  @HttpCode(200)
  @Authenticated()
  answer(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnswerDto,
  ) {
    return this.csat.answerAsPortalUser(principal, ctx, id, dto);
  }
}

/** The email link answers without a session: the one-time token is the credential, bound to the survey only. */
@ApiTags('portal')
@Controller('csat')
export class CsatLinkController {
  constructor(private readonly csat: CsatService) {}

  @Post(':id/answer')
  @HttpCode(200)
  @Public('csat one-time link; the token is the credential')
  answer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TokenAnswerDto) {
    if (!dto.token) throw new BadRequestException({ code: 'token_required' });
    return this.csat.answerWithToken(id, dto);
  }
}

@ApiTags('accounts')
@ApiBearerAuth()
@Controller('accounts/:accountId/csat')
export class AccountCsatController {
  constructor(private readonly csat: CsatService) {}

  @Get()
  @RequirePermission('tickets:view')
  ofAccount(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const day = (value: string | undefined, offsetDays: number) =>
      value && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? value
        : new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
    return this.csat.ofAccount(principal, accountId, day(from, -90), day(to, 0));
  }
}

@Module({
  imports: [TicketsCoreModule, EmailCoreModule, StorageCoreModule, CalendarsCoreModule],
  providers: [CsatRepository, CsatService],
  exports: [CsatService],
})
export class CsatCoreModule {}

@Module({
  imports: [CsatCoreModule],
  controllers: [PortalSurveysController, CsatLinkController, AccountCsatController],
  exports: [CsatCoreModule],
})
export class CsatModule {}
