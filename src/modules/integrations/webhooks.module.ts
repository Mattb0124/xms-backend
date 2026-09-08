import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import bcrypt from 'bcryptjs';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { randomBytes, randomUUID } from 'node:crypto';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { API_KEY_PREFIX, apiKeyLookupHash } from '../../common/auth/principal.repository.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { OPERATOR_PERMISSIONS, isPermission, type Permission } from '../../contracts/permissions.js';
import { loadEnv } from '../../config/env.js';
import { DbPools } from '../../db/pool.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import {
  canonicalBody,
  endpointProblem,
  isPublicEventType,
  MAX_ATTEMPTS,
  newSecret,
  nextAttemptAt,
  openSecret,
  OUTBOX_TO_PUBLIC,
  PAUSE_AFTER_FAILURES,
  PUBLIC_EVENT_TYPES,
  sealSecret,
  signatureHeader,
  type PublicEventType,
  type WebhookEnvelope,
} from '../../domain/integrations/webhooks.js';
import type { Job } from '../../worker/jobs.js';
import type { OutboxRow } from '../../worker/outbox-dispatcher.js';
import { AdminCoreModule } from '../admin/admin.module.js';
import { UsersRepository } from '../admin/users/users.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TicketsRepository, ticketKey } from '../tickets/tickets.repository.js';

/**
 * API clients and outbound webhooks (Accounts & Administration API keys;
 * Integrations technical 2.3, section 5; INT-05 cut): an administrator
 * creates an API client with scopes and account grants and sees its key
 * once; the client registers HTTPS endpoints per account for public event
 * types and receives signed deliveries with retries, dead letters and an
 * automatic pause after continuous failure. Public payloads are built by
 * mappers that name their fields, so no internal column leaks by accident.
 */

// Rows ---------------------------------------------------------------------------

export interface ApiClientRow {
  id: string;
  name: string;
  owner_user_id: string | null;
  service_user_id: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  status: 'active' | 'revoked';
  created_at: string;
  version: number;
}

export interface SubscriptionRow {
  id: string;
  account_id: string;
  api_client_id: string;
  endpoint_url: string;
  event_types: PublicEventType[];
  secret_ciphertext: string;
  secret_kid: string;
  status: 'active' | 'paused' | 'deleted';
  paused_reason: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface DeliveryRow {
  id: string;
  account_id: string;
  subscription_id: string;
  outbox_id: string;
  event_type: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'retrying' | 'dead_lettered' | 'replayed';
  response_status: number | null;
  duration_ms: number | null;
  error: string | null;
  next_attempt_at: string | null;
  payload: WebhookEnvelope;
  created_at: string;
}

const API_SCOPES: readonly Permission[] = [
  'tickets:view',
  'tickets:create',
  'tickets:work',
  'time:log',
  'kb:read',
  'webhooks:manage',
].filter(isPermission);

// Repository --------------------------------------------------------------------

@Injectable()
export class WebhooksRepository extends RepositoryBase {
  clients(tx: Tx): Promise<(ApiClientRow & { account_ids: string[] })[]> {
    return this.many(
      tx,
      `select c.id, c.name, c.owner_user_id, c.service_user_id, c.key_prefix, c.scopes, c.expires_at, c.last_used_at, c.status, c.created_at, c.version,
              coalesce((select array_agg(g.account_id) from op.api_client_grants g where g.api_client_id = c.id), '{}') as account_ids
         from op.api_clients c order by c.created_at desc`,
    );
  }

  client(tx: Tx, id: string): Promise<ApiClientRow> {
    return this.one(
      tx,
      'api_client',
      'select id, name, owner_user_id, service_user_id, key_prefix, scopes, expires_at, last_used_at, status, created_at, version from op.api_clients where id = $1',
      [id],
    );
  }

  insertClient(
    tx: Tx,
    input: {
      name: string;
      ownerUserId: string;
      serviceUserId: string;
      keyPrefix: string;
      lookupHash: string;
      secretHash: string;
      scopes: string[];
      expiresAt: string | null;
    },
  ): Promise<ApiClientRow> {
    return this.one(
      tx,
      'api_client',
      `insert into op.api_clients (name, owner_user_id, service_user_id, key_prefix, lookup_hash, secret_hash, scopes, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, name, owner_user_id, service_user_id, key_prefix, scopes, expires_at, last_used_at, status, created_at, version`,
      [
        input.name,
        input.ownerUserId,
        input.serviceUserId,
        input.keyPrefix,
        input.lookupHash,
        input.secretHash,
        input.scopes,
        input.expiresAt,
      ],
    );
  }

