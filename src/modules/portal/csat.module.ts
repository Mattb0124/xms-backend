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
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
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
  tokenMatches,
  isLowScore,
  newToken,
  summarise,
  suppressionReason,
  surveyTimings,
} from '../../domain/portal/csat.js';
import type { Job } from '../../worker/jobs.js';
import type { OutboxRow } from '../../worker/outbox-dispatcher.js';
import { AccountsRepository } from '../admin/accounts/accounts.repository.js';
import { EmailCoreModule } from '../email/email.module.js';
import { EmailRepository } from '../email/email.repository.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TicketsRepository, ticketKey } from '../tickets/tickets.repository.js';
import { TimeRepository } from '../time/time.repository.js';

/**
 * CSAT on ticket close (Client Portal functional 5.7, technical 2.3 and 3;
 * CP-07 cut to the ticket-close survey): when a ticket closes the worker
 * creates one survey for the requester unless suppressed, mails a one-time
 * link, reminds once, expires it, and a low score tells the account's
 * contract managers. The requester answers from the portal or from the
 * link without a session; the operator reads the scores per account.
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
  answers: { score: number };
  comment: string | null;
  anonymous: boolean;
  created_at: string;
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

  insertSurvey(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string;
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
      `insert into acct.csat_surveys (account_id, kind, ticket_id, contact_id, token_hash, status, remind_at, expires_at, suppression_reason)
       values ($1, 'ticket_close', $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        input.accountId,
        input.ticketId,
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

  insertResponse(
    tx: Tx,
    input: { accountId: string; surveyId: string; score: number; comment: string | null; anonymous: boolean },
  ): Promise<ResponseRow> {
    return this.one(
      tx,
      'response',
      `insert into acct.csat_responses (account_id, survey_id, answers, comment, anonymous)
       values ($1, $2, $3, $4, $5) returning *`,
      [input.accountId, input.surveyId, JSON.stringify({ score: input.score }), input.comment, input.anonymous],
    );
  }

  /** The requester's own surveys, newest first, with the ticket key and the response when answered. */
  surveysOfContact(
    tx: Tx,
    contactId: string,
  ): Promise<(SurveyRow & { ticket_key: string | null; short_description: string | null; score: number | null })[]> {
    return this.many(
      tx,
      `select s.*, case when t.number is null then null else 'CS' || lpad(t.number::text, 7, '0') end as ticket_key,
              t.short_description, (r.answers->>'score')::int as score
         from acct.csat_surveys s
         left join acct.tickets t on t.id = s.ticket_id
         left join acct.csat_responses r on r.survey_id = s.id
        where s.contact_id = $1 and s.status <> 'suppressed'
        order by s.sent_at desc limit 100`,
      [contactId],
    );
  }

  /** Reminders due and surveys past their expiry, for the worker tick. */
  due(tx: Tx, now: Date, batch: number): Promise<SurveyRow[]> {
    return this.many(
      tx,
      `select * from acct.csat_surveys
        where (status = 'sent' and remind_at <= $1) or (status in ('sent', 'reminded') and expires_at <= $1)
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
        where r.account_id = $1 and r.created_at >= $2 and r.created_at < ($3::date + 1)
        order by r.created_at desc`,
      [accountId, from, to],
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

export class AnswerDto {
  @IsInt() @Min(1) @Max(5) score!: number;
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
        ticketId: ticket.id,
        contactId: contact.id,
        tokenHash: hash,
        status: reason ? 'suppressed' : 'sent',
        remindAt: reason ? null : timings.remindAt,
        expiresAt: reason ? null : timings.expiresAt,
        suppressionReason: reason,
      });
      if (reason) return;
      await this.sendPrompt(
        tx,
        survey,
        ticketKey(ticket.number),
        ticket.short_description,
        contact.email,
        token,
        false,
      );
      await this.audit.account(tx, ticket.account_id, SYSTEM_ACTOR, { correlationId: row.correlation_id }, [
        { entityKind: 'csat_survey', entityId: survey.id, ticketId: ticket.id, eventType: 'csat.survey.sent' },
      ]);
    });
  }

  private async sendPrompt(
    tx: Tx,
    survey: SurveyRow,
    key: string,
    shortDescription: string,
    to: string,
    token: string | null,
    reminder: boolean,
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
    const subject = `${reminder ? 'Reminder: ' : ''}How satisfied are you with the handling of ${key}?`;
    const text = `${reminder ? 'A short reminder: ' : ''}We would value one answer about ${key} (${shortDescription}).\n\nRate the handling from 1 (very dissatisfied) to 5 (very satisfied): ${link}\n\nThe link works until ${survey.expires_at ? String(survey.expires_at).slice(0, 10) : 'the survey expires'}.\n`;
    try {
      const messageId = `<${randomUUID()}@${identity.address.split('@')[1] ?? 'xms'}>`;
      const composer = new MailComposer({
        from: { name: identity.display_name, address: identity.address },
        to,
        subject,
        text,
        messageId,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-XMS-Ticket': key },
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

  /** The portal user's own surveys: pending first, then answered. */
  mine(principal: Principal) {
    return this.uow.portalWrite(principal, async (tx) => {
      const contact = await this.repo.contactOfPortalUser(tx, principal.userId);
      if (!contact) return { pending: [], answered: [] };
      const rows = await this.repo.surveysOfContact(tx, contact.id);
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
    const response = await this.repo.insertResponse(tx, {
      accountId: survey.account_id,
      surveyId: survey.id,
      score: dto.score,
      comment: dto.comment?.trim() || null,
      anonymous: false,
    });
    await this.repo.setStatus(tx, survey.id, 'answered', new Date());
    await this.audit.account(tx, survey.account_id, actor, ctx, [
      {
        entityKind: 'csat_survey',
        entityId: survey.id,
        ticketId: survey.ticket_id ?? undefined,
        eventType: 'csat.answered',
        newValue: { score: dto.score, low: isLowScore(dto.score) },
      },
    ]);
    if (isLowScore(dto.score)) await this.notifyLowScore(tx, survey, dto.score, response.comment);
    return { survey_id: survey.id, score: dto.score, answered_at: new Date().toISOString() };
  }

  /** A low score tells the people who manage the account's contracts, and the outbox. */
  private async notifyLowScore(tx: Tx, survey: SurveyRow, score: number, comment: string | null): Promise<void> {
    const ticket = survey.ticket_id ? await this.tickets.byId(tx, survey.ticket_id).catch(() => undefined) : undefined;
    const key = ticket ? ticketKey(ticket.number) : 'a ticket';
    const recipients = await this.time.budgetRecipients(tx, survey.account_id);
    for (const recipientId of recipients)
      await this.notifications.upsert(tx, {
        accountId: survey.account_id,
        recipientId,
        type: 'csat.low_score',
        title: `Low satisfaction score (${score} of 5) on ${key}`,
        body: comment ?? '',
        targetKind: 'ticket',
        targetId: survey.ticket_id ?? survey.id,
        link: ticket ? `/tickets/${key}` : `/accounts/${survey.account_id}`,
        collapseKey: `csat:${survey.id}`,
      });
    await this.outbox.write(tx, {
      accountId: survey.account_id,
      aggregate: 'csat_survey',
      aggregateId: survey.id,
      eventType: 'csat.low_score',
      correlationId: randomUUID(),
      origin: 'system',
      payload: { ticket_id: survey.ticket_id, score, has_comment: comment !== null, notified: recipients.length },
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

  /** One reminder per survey after three days; expiry after ten. */
  async tick(now = new Date(), batch = 200): Promise<string> {
    const accounts = (
      await this.pools
        .get('worker')
        .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding', 'offboarding')`)
    ).rows.map((row) => row.id);
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
        const ticket = survey.ticket_id
          ? await this.tickets.byId(tx, survey.ticket_id).catch(() => undefined)
          : undefined;
        const contact = await this.tickets.contactById(tx, survey.contact_id).catch(() => undefined);
        if (ticket && contact)
          await this.sendPrompt(
            tx,
            survey,
            ticketKey(ticket.number),
            ticket.short_description,
            contact.email,
            null,
            true,
          );
        await this.repo.setStatus(tx, survey.id, 'reminded');
        reminded += 1;
      }
    });
    return `reminded ${reminded}, expired ${expired}`;
  }
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
  imports: [TicketsCoreModule, EmailCoreModule, StorageCoreModule],
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
