import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { GLOBAL_ACCOUNT_ID } from '../../common/auth/principal.repository.js';
import { actorOf, AuditService, type AuditEntry } from '../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import {
  validateFieldMap,
  validateStateMap,
  type FieldMap,
  type StateMap,
  type ValidationReport,
} from '../../domain/sync/maps.js';
import { loadEnv } from '../../config/env.js';
import { endpointProblem } from '../../domain/integrations/webhooks.js';
import { fromSnowTime } from './snow-client.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { ConfigService, TICKET_TYPES } from '../admin/config/config.service.js';
import type { StateMachineBody } from '../../domain/tickets/state-machine.js';
import { ConnectorsRepository, type InstanceRow, type MapRow } from './connectors.repository.js';
import { SECRETS_PROVIDER, type SecretsProvider } from './secrets.js';
import { SnowClientFactory } from './snow-client.factory.js';

export interface CreateInstanceInput {
  name: string;
  base_url: string;
  auth_kind: 'basic' | 'oauth_client_credentials';
  credential: { username?: string; password?: string; client_id?: string; client_secret?: string };
  table_name?: string;
  profile?: 'csm' | 'itsm';
  poll_interval_seconds?: number;
}

export interface UpdateInstanceInput {
  version: number;
  name?: string;
  mode?: 'off' | 'ingest_only' | 'bidirectional';
  poll_interval_seconds?: number;
  journal_public?: string;
  sync_work_notes?: boolean;
  attachment_limit_bytes?: number;
  attachment_over_limit?: 'link' | 'skip';
  error_trip_threshold?: { ratio: number; window_minutes: number; min_attempts: number };
  table_name?: string;
}

/**
 * Connector administration (ServiceNow Sync technical section 4; P2.21.2):
 * instances with a credential stored once under a secret name, versioned
 * field and state maps that must validate before activation, the kill
 * switch and the mode, the watermark rewind, runs, dead letters with replay
 * and discard, and health across granted accounts. Every operator intent
 * is an audit event; the switch and the mode raise security events too.
 */