  async grant(tx: Tx, clientId: string, accountIds: string[]): Promise<void> {
    for (const accountId of accountIds)
      await tx.query('insert into op.api_client_grants (api_client_id, account_id) values ($1, $2)', [
        clientId,
        accountId,
      ]);
  }

  async revokeClient(tx: Tx, id: string): Promise<void> {
    await tx.query(`update op.api_clients set status = 'revoked' where id = $1`, [id]);
    await tx.query(
      `update acct.webhook_subscriptions set status = 'paused', paused_reason = 'client_revoked' where api_client_id = $1 and status = 'active'`,
      [id],
    );
  }

  subscriptionsOf(tx: Tx, clientId: string): Promise<SubscriptionRow[]> {
    return this.many(
      tx,
      `select * from acct.webhook_subscriptions where api_client_id = $1 and status <> 'deleted' order by created_at`,
      [clientId],
    );
  }

  subscription(tx: Tx, id: string): Promise<SubscriptionRow> {
    return this.one(tx, 'webhook_subscription', 'select * from acct.webhook_subscriptions where id = $1', [id]);
  }

  insertSubscription(
    tx: Tx,
    input: {
      accountId: string;
      clientId: string;
      endpointUrl: string;
      eventTypes: string[];
      secretCiphertext: string;
      secretKid: string;
    },
  ): Promise<SubscriptionRow> {
    return this.one(
      tx,
      'webhook_subscription',
      `insert into acct.webhook_subscriptions (account_id, api_client_id, endpoint_url, event_types, secret_ciphertext, secret_kid)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [input.accountId, input.clientId, input.endpointUrl, input.eventTypes, input.secretCiphertext, input.secretKid],
    );
  }

  async rotateSecret(tx: Tx, id: string, ciphertext: string, kid: string): Promise<void> {
    await tx.query(
      'update acct.webhook_subscriptions set secret_ciphertext = $2, secret_kid = $3, version = version + 1 where id = $1',
      [id, ciphertext, kid],
    );
  }

  async setStatus(tx: Tx, id: string, status: SubscriptionRow['status'], reason: string | null): Promise<void> {
    await tx.query(
      'update acct.webhook_subscriptions set status = $2, paused_reason = $3, version = version + 1 where id = $1',
      [id, status, reason],
    );
  }

  async recordOutcome(tx: Tx, id: string, delivered: boolean): Promise<number> {
    const result = await tx.query<{ consecutive_failures: number }>(
      `update acct.webhook_subscriptions set consecutive_failures = case when $2 then 0 else consecutive_failures + 1 end
        where id = $1 returning consecutive_failures`,
      [id, delivered],
    );
    return result.rows[0]?.consecutive_failures ?? 0;
  }

  activeForEvent(tx: Tx, accountId: string, type: PublicEventType): Promise<SubscriptionRow[]> {
    return this.many(
      tx,
      `select * from acct.webhook_subscriptions where account_id = $1 and status = 'active' and $2 = any (event_types)`,
      [accountId, type],
    );
  }

  insertDelivery(
    tx: Tx,
    input: {
      accountId: string;
      subscriptionId: string;
      outboxId: string;
      eventType: string;
      attempt: number;
      status: DeliveryRow['status'];
      responseStatus: number | null;
      durationMs: number | null;
      error: string | null;
      nextAttemptAt: Date | null;
      payload: WebhookEnvelope;
    },
  ): Promise<DeliveryRow> {
    return this.one(
      tx,
      'webhook_delivery',
      `insert into acct.webhook_deliveries (account_id, subscription_id, outbox_id, event_type, attempt, status, response_status, duration_ms, error, next_attempt_at, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [
        input.accountId,
        input.subscriptionId,
        input.outboxId,
        input.eventType,
        input.attempt,
        input.status,
        input.responseStatus,
        input.durationMs,
        input.error,
        input.nextAttemptAt,
        JSON.stringify(input.payload),
      ],
    );
  }

  /** Retries due now, one row per (subscription, event): the latest retrying attempt. */
  dueRetries(tx: Tx, now: Date, batch: number): Promise<DeliveryRow[]> {
    return this.many(
      tx,
      `select d.* from acct.webhook_deliveries d
        where d.status = 'retrying' and d.next_attempt_at <= $1
          and not exists (select 1 from acct.webhook_deliveries later where later.subscription_id = d.subscription_id and later.outbox_id = d.outbox_id and later.attempt > d.attempt)
        order by d.next_attempt_at limit $2 for update skip locked`,
      [now, batch],
    );
  }

  async markRetried(tx: Tx, id: string): Promise<void> {
    await tx.query(`update acct.webhook_deliveries set status = 'replayed' where id = $1 and status = 'retrying'`, [
      id,
    ]);
  }

  /** Whether the event already reached this subscription (a redelivered outbox row must not start over). */
  async hasDelivery(tx: Tx, subscriptionId: string, outboxId: string): Promise<boolean> {
    const result = await tx.query(
      'select 1 from acct.webhook_deliveries where subscription_id = $1 and outbox_id = $2 limit 1',
      [subscriptionId, outboxId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  deliveriesOf(tx: Tx, subscriptionId: string, limit = 100): Promise<DeliveryRow[]> {
    return this.many(
      tx,
      'select * from acct.webhook_deliveries where subscription_id = $1 order by created_at desc limit $2',
      [subscriptionId, limit],
    );
  }
}

// DTOs -----------------------------------------------------------------------------

export class CreateApiClientDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsIn(API_SCOPES, { each: true }) scopes!: Permission[];
  @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) account_ids!: string[];
  @IsOptional() @IsISO8601() expires_at?: string;
}

export class CreateSubscriptionDto {
  @IsUUID('4') account_id!: string;
  @IsString() @MaxLength(2000) endpoint_url!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsIn(PUBLIC_EVENT_TYPES, { each: true })
  event_types!: PublicEventType[];
}

// Public payload mappers ---------------------------------------------------------------

function ticketData(ticket: {
  number: number | string;
  type: string;
  state: string;
  priority: string;
  short_description: string;
  assignee_name?: string | null;
  updated_at: string;
}): Record<string, unknown> {
  return {
    key: ticketKey(Number(ticket.number)),
    type: ticket.type,
    state: ticket.state,
    priority: ticket.priority,
    short_description: ticket.short_description,
    assignee: ticket.assignee_name ?? null,
    updated_at: ticket.updated_at,
  };
}

// Services ------------------------------------------------------------------------------

@Injectable()
export class ApiClientsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: WebhooksRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
  ) {}

