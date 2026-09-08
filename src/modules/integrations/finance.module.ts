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
  Post,
  Put,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import { actorOf, AuditService, SYSTEM_ACTOR, type AuditActor } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import { OBJECT_STORE, StorageCoreModule } from '../../common/storage/storage.module.js';
import { loadEnv } from '../../config/env.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { discardBody, outboundProblem } from '../../common/http/outbound.js';
import {
  endpointProblem,
  newSecret,
  openSecret,
  sealSecret,
  signatureHeader,
} from '../../domain/integrations/webhooks.js';
import type { OutboxRow } from '../../worker/outbox-dispatcher.js';
import { AccountsRepository } from '../admin/accounts/accounts.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TimeCoreModule, TimeService } from '../time/time.module.js';
import { TimeRepository } from '../time/time.repository.js';

/**
 * Finance delivery (Integrations functional 5.2, technical 2.4 and 3;
 * INT-02 cut): a locked billing period's file goes to the account's
 * destination on its own, as a signed HTTPS post carrying the manifest and
 * the file, or as objects under a prefix in the object store; every hand-over
 * is a delivery row that finance can acknowledge through the API, and a
 * re-delivery supersedes the earlier one.
 */

export interface DestinationRow {
  id: string;
  account_id: string;
  kind: 'https' | 'object_store';
  endpoint_url: string | null;
  object_prefix: string | null;
  secret_ciphertext: string | null;
  secret_kid: string | null;
  format: 'csv' | 'xlsx';
  enabled: boolean;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface DeliveryRow {
  id: string;
  account_id: string;
  billing_period_id: string;
  billing_export_id: string;
  destination_kind: 'https' | 'object_store';
  manifest_key: string | null;
  status: 'pending' | 'delivered' | 'acknowledged' | 'failed' | 'superseded';
  supersedes_id: string | null;
  response_status: number | null;
  ack_received_at: string | null;
  ack_reference: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface Manifest {
  readonly account_key: string;
  readonly period_id: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly export_id: string;
  readonly format: 'csv' | 'xlsx';
  readonly checksum: string;
  readonly row_count: number;
  readonly produced_at: string;
  readonly supersedes: string | null;
}

// Repository ------------------------------------------------------------------------

@Injectable()
export class FinanceRepository extends RepositoryBase {
  destination(tx: Tx, accountId: string): Promise<DestinationRow | undefined> {
    return this.maybeOne(tx, 'select * from acct.finance_destinations where account_id = $1', [accountId]);
  }

  upsertDestination(
    tx: Tx,
    input: {
      accountId: string;
      kind: 'https' | 'object_store';
      endpointUrl: string | null;
      objectPrefix: string | null;
      secretCiphertext: string | null;
      secretKid: string | null;
      format: 'csv' | 'xlsx';
      enabled: boolean;
    },
  ): Promise<DestinationRow> {
    return this.one(
      tx,
      'finance_destination',
      `insert into acct.finance_destinations (account_id, kind, endpoint_url, object_prefix, secret_ciphertext, secret_kid, format, enabled)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (account_id) do update set
         kind = excluded.kind, endpoint_url = excluded.endpoint_url, object_prefix = excluded.object_prefix,
         secret_ciphertext = coalesce(excluded.secret_ciphertext, acct.finance_destinations.secret_ciphertext),
         secret_kid = coalesce(excluded.secret_kid, acct.finance_destinations.secret_kid),
         format = excluded.format, enabled = excluded.enabled, version = acct.finance_destinations.version + 1
       returning *`,
      [
        input.accountId,
        input.kind,
        input.endpointUrl,
        input.objectPrefix,
        input.secretCiphertext,
        input.secretKid,
        input.format,
        input.enabled,
      ],
    );
  }

  deliveries(tx: Tx, filter: { accountId?: string; periodId?: string }): Promise<DeliveryRow[]> {
    return this.many(
      tx,
      `select * from acct.finance_deliveries
        where ($1::uuid is null or account_id = $1) and ($2::uuid is null or billing_period_id = $2)
        order by created_at desc limit 200`,
      [filter.accountId ?? null, filter.periodId ?? null],
    );
  }

  delivery(tx: Tx, id: string): Promise<DeliveryRow> {
    return this.one(tx, 'finance_delivery', 'select * from acct.finance_deliveries where id = $1', [id]);
  }

  /** Supersedes every open delivery for the period and names the most recent of them. */
  async supersedeOpen(tx: Tx, periodId: string): Promise<string | null> {
    const result = await tx.query<{ id: string; created_at: string }>(
      `update acct.finance_deliveries set status = 'superseded'
        where billing_period_id = $1 and status in ('pending', 'delivered', 'acknowledged', 'failed')
        returning id, created_at`,
      [periodId],
    );
    const latest = [...result.rows].sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
    return latest?.id ?? null;
  }

  insertDelivery(
    tx: Tx,
    input: {
      accountId: string;
      periodId: string;
      exportId: string;
      kind: 'https' | 'object_store';
      manifestKey: string | null;
      status: DeliveryRow['status'];
      supersedesId: string | null;
      responseStatus: number | null;
      error: string | null;
    },
  ): Promise<DeliveryRow> {
    return this.one(
      tx,
      'finance_delivery',
      `insert into acct.finance_deliveries (account_id, billing_period_id, billing_export_id, destination_kind, manifest_key, status, supersedes_id, response_status, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        input.accountId,
        input.periodId,
        input.exportId,
        input.kind,
        input.manifestKey,
        input.status,
        input.supersedesId,
        input.responseStatus,
        input.error,
      ],
    );
  }

  async acknowledge(tx: Tx, id: string, reference: string | null): Promise<DeliveryRow> {
    return this.one(
      tx,
      'finance_delivery',
      `update acct.finance_deliveries set status = 'acknowledged', ack_received_at = now(), ack_reference = $2, version = version + 1
        where id = $1 returning *`,
      [id, reference],
    );
  }
}

// DTOs ----------------------------------------------------------------------------------

export class SetDestinationDto {
  @IsIn(['https', 'object_store']) kind!: 'https' | 'object_store';
  @IsOptional() @IsString() @MaxLength(2000) endpoint_url?: string;
  @IsOptional() @Matches(/^[a-z0-9][a-z0-9/_.-]{0,200}$/) object_prefix?: string;
  @IsOptional() @IsIn(['csv', 'xlsx']) format?: 'csv' | 'xlsx';
  @IsOptional() enabled?: boolean;
}

export class DeliverDto {
  @IsUUID('4') period_id!: string;
}

export class AckDto {
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
}

// Service -------------------------------------------------------------------------------

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);
  /** Replaceable in tests. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: FinanceRepository,
    private readonly time: TimeService,
    private readonly timeRepo: TimeRepository,
    private readonly accounts: AccountsRepository,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  private sealingKey(): string {
    const key = loadEnv().WEBHOOK_SECRETS_KEY;
    if (!key) throw new ServiceUnavailableException({ code: 'finance_unconfigured' });
    return key;
  }

  destination(principal: Principal, accountId: string) {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.destination(tx, accountId);
      return row ? publicDestination(row) : null;
    });
  }

  /** Sets the account's destination; an HTTPS destination gets a signing secret, shown once, on first set or when the endpoint changes. */
  setDestination(principal: Principal, ctx: RequestContext, accountId: string, dto: SetDestinationDto) {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    if (dto.kind === 'https') {
      if (!dto.endpoint_url) throw new BadRequestException({ code: 'endpoint_required' });
      const problem = endpointProblem(dto.endpoint_url, loadEnv().WEBHOOK_ALLOW_PRIVATE === 'true');
      if (problem) throw new BadRequestException({ code: 'invalid_endpoint', problem });
    } else if (!dto.object_prefix) throw new BadRequestException({ code: 'prefix_required' });
    return this.uow.run(principal, async (tx) => {
      const before = await this.repo.destination(tx, accountId);
      let secret: string | null = null;
      let sealed: string | null = null;
      let kid: string | null = null;
      if (dto.kind === 'https' && (!before || before.kind !== 'https' || before.endpoint_url !== dto.endpoint_url)) {
        const fresh = newSecret();
        secret = fresh.secret;
        kid = fresh.kid;
        sealed = sealSecret(secret, this.sealingKey());
      }
      const row = await this.repo.upsertDestination(tx, {
        accountId,
        kind: dto.kind,
        endpointUrl: dto.kind === 'https' ? (dto.endpoint_url ?? null) : null,
        objectPrefix: dto.kind === 'object_store' ? (dto.object_prefix ?? null) : null,
        secretCiphertext: sealed,
        secretKid: kid,
        format: dto.format ?? 'csv',
        enabled: dto.enabled ?? true,
      });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'finance_destination',
          entityId: row.id,
          eventType: 'finance.destination.set',
          oldValue: before ? { kind: before.kind, enabled: before.enabled } : null,
          newValue: {
            kind: row.kind,
            endpoint: row.endpoint_url,
            prefix: row.object_prefix,
            format: row.format,
            enabled: row.enabled,
          },
        },
      ]);
      return { ...publicDestination(row), ...(secret ? { secret } : {}) };
    });
  }

  deliveries(principal: Principal, filter: { accountId?: string; periodId?: string }) {
    if (filter.accountId && !principal.accountIds.includes(filter.accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.run(principal, (tx) => this.repo.deliveries(tx, filter));
  }

  /** Deliver or re-deliver a locked period now; the earlier delivery is superseded. */
  deliverNow(principal: Principal, ctx: RequestContext, dto: DeliverDto) {
    return this.uow.run(principal, async (tx) => {
      const period = await this.timeRepo.billingPeriod(tx, dto.period_id);
      if (period.status !== 'locked' && period.status !== 'exported')
        throw new ConflictException({ code: 'period_not_locked', status: period.status });
      const destination = await this.repo.destination(tx, period.account_id);
      if (!destination || !destination.enabled) throw new ConflictException({ code: 'no_destination' });
      return this.deliver(tx, period.id, destination, actorOf(principal), principal.userId, ctx.requestId);
    });
  }

  /** The API client's acknowledgement (scope exports:read); finance says the file landed on its side. */
  acknowledge(principal: Principal, ctx: RequestContext, id: string, dto: AckDto) {
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.delivery(tx, id);
      if (row.status !== 'delivered') throw new ConflictException({ code: 'not_deliverable', status: row.status });
      const after = await this.repo.acknowledge(tx, id, dto.reference ?? null);
      await this.audit.account(tx, row.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'finance_delivery',
          entityId: id,
          eventType: 'finance.acknowledged',
          newValue: { reference: dto.reference ?? null },
        },
      ]);
      return after;
    });
  }

  /**
   * Outbox handler: a period locking delivers itself when the account has an
   * enabled destination. The outbox is at-least-once, so the same lock can
   * arrive twice; a period already `exported` has had its delivery and the
   * handler does nothing, which leaves re-delivery an explicit act.
   */
  async onOutbox(row: OutboxRow): Promise<void> {
    if (row.event_type !== 'billing_period.locked') return;
    await this.uow.worker([row.account_id], async (tx) => {
      const destination = await this.repo.destination(tx, row.account_id);
      if (!destination || !destination.enabled) return;
      const period = await this.timeRepo.billingPeriod(tx, row.aggregate_id).catch(() => undefined);
      if (!period || period.status !== 'locked') return;
      await this.deliver(tx, period.id, destination, SYSTEM_ACTOR, 'system', row.correlation_id);
    });
  }

  private async deliver(
    tx: Tx,
    periodId: string,
    destination: DestinationRow,
    actor: AuditActor,
    producedBy: string,
    correlationId?: string,
  ) {
    const period = await this.timeRepo.billingPeriod(tx, periodId);
    const account = await this.accounts.byId(tx, period.account_id);
    const produced = await this.time.produceFinanceFile(tx, period, destination.format, producedBy);
    const supersedes = await this.repo.supersedeOpen(tx, periodId);
    const manifest: Manifest = {
      account_key: account.key,
      period_id: period.id,
      period_start: period.starts_on,
      period_end: period.ends_on,
      export_id: produced.record.id,
      format: destination.format,
      checksum: produced.checksum,
      row_count: produced.rows,
      produced_at: new Date().toISOString(),
      supersedes,
    };
    let status: DeliveryRow['status'] = 'delivered';
    let responseStatus: number | null = null;
    let error: string | null = null;
    let manifestKey: string | null = null;
    if (destination.kind === 'object_store') {
      const base = `${destination.object_prefix!.replace(/\/+$/, '')}/${account.key}/${produced.label}`;
      manifestKey = `${base}/manifest.json`;
      try {
        await this.store.putObject(
          `${base}/finance.${destination.format}`,
          produced.body,
          contentTypeOf(destination.format),
        );
        await this.store.putObject(manifestKey, JSON.stringify(manifest, null, 2), 'application/json');
      } catch (caught) {
        status = 'failed';
        error = (caught as Error).message.slice(0, 300);
      }
    } else {
      const env = loadEnv();
      let secret: string | null = null;
      try {
        secret =
          destination.secret_ciphertext && env.WEBHOOK_SECRETS_KEY
            ? openSecret(destination.secret_ciphertext, env.WEBHOOK_SECRETS_KEY)
            : null;
      } catch {
        secret = null;
      }
      const problem =
        secret && destination.endpoint_url
          ? await outboundProblem(destination.endpoint_url, env.WEBHOOK_ALLOW_PRIVATE === 'true')
          : null;
      if (!secret || !destination.endpoint_url) {
        status = 'failed';
        error = 'signing secret unavailable';
      } else if (problem) {
        status = 'failed';
        error = `endpoint refused (${problem})`;
      } else {
        const body = JSON.stringify({ manifest, file: produced.body.toString('base64') });
        const timestamp = String(Math.floor(Date.now() / 1000));
        try {
          const response = await this.fetchImpl(destination.endpoint_url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-xms-event': 'finance.export',
              'x-xms-delivery': produced.record.id,
              'x-xms-timestamp': timestamp,
              'x-xms-signature': signatureHeader(destination.secret_kid ?? 'none', secret, timestamp, body),
            },
            body,
            // Never followed: the guard cannot judge a hop it does not see.
            redirect: 'manual',
            signal: AbortSignal.timeout(30_000),
          });
          responseStatus = response.status;
          await discardBody(response);
          if (response.status >= 300 && response.status < 400) {
            status = 'failed';
            error = `redirect refused (${response.status})`;
          } else if (response.status < 200 || response.status >= 300) {
            status = 'failed';
            error = `http ${response.status}`;
          }
        } catch (caught) {
          status = 'failed';
          error = (caught as Error).message.slice(0, 300);
        }
      }
    }
    const delivery = await this.repo.insertDelivery(tx, {
      accountId: period.account_id,
      periodId,
      exportId: produced.record.id,
      kind: destination.kind,
      manifestKey,
      status,
      supersedesId: supersedes,
      responseStatus,
      error,
    });
    if (status === 'delivered') {
      const fresh = await this.timeRepo.billingPeriod(tx, periodId);
      if (fresh.status === 'locked')
        await this.timeRepo.updateBillingPeriod(tx, periodId, fresh.version, { status: 'exported' });
    }
    await this.audit.account(tx, period.account_id, actor, { correlationId }, [
      {
        entityKind: 'finance_delivery',
        entityId: delivery.id,
        eventType: status === 'delivered' ? 'finance.delivered' : 'finance.delivery_failed',
        newValue: {
          period: produced.label,
          kind: destination.kind,
          checksum: produced.checksum,
          rows: produced.rows,
          error,
        },
      },
    ]);
    await this.security.write(
      {
        type: 'data.export.produced',
        outcome: status === 'delivered' ? 'success' : 'failed',
        accountId: period.account_id,
        actorKind: actor.kind === 'system' ? 'system' : 'user',
        actorId: actor.id,
        actorName: actor.name,
        attrs: {
          kind: 'finance_delivery',
          destination: destination.kind,
          checksum: produced.checksum,
          rows: produced.rows,
          error,
        },
      },
      tx,
    );
    if (status !== 'delivered') this.logger.warn(`finance delivery for period ${periodId} failed: ${error}`);
    return delivery;
  }
}

function contentTypeOf(format: 'csv' | 'xlsx'): string {
  return format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

function publicDestination(row: DestinationRow) {
  return {
    id: row.id,
    account_id: row.account_id,
    kind: row.kind,
    endpoint_url: row.endpoint_url,
    object_prefix: row.object_prefix,
    secret_kid: row.secret_kid,
    format: row.format,
    enabled: row.enabled,
    updated_at: row.updated_at,
    version: row.version,
  };
}

// Controllers -------------------------------------------------------------------------------

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('finance')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('destinations/:accountId')
  @RequirePermission('admin:connectors')
  destination(@CurrentPrincipal() principal: Principal, @Param('accountId', ParseUUIDPipe) accountId: string) {
    return this.finance.destination(principal, accountId);
  }

  @Put('destinations/:accountId')
  @RequirePermission('admin:connectors')
  setDestination(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: SetDestinationDto,
  ) {
    return this.finance.setDestination(principal, ctx, accountId, dto);
  }

  @Get('deliveries')
  @RequirePermission('time:lock-period')
  deliveries(
    @CurrentPrincipal() principal: Principal,
    @Query('account_id') accountId?: string,
    @Query('period_id') periodId?: string,
  ) {
    return this.finance.deliveries(principal, { accountId, periodId });
  }

  @Post('deliveries')
  @RequirePermission('time:lock-period')
  deliver(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: DeliverDto) {
    return this.finance.deliverNow(principal, ctx, dto);
  }

  @Post('deliveries/:id/ack')
  @RequirePermission('exports:read')
  acknowledge(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AckDto,
  ) {
    return this.finance.acknowledge(principal, ctx, id, dto);
  }
}

@Module({
  imports: [TicketsCoreModule, TimeCoreModule, StorageCoreModule],
  providers: [FinanceRepository, FinanceService],
  exports: [FinanceService],
})
export class FinanceCoreModule {}

@Module({
  imports: [FinanceCoreModule],
  controllers: [FinanceController],
  exports: [FinanceCoreModule],
})
export class FinanceModule {}