@Injectable()
export class ConnectorsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: ConnectorsRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    private readonly clients: SnowClientFactory,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
  ) {}

  // Instances -----------------------------------------------------------------

  get(principal: Principal, id: string) {
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.instance(tx, id);
      return {
        ...publicView(row),
        account_name: await this.repo.accountName(tx, row.account_id),
        pending_inbox: await this.repo.pendingInboxCount(tx, row.id),
        open_dead_letters: await this.repo.openDeadLetterCount(tx, row.id),
      };
    });
  }

  list(principal: Principal, accountId: string) {
    return this.uow.run(principal, async (tx) => (await this.repo.instances(tx, accountId)).map(publicView));
  }

  async create(principal: Principal, ctx: RequestContext, accountId: string, input: CreateInstanceInput) {
    // The connector framework shares the webhook destination guard: an
    // `admin:connectors` holder must not be able to point a polling worker,
    // and its Authorization header, at an internal service.
    const problem = endpointProblem(input.base_url, loadEnv().WEBHOOK_ALLOW_PRIVATE === 'true');
    if (problem) throw new BadRequestException({ code: 'invalid_endpoint', problem });
    if (input.auth_kind === 'basic' && !(input.credential.username && input.credential.password))
      throw new BadRequestException({ code: 'credential_incomplete', needs: ['username', 'password'] });
    if (
      input.auth_kind === 'oauth_client_credentials' &&
      !(input.credential.client_id && input.credential.client_secret)
    )
      throw new BadRequestException({ code: 'credential_incomplete', needs: ['client_id', 'client_secret'] });
    return this.uow.run(principal, async (tx) => {
      const secretName = `xms/${accountId}/servicenow/${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const row = await this.repo.insertInstance(tx, {
        accountId,
        type: 'servicenow',
        name: input.name,
        baseUrl: input.base_url.replace(/\/+$/, ''),
        authKind: input.auth_kind,
        secretName,
        tableName: input.table_name ?? (input.profile === 'itsm' ? 'incident' : 'sn_customerservice_case'),
        profile: input.profile ?? 'csm',
        pollIntervalSeconds: input.poll_interval_seconds,
      });
      await this.secrets.put(secretName, compact(input.credential));
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'connector_instance',
          entityId: row.id,
          eventType: 'connector.created',
          newValue: {
            name: row.name,
            type: row.type,
            base_url: row.base_url,
            auth_kind: row.auth_kind,
            mode: row.mode,
          },
        },
      ]);
      return publicView(row);
    });
  }

  async update(principal: Principal, ctx: RequestContext, id: string, input: UpdateInstanceInput) {
    return this.uow.run(principal, async (tx) => {
      const before = await this.repo.instance(tx, id);
      const assignments: Record<string, unknown> = {};
      for (const field of [
        'name',
        'mode',
        'poll_interval_seconds',
        'journal_public',
        'sync_work_notes',
        'attachment_limit_bytes',
        'attachment_over_limit',
        'error_trip_threshold',
        'table_name',
      ] as const) {
        if (input[field] !== undefined) assignments[field] = input[field];
      }
      if (input.mode && input.mode !== 'off' && !before.active_field_map_id)
        throw new ConflictException({ code: 'no_active_field_map' });
      if (input.mode === 'bidirectional')
        throw new ConflictException({ code: 'mode_unavailable', detail: 'bidirectional mode ships with Phase 3' });
      if (Object.keys(assignments).length === 0) return publicView(before);
      const after = await this.repo.updateInstance(tx, id, input.version, assignments);
      const entries: AuditEntry[] = Object.keys(assignments).map((field) => ({
        entityKind: 'connector_instance',
        entityId: id,
        eventType: field === 'mode' ? 'connector.mode_changed' : 'connector.updated',
        field,
        oldValue: before[field as keyof InstanceRow] ?? null,
        newValue: after[field as keyof InstanceRow] ?? null,
      }));
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, entries);
      if (input.mode && input.mode !== before.mode) {
        await this.security.write(
          {
            type: 'admin.connector.mode_changed',
            outcome: 'success',
            accountId: before.account_id,
            actorKind: 'user',
            actorId: principal.userId,
            actorName: principal.displayName,
            principalKind: principal.kind,
            requestId: ctx.requestId,
            entityKind: 'connector_instance',
            entityId: id,
            attrs: { from: before.mode, to: input.mode, name: before.name },
          },
          tx,
        );
      }
      return publicView(after);
    });
  }

  async testConnection(principal: Principal, id: string) {
    const instance = await this.uow.run(principal, (tx) => this.repo.instance(tx, id));
    const started = Date.now();
    try {
      const client = await this.clients.forInstance(instance);
      const dictionary = await client.dictionary(instance.table_name);
      await this.uow.run(principal, (tx) =>
        this.repo.touchInstance(tx, id, { credential_state: 'valid', last_error: null }),
      );
      return { ok: true, fields: dictionary.length, latency_ms: Date.now() - started };
    } catch (error) {
      const detail = (error as Error).message;
      await this.uow.run(principal, (tx) =>
        this.repo.touchInstance(tx, id, {
          credential_state: /401|403|invalid_client/.test(detail) ? 'invalid' : instance.credential_state,
          last_error: detail,
          last_error_at: new Date(),
        }),
      );
      return { ok: false, error: detail, latency_ms: Date.now() - started };
    }
  }

  /** Five recent records and the dictionary; stored on a draft field map when one is named. */
  async samples(principal: Principal, id: string, mapId?: string) {
    const instance = await this.uow.run(principal, (tx) => this.repo.instance(tx, id));
    const client = await this.clients.forInstance(instance);
    const [records, dictionary] = [
      await client.recent(instance.table_name, 5),
      await client.dictionary(instance.table_name),
    ];
    if (mapId) {
      await this.uow.run(principal, async (tx) => {
        const map = await this.repo.map<FieldMap>(tx, 'field', mapId);
        if (map.instance_id !== id) throw new NotFoundException({ code: 'not_found', entity: 'field_map' });
        if (map.state !== 'draft' && map.state !== 'validated')
          throw new ConflictException({ code: 'map_not_draft', state: map.state });
        await this.repo.updateMap(tx, 'field', mapId, { samples: records });
      });
    }
    return { records, dictionary };
  }

  // Maps ------------------------------------------------------------------------

  maps(principal: Principal, kind: 'field' | 'state', instanceId: string) {
    return this.uow.run(principal, (tx) => this.repo.maps(tx, kind, instanceId));
  }

  createMap(principal: Principal, ctx: RequestContext, kind: 'field' | 'state', instanceId: string, entries: unknown) {
    return this.uow.run(principal, async (tx) => {
      const instance = await this.repo.instance(tx, instanceId);
      const row = await this.repo.insertMap(tx, kind, {
        accountId: instance.account_id,
        instanceId,
        entries: entries ?? (kind === 'field' ? [] : {}),
        createdBy: principal.userId,
      });
      await this.audit.account(tx, instance.account_id, actorOf(principal), ctx, [
        {
          entityKind: `${kind}_map`,
          entityId: row.id,
          eventType: 'created',
          newValue: { version: row.version, instance_id: instanceId },
        },
      ]);
      return row;
    });
  }

  updateMap(principal: Principal, kind: 'field' | 'state', instanceId: string, mapId: string, entries: unknown) {
    return this.uow.run(principal, async (tx) => {
      const map = await this.repo.map(tx, kind, mapId);
      if (map.instance_id !== instanceId) throw new NotFoundException({ code: 'not_found', entity: `${kind}_map` });
      if (map.state === 'active' || map.state === 'retired')
        throw new ConflictException({ code: 'map_immutable', state: map.state });
      await this.repo.updateMap(tx, kind, mapId, { entries, state: 'draft', validation_report: null });
      return this.repo.map(tx, kind, mapId);
    });
  }

  async validateMap(principal: Principal, kind: 'field' | 'state', instanceId: string, mapId: string) {
    const { instance, map } = await this.uow.run(principal, async (tx) => {
      const instance = await this.repo.instance(tx, instanceId);
      const map = await this.repo.map<unknown>(tx, kind, mapId);
      if (map.instance_id !== instanceId) throw new NotFoundException({ code: 'not_found', entity: `${kind}_map` });
      if (map.state === 'active' || map.state === 'retired')
        throw new ConflictException({ code: 'map_immutable', state: map.state });
      return { instance, map };
    });
    let report: ValidationReport;
    if (kind === 'field') {
      const fieldMap = coerceFieldMap(map.entries);
      let dictionary: { name: string; mandatory?: boolean }[] = [];
      try {
        dictionary = await (await this.clients.forInstance(instance)).dictionary(instance.table_name);
      } catch (error) {
        report = {
          ok: false,
          problems: [`dictionary unavailable: ${(error as Error).message}`],
          warnings: [],
          checked_samples: 0,
        };
        await this.uow.run(principal, (tx) => this.repo.updateMap(tx, kind, mapId, { validation_report: report }));
        return report;
      }
      const samples = ((map as MapRow<unknown>).samples ?? []) as Record<string, unknown>[];
      report = validateFieldMap(fieldMap, dictionary, samples);
    } else {
      const stateMap = (map.entries ?? {}) as StateMap;
      const machines = await this.uow.run(principal, async (tx) => this.machineStates(tx, instance.account_id));
      const externalStates = Object.values(stateMap).flatMap((entry) => Object.keys(entry.inbound ?? {}));
      report = validateStateMap(stateMap, [...new Set(externalStates)], machines);
    }
    await this.uow.run(principal, (tx) =>
      this.repo.updateMap(tx, kind, mapId, { validation_report: report, state: report.ok ? 'validated' : 'draft' }),
    );
    return report;
  }

  activateMap(principal: Principal, ctx: RequestContext, kind: 'field' | 'state', instanceId: string, mapId: string) {
    return this.uow.run(principal, async (tx) => {
      const instance = await this.repo.instance(tx, instanceId);
      const map = await this.repo.map(tx, kind, mapId);
      if (map.instance_id !== instanceId) throw new NotFoundException({ code: 'not_found', entity: `${kind}_map` });
      if (map.state !== 'validated') throw new ConflictException({ code: 'map_not_validated', state: map.state });
      const previous = await this.repo.activeMap(tx, kind, instanceId);
      await this.repo.activateMap(tx, kind, instanceId, mapId, principal.userId);
      await this.repo.updateInstance(tx, instanceId, instance.version, {
        [kind === 'field' ? 'active_field_map_id' : 'active_state_map_id']: mapId,
      });
      await this.audit.account(tx, instance.account_id, actorOf(principal), ctx, [
        {
          entityKind: `${kind}_map`,
          entityId: mapId,
          eventType: 'connector.map.activated',
          oldValue: previous ? { id: previous.id, version: previous.version } : null,
          newValue: { id: mapId, version: map.version, instance_id: instanceId },
        },
      ]);
      return this.repo.map(tx, kind, mapId);
    });
  }

  // Kill switch and watermark ---------------------------------------------------

  killSwitch(principal: Principal, ctx: RequestContext, id: string, action: 'trip' | 'arm', reason: string) {
    return this.uow.run(principal, async (tx) => {
      const before = await this.repo.instance(tx, id);
      const tripped = action === 'trip';
      if ((before.kill_switch === 'tripped') === tripped) return publicView(before);
      const after = await this.repo.updateInstance(tx, id, before.version, {
        kill_switch: tripped ? 'tripped' : 'armed',
        trip_reason: tripped ? reason : null,
        tripped_at: tripped ? new Date() : null,
        tripped_by: tripped ? principal.userId : null,
        health: tripped ? 'tripped' : 'healthy',
        next_poll_at: new Date(),
      });
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'connector_instance',
          entityId: id,
          eventType: 'connector.kill_switch',
          field: 'kill_switch',
          oldValue: before.kill_switch,
          newValue: { state: after.kill_switch, reason },
        },
      ]);
      await this.security.write(
        {
          type: 'admin.connector.kill_switch',
          outcome: 'success',
          accountId: before.account_id,
          actorKind: 'user',
          actorId: principal.userId,
          actorName: principal.displayName,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: 'connector_instance',
          entityId: id,
          attrs: { action, reason, name: before.name },
        },
        tx,
      );
      return publicView(after);
    });
  }

  async watermark(principal: Principal, ctx: RequestContext, id: string, input: { to: string; preview?: boolean }) {
    const to = new Date(input.to);
    if (Number.isNaN(to.getTime())) throw new BadRequestException({ code: 'bad_watermark' });
    const instance = await this.uow.run(principal, (tx) => this.repo.instance(tx, id));
    const client = await this.clients.forInstance(instance);
    const affected = (await client.changedSince(instance.table_name, to, null, 1000)).length;
    if (input.preview) return { preview: true, to: to.toISOString(), records: affected };
    await this.uow.run(principal, async (tx) => {
      await this.repo.updateInstance(tx, id, instance.version, {
        inbound_watermark: to,
        inbound_watermark_sys_id: null,
        next_poll_at: new Date(),
      });
      await this.audit.account(tx, instance.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'connector_instance',
          entityId: id,
          eventType: 'connector.watermark_rewound',
          field: 'inbound_watermark',
          oldValue: instance.inbound_watermark,
          newValue: to.toISOString(),
        },
      ]);
    });
    return { preview: false, to: to.toISOString(), records: affected };
  }

  // Runs, dead letters, health ------------------------------------------------

  runs(
    principal: Principal,
    id: string,
    filter: { direction?: string; outcome?: string; from?: string; to?: string; limit?: number },
  ) {
    return this.uow.run(principal, async (tx) => {
      await this.repo.instance(tx, id);
      return this.repo.runs(tx, id, {
        direction: filter.direction,
        outcome: filter.outcome,
        from: filter.from ? new Date(filter.from) : undefined,
        to: filter.to ? new Date(filter.to) : undefined,
        limit: filter.limit,
      });
    });
  }

  deadLetters(principal: Principal, id: string, resolution?: string) {
    return this.uow.run(principal, async (tx) => {
      await this.repo.instance(tx, id);
      return this.repo.deadLetters(tx, id, resolution);
    });
  }

  resolveDeadLetters(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    ids: string[],
    action: 'replay' | 'discard',
    reason: string | null,
  ) {
    return this.uow.run(principal, async (tx) => {
      const instance = await this.repo.instance(tx, id);
      const results: { id: string; outcome: string }[] = [];
      for (const letterId of ids) {
        const letter = await this.repo.deadLetter(tx, letterId);
        if (letter.payload.instance_id !== id)
          throw new NotFoundException({ code: 'not_found', entity: 'dead_letter' });
        if (letter.resolution !== 'open') {
          results.push({ id: letterId, outcome: `already_${letter.resolution}` });
          continue;
        }
        if (action === 'replay') {
          if (letter.queue === 'inbox' && letter.payload.inbox_id)
            await this.repo.reopenInbox(tx, String(letter.payload.inbox_id));
          else if (letter.queue === 'outbox' && letter.payload.outbox_id)
            await tx.query(
              'update sys.outbox set dispatched_at = null, attempts = 0, last_error = null where id = $1',
              [letter.payload.outbox_id],
            );
        }
        await this.repo.resolveDeadLetter(
          tx,
          letterId,
          action === 'replay' ? 'replayed' : 'discarded',
          principal.userId,
          reason,
        );
        results.push({ id: letterId, outcome: action === 'replay' ? 'replayed' : 'discarded' });
      }
      await this.audit.account(
        tx,
        instance.account_id,
        actorOf(principal),
        ctx,
        results
          .filter((result) => result.outcome === 'replayed' || result.outcome === 'discarded')
          .map((result) => ({
            entityKind: 'dead_letter',
            entityId: result.id,
            eventType: action === 'replay' ? 'connector.dead_letter.replayed' : 'connector.dead_letter.discarded',
            newValue: { instance_id: id, reason },
          })),
      );
      return { results };
    });
  }

  health(principal: Principal) {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.repo.allInstances(tx);
      const result = [];
      for (const row of rows) {
        if (row.account_id === GLOBAL_ACCOUNT_ID) continue;
        result.push({
          ...publicView(row),
          account_name: await this.repo.accountName(tx, row.account_id),
          pending_inbox: await this.repo.pendingInboxCount(tx, row.id),
          open_dead_letters: await this.repo.openDeadLetterCount(tx, row.id),
          inbound_lag_seconds: Math.max(0, Math.round((Date.now() - new Date(row.inbound_watermark).getTime()) / 1000)),
        });
      }
      return result;
    });
  }

  ticketSync(principal: Principal, ticketId: string) {
    return this.uow.run(principal, async (tx) => ({
      links: await this.repo.linksOfTicket(tx, ticketId),
      runs: await this.repo.runsOfTicket(tx, ticketId),
    }));
  }

  /** The state keys per ticket type for the account, for state map validation and apply. */
  async machineStates(tx: Tx, accountId: string): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const type of TICKET_TYPES) {
      const resolved = await this.config.resolve<StateMachineBody>(tx, 'state_machine', type, accountId);
      result[type] = resolved.body.states.map((state) => state.key);
    }
    return result;
  }
}

export function publicView(
  row: InstanceRow,
): Omit<InstanceRow, 'credential_secret_name' | 'webhook_secret_name'> & { has_credential: boolean } {
  const { credential_secret_name: _secret, webhook_secret_name: _webhook, ...rest } = row;
  return { ...rest, has_credential: true };
}

export function coerceFieldMap(entries: unknown): FieldMap {
  return { entries: Array.isArray(entries) ? (entries as FieldMap['entries']) : [] };
}

function compact(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => typeof value === 'string' && value.length > 0),
  ) as Record<string, string>;
}

export { fromSnowTime };