  list() {
    return this.uow.operator((tx) => this.repo.clients(tx));
  }

  /** Creates the client and its service user; the key is returned once and never stored in clear. */
  create(principal: Principal, ctx: RequestContext, dto: CreateApiClientDto) {
    const unknown = dto.account_ids.filter((id) => !principal.accountIds.includes(id));
    if (unknown.length > 0) throw new NotFoundException({ code: 'not_found', entity: 'account', ids: unknown });
    return this.uow.operator(async (tx) => {
      const key = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
      const slug =
        dto.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'client';
      const service = await this.users.insert(tx, {
        kind: 'service',
        email: `api-${slug}-${randomUUID().slice(0, 8)}@service.xms.invalid`,
        status: 'active',
        first_name: dto.name,
        last_name: 'API',
      });
      const client = await this.repo.insertClient(tx, {
        name: dto.name,
        ownerUserId: principal.userId,
        serviceUserId: service.id,
        keyPrefix: key.slice(0, 16),
        lookupHash: apiKeyLookupHash(key),
        secretHash: await bcrypt.hash(key, 10),
        scopes: dto.scopes,
        expiresAt: dto.expires_at ?? null,
      });
      await this.repo.grant(tx, client.id, [...new Set(dto.account_ids)]);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'api_client',
          entityId: client.id,
          eventType: 'admin.api_client.created',
          newValue: { name: client.name, scopes: client.scopes, accounts: dto.account_ids.length },
        },
      ]);
      await this.security.write(
        {
          type: 'admin.apikey.created',
          outcome: 'success',
          actorKind: 'user',
          actorId: principal.userId,
          actorName: principal.displayName,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: 'api_client',
          entityId: client.id,
          attrs: { scopes: client.scopes, accounts: dto.account_ids.length, prefix: client.key_prefix },
        },
        tx,
      );
      return { ...client, account_ids: dto.account_ids, key };
    });
  }

  revoke(principal: Principal, ctx: RequestContext, id: string) {
    return this.uow.operator(async (tx) => {
      const client = await this.repo.client(tx, id);
      if (client.status === 'revoked') throw new ConflictException({ code: 'already_revoked' });
      await this.repo.revokeClient(tx, id);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'api_client',
          entityId: id,
          eventType: 'admin.api_client.revoked',
          oldValue: { status: 'active' },
        },
      ]);
      return { id, status: 'revoked' };
    });
  }
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: WebhooksRepository,
    private readonly audit: AuditService,
  ) {}

  private clientId(principal: Principal): string {
    if (principal.kind !== 'api_client' || !principal.sessionId)
      throw new NotFoundException({ code: 'not_found', entity: 'api_client' });
    return principal.sessionId;
  }

  private sealingKey(): string {
    const key = loadEnv().WEBHOOK_SECRETS_KEY;
    if (!key) throw new ServiceUnavailableException({ code: 'webhooks_unconfigured' });
    return key;
  }

  list(principal: Principal) {
    const clientId = this.clientId(principal);
    return this.uow.run(principal, async (tx) =>
      (await this.repo.subscriptionsOf(tx, clientId)).map((row) => publicSubscription(row)),
    );
  }

  /** Registers an endpoint; the signing secret is returned once. */
  create(principal: Principal, ctx: RequestContext, dto: CreateSubscriptionDto) {
    const clientId = this.clientId(principal);
    if (!principal.accountIds.includes(dto.account_id))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    const problem = endpointProblem(dto.endpoint_url, loadEnv().WEBHOOK_ALLOW_PRIVATE === 'true');
    if (problem) throw new BadRequestException({ code: 'invalid_endpoint', problem });
    const key = this.sealingKey();
    return this.uow.run(principal, async (tx) => {
      const { secret, kid } = newSecret();
      let row: SubscriptionRow;
      try {
        row = await this.repo.insertSubscription(tx, {
          accountId: dto.account_id,
          clientId,
          endpointUrl: dto.endpoint_url,
          eventTypes: [...new Set(dto.event_types)],
          secretCiphertext: sealSecret(secret, key),
          secretKid: kid,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ConflictException({ code: 'endpoint_exists' });
        throw error;
      }
      await this.audit.account(tx, dto.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'webhook_subscription',
          entityId: row.id,
          eventType: 'webhook.subscribed',
          newValue: { endpoint: row.endpoint_url, event_types: row.event_types },
        },
      ]);
      return { ...publicSubscription(row), secret };
    });
  }

  rotate(principal: Principal, ctx: RequestContext, id: string) {
    const clientId = this.clientId(principal);
    const key = this.sealingKey();
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.subscription(tx, id);
      if (row.api_client_id !== clientId || row.status === 'deleted')
        throw new NotFoundException({ code: 'not_found', entity: 'webhook_subscription' });
      const { secret, kid } = newSecret();
      await this.repo.rotateSecret(tx, id, sealSecret(secret, key), kid);
      await this.audit.account(tx, row.account_id, actorOf(principal), ctx, [
        { entityKind: 'webhook_subscription', entityId: id, eventType: 'webhook.secret_rotated', newValue: { kid } },
      ]);
      return { id, secret_kid: kid, secret };
    });
  }

  remove(principal: Principal, ctx: RequestContext, id: string) {
    const clientId = this.clientId(principal);
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.subscription(tx, id);
      if (row.api_client_id !== clientId || row.status === 'deleted')
        throw new NotFoundException({ code: 'not_found', entity: 'webhook_subscription' });
      await this.repo.setStatus(tx, id, 'deleted', null);
      await this.audit.account(tx, row.account_id, actorOf(principal), ctx, [
        { entityKind: 'webhook_subscription', entityId: id, eventType: 'webhook.unsubscribed' },
      ]);
      return { removed: id };
    });
  }

  deliveries(principal: Principal, id: string) {
    const clientId = this.clientId(principal);
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.subscription(tx, id);
      if (row.api_client_id !== clientId)
        throw new NotFoundException({ code: 'not_found', entity: 'webhook_subscription' });
      return (await this.repo.deliveriesOf(tx, id)).map((delivery) => ({
        id: delivery.id,
        outbox_id: delivery.outbox_id,
        event_type: delivery.event_type,
        attempt: delivery.attempt,
        status: delivery.status,
        response_status: delivery.response_status,
        duration_ms: delivery.duration_ms,
        error: delivery.error,
        next_attempt_at: delivery.next_attempt_at,
        created_at: delivery.created_at,
      }));
    });
  }
}

function publicSubscription(row: SubscriptionRow) {
  return {
    id: row.id,
    account_id: row.account_id,
    endpoint_url: row.endpoint_url,
    event_types: row.event_types,
    secret_kid: row.secret_kid,
    status: row.status,
    paused_reason: row.paused_reason,
    consecutive_failures: row.consecutive_failures,
    created_at: row.created_at,
    version: row.version,
  };
}

/** The worker side: renders the public payload, delivers, retries and pauses. */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  /** Replaceable in tests. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly pools: DbPools,
    private readonly repo: WebhooksRepository,
    private readonly tickets: TicketsRepository,
    private readonly audit: AuditService,
  ) {}

  handles(type: string): boolean {
    return type in OUTBOX_TO_PUBLIC;
  }

  retryJob(intervalMs = 60_000): Job {
    return { name: 'webhook.retry', intervalMs, run: () => this.retryDue() };
  }

  /** Outbox handler: one first attempt per active subscription of the account for the event's public type. */
  async onOutbox(row: OutboxRow): Promise<void> {
    const type = OUTBOX_TO_PUBLIC[row.event_type];
    if (!type) return;
    await this.uow.worker([row.account_id], async (tx) => {
      const subscriptions = await this.repo.activeForEvent(tx, row.account_id, type);
      if (subscriptions.length === 0) return;
      const data = await this.publicData(tx, row, type);
      if (!data) return;
      const envelope: WebhookEnvelope = {
        id: String(row.id),
        type,
        occurred_at: new Date(row.created_at).toISOString(),
        account_id: row.account_id,
        data,
      };
      for (const subscription of subscriptions) {
        if (await this.repo.hasDelivery(tx, subscription.id, envelope.id)) continue;
        await this.attempt(tx, subscription, envelope, 1);
      }
    });
  }

  /** The public representation per type; null when the event carries nothing public (a work note, an internal-only comment). */
  private async publicData(tx: Tx, row: OutboxRow, type: PublicEventType): Promise<Record<string, unknown> | null> {
    if (type === 'billing_period.locked')
      return { period_id: row.aggregate_id, starts_on: row.payload.starts_on, ends_on: row.payload.ends_on };
    const ticketId =
      type === 'comment.created' || type === 'time_entry.created'
        ? String(row.payload.ticket_id ?? row.aggregate_id)
        : row.aggregate_id;
    const ticket = await this.tickets.byId(tx, ticketId).catch(() => undefined);
    if (!ticket) return null;
    const base = ticketData(ticket as Parameters<typeof ticketData>[0]);
    if (type === 'comment.created') {
      if (row.payload.source !== 'internal' && row.payload.source !== 'portal') return null;
      return { ticket: base, comment_id: row.payload.comment_id, source: row.payload.source };
    }
    if (type === 'time_entry.created')
      return {
        ticket: base,
        minutes: row.payload.minutes ?? null,
        activity_type: row.payload.activity_type ?? null,
        billable_class: row.payload.billable_class ?? null,
      };
    if (type === 'ticket.transitioned')
      return { ticket: base, from: row.payload.from ?? null, to: row.payload.to ?? null };
    return { ticket: base };
  }

  private async attempt(
    tx: Tx,
    subscription: SubscriptionRow,
    envelope: WebhookEnvelope,
    attempt: number,
  ): Promise<void> {
    const env = loadEnv();
    const body = canonicalBody(envelope);
    const timestamp = String(Math.floor(Date.now() / 1000));
    let secret: string | null = null;
    try {
      secret = env.WEBHOOK_SECRETS_KEY ? openSecret(subscription.secret_ciphertext, env.WEBHOOK_SECRETS_KEY) : null;
    } catch {
      secret = null;
    }
    const started = Date.now();
    let responseStatus: number | null = null;
    let error: string | null = null;
    if (!secret) error = 'signing secret unavailable';
    else if (endpointProblem(subscription.endpoint_url, env.WEBHOOK_ALLOW_PRIVATE === 'true'))
      error = 'endpoint refused';
    else {
      try {
        const response = await this.fetchImpl(subscription.endpoint_url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-xms-event': envelope.type,
            'x-xms-delivery': envelope.id,
            'x-xms-timestamp': timestamp,
            'x-xms-signature': signatureHeader(subscription.secret_kid, secret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        responseStatus = response.status;
        if (response.status < 200 || response.status >= 300) error = `http ${response.status}`;
      } catch (caught) {
        error = (caught as Error).message.slice(0, 300);
      }
    }
    const delivered = error === null;
    const final = !delivered && attempt >= MAX_ATTEMPTS;
    const next = delivered || final ? null : nextAttemptAt(attempt, new Date());
    await this.repo.insertDelivery(tx, {
      accountId: subscription.account_id,
      subscriptionId: subscription.id,
      outboxId: envelope.id,
      eventType: envelope.type,
      attempt,
      status: delivered ? 'delivered' : final ? 'dead_lettered' : 'retrying',
      responseStatus,
      durationMs: Date.now() - started,
      error,
      nextAttemptAt: next,
      payload: envelope,
    });
    if (delivered || final) {
      const failures = await this.repo.recordOutcome(tx, subscription.id, delivered);
      if (!delivered && failures >= PAUSE_AFTER_FAILURES) {
        await this.repo.setStatus(tx, subscription.id, 'paused', 'continuous_failure');
        await this.audit.account(tx, subscription.account_id, { kind: 'system', id: 'worker', name: 'XMS' }, {}, [
          {
            entityKind: 'webhook_subscription',
            entityId: subscription.id,
            eventType: 'webhook.paused',
            newValue: { reason: 'continuous_failure', failures },
          },
        ]);
        this.logger.warn(`webhook ${subscription.id} paused after ${failures} dead-lettered events`);
      }
    }
  }

  /** Retries due deliveries; each retry is a new attempt row and the retried row becomes replayed. */
  async retryDue(now = new Date(), batch = 50): Promise<string> {
    const accounts = (
      await this.pools
        .get('worker')
        .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding', 'offboarding')`)
    ).rows.map((row) => row.id);
    if (accounts.length === 0) return 'retried 0';
    let retried = 0;
    await this.uow.worker(accounts, async (tx) => {
      for (const due of await this.repo.dueRetries(tx, now, batch)) {
        const subscription = await this.repo.subscription(tx, due.subscription_id).catch(() => undefined);
        await this.repo.markRetried(tx, due.id);
        if (!subscription || subscription.status !== 'active') continue;
        await this.attempt(tx, subscription, due.payload, due.attempt + 1);
        retried += 1;
      }
    });
    return `retried ${retried}`;
  }
}

// Controllers -------------------------------------------------------------------------------

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/api-clients')
@RequirePermission('admin:api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get()
  list() {
    return this.clients.list();
  }

  @Get('scopes')
  scopes() {
    return API_SCOPES.map((scope) => ({
      scope,
      description: (OPERATOR_PERMISSIONS as Record<string, string>)[scope] ?? '',
    }));
  }

  @Post()
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateApiClientDto) {
    return this.clients.create(principal, ctx, dto);
  }

  @Post(':id/revoke')
  revoke(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.clients.revoke(principal, ctx, id);
  }
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('webhooks')
@RequirePermission('webhooks:manage')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('event-types')
  eventTypes() {
    return PUBLIC_EVENT_TYPES;
  }

  @Get()
  list(@CurrentPrincipal() principal: Principal) {
    return this.webhooks.list(principal);
  }

  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: CreateSubscriptionDto,
  ) {
    return this.webhooks.create(principal, ctx, dto);
  }

  @Post(':id/rotate-secret')
  rotate(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.rotate(principal, ctx, id);
  }

  @Get(':id/deliveries')
  deliveries(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') _limit?: string,
  ) {
    return this.webhooks.deliveries(principal, id);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.webhooks.remove(principal, ctx, id);
  }
}

export function isPublic(type: string): boolean {
  return isPublicEventType(type);
}

@Module({
  imports: [AdminCoreModule, TicketsCoreModule],
  providers: [WebhooksRepository, ApiClientsService, WebhooksService, WebhookDeliveryService],
  exports: [WebhookDeliveryService, WebhooksService, ApiClientsService],
})
export class WebhooksCoreModule {}

@Module({
  imports: [WebhooksCoreModule],
  controllers: [ApiClientsController, WebhooksController],
  exports: [WebhooksCoreModule],
})
export class WebhooksModule {}
