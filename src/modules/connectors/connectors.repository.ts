import { Injectable } from '@nestjs/common';
import type { ValidationReport } from '../../domain/sync/maps.js';
import { RepositoryBase, type Tx, quoteIdent } from '../../db/repository.base.js';

export interface InstanceRow {
  id: string;
  account_id: string;
  type: string;
  name: string;
  base_url: string;
  auth_kind: 'oauth_client_credentials' | 'basic';
  credential_secret_name: string;
  credential_state: 'unknown' | 'valid' | 'invalid';
  table_name: string;
  profile: 'csm' | 'itsm';
  mode: 'off' | 'ingest_only' | 'bidirectional';
  kill_switch: 'armed' | 'tripped';
  trip_reason: string | null;
  tripped_at: string | null;
  tripped_by: string | null;
  poll_interval_seconds: number;
  next_poll_at: string;
  inbound_watermark: string;
  inbound_watermark_sys_id: string | null;
  webhook_secret_name: string | null;
  active_field_map_id: string | null;
  active_state_map_id: string | null;
  journal_public: string;
  sync_work_notes: boolean;
  attachment_limit_bytes: number;
  attachment_over_limit: 'link' | 'skip';
  error_trip_threshold: { ratio: number; window_minutes: number; min_attempts: number };
  clock_tolerance_seconds: number;
  health: 'healthy' | 'degraded' | 'failing' | 'tripped';
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MapRow<T> {
  id: string;
  account_id: string;
  instance_id: string;
  version: number;
  state: 'draft' | 'validated' | 'active' | 'retired';
  entries: T;
  validation_report: ValidationReport | null;
  samples?: unknown[] | null;
  created_by: string;
  created_at: string;
  activated_at: string | null;
  activated_by: string | null;
}

export interface LinkRow {
  id: string;
  account_id: string;
  instance_id: string;
  ticket_id: string;
  external_sys_id: string;
  external_number: string;
  state: 'linked' | 'pending_external' | 'pending_xms' | 'conflict' | 'unlinked';
  last_outbound_at: string | null;
  last_outbound_hash: string | null;
  last_inbound_at: string | null;
  last_inbound_sys_updated_on: string | null;
  field_sor_overrides: Record<string, string> | null;
  last_conflict: Record<string, unknown> | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RunInput {
  accountId: string;
  instanceId: string;
  direction: 'in' | 'out' | 'poll' | 'webhook';
  ticketId?: string | null;
  externalSysId?: string | null;
  outboxId?: string | null;
  inboxId?: string | null;
  attempt?: number;
  outcome: 'success' | 'retried' | 'dead_lettered' | 'skipped_reflection' | 'skipped_policy' | 'skipped_mode' | 'noop';
  errorClass?: 'retryable' | 'terminal' | null;
  errorText?: string | null;
  durationMs?: number | null;
  detail?: Record<string, unknown> | null;
}

export interface InboxRow {
  id: string;
  connector_instance_id: string;
  external_id: string;
  external_version: string;
  account_id: string | null;
  payload: Record<string, unknown>;
  received_at: string;
  applied_at: string | null;
  outcome: string | null;
  error: string | null;
  attempts: number;
}

export interface DeadLetterRow {
  id: string;
  queue: string;
  account_id: string | null;
  correlation_id: string | null;
  payload: Record<string, unknown>;
  error: string;
  attempts: number;
  first_failed_at: string;
  last_failed_at: string;
  resolution: 'open' | 'replayed' | 'discarded';
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
}

/** The inbox key for an instance: the framework namespaces instances by type. */
export function inboxKey(instanceId: string): string {
  return `servicenow:${instanceId}`;
}

/**
 * SQL for the connector framework tables (ServiceNow Sync technical section
 * 2). Account-scoped rows run under the caller's binding; the inbox and the
 * dead letters are operator tables in `sys` and are filtered here by the
 * instance the caller may see.
 */
@Injectable()
export class ConnectorsRepository extends RepositoryBase {
  // Instances -----------------------------------------------------------------

  instances(tx: Tx, accountId: string): Promise<InstanceRow[]> {
    return this.many(tx, 'select * from acct.connector_instances where account_id = $1 order by name', [accountId]);
  }

  accountName(tx: Tx, accountId: string): Promise<string> {
    return this.maybeOne<{ name: string }>(tx, 'select name from op.accounts where id = $1', [accountId]).then(
      (row) => row?.name ?? '',
    );
  }

  allInstances(tx: Tx): Promise<InstanceRow[]> {
    return this.many(tx, 'select * from acct.connector_instances order by account_id, name');
  }

  instance(tx: Tx, id: string): Promise<InstanceRow> {
    return this.one(tx, 'connector_instance', 'select * from acct.connector_instances where id = $1', [id]);
  }

  insertInstance(
    tx: Tx,
    input: {
      accountId: string;
      type: string;
      name: string;
      baseUrl: string;
      authKind: string;
      secretName: string;
      tableName: string;
      profile: string;
      pollIntervalSeconds?: number;
    },
  ): Promise<InstanceRow> {
    return this.one(
      tx,
      'connector_instance',
      `insert into acct.connector_instances (account_id, type, name, base_url, auth_kind, credential_secret_name, table_name, profile, poll_interval_seconds)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        input.accountId,
        input.type,
        input.name,
        input.baseUrl,
        input.authKind,
        input.secretName,
        input.tableName,
        input.profile,
        input.pollIntervalSeconds ?? 60,
      ],
    );
  }

  updateInstance(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<InstanceRow> {
    const values = { ...assignments };
    if ('error_trip_threshold' in values) values.error_trip_threshold = JSON.stringify(values.error_trip_threshold);
    return this.updateVersioned(tx, 'connector_instance', 'acct.connector_instances', id, version, values);
  }

  /** Worker-side state changes that carry no user intent (health, watermark, errors); no version bump. */
  async touchInstance(tx: Tx, id: string, assignments: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(assignments);
    if (keys.length === 0) return;
    const sets = keys.map((key, index) => `${quoteIdent(key)} = $${index + 2}`).join(', ');
    await tx.query(`update acct.connector_instances set ${sets} where id = $1`, [
      id,
      ...keys.map((key) => assignments[key]),
    ]);
  }

  /** Claims instances due for a poll; the caller holds the transaction for the duration of the poll. */
  claimDue(tx: Tx, limit = 10): Promise<InstanceRow[]> {
    return this.many(
      tx,
      `select * from acct.connector_instances
        where mode <> 'off' and kill_switch = 'armed' and next_poll_at <= now()
        order by next_poll_at limit $1 for update skip locked`,
      [limit],
    );
  }

  // Maps ------------------------------------------------------------------------

  private table(kind: 'field' | 'state'): string {
    return kind === 'field' ? 'acct.field_maps' : 'acct.state_maps';
  }

  maps<T>(tx: Tx, kind: 'field' | 'state', instanceId: string): Promise<MapRow<T>[]> {
    return this.many(tx, `select * from ${this.table(kind)} where instance_id = $1 order by version desc`, [
      instanceId,
    ]);
  }

  map<T>(tx: Tx, kind: 'field' | 'state', id: string): Promise<MapRow<T>> {
    return this.one(tx, `${kind}_map`, `select * from ${this.table(kind)} where id = $1`, [id]);
  }

  activeMap<T>(tx: Tx, kind: 'field' | 'state', instanceId: string): Promise<MapRow<T> | undefined> {
    return this.maybeOne(tx, `select * from ${this.table(kind)} where instance_id = $1 and state = 'active'`, [
      instanceId,
    ]);
  }

  async insertMap<T>(
    tx: Tx,
    kind: 'field' | 'state',
    input: { accountId: string; instanceId: string; entries: T; createdBy: string },
  ): Promise<MapRow<T>> {
    const next = await this.maybeOne<{ n: number }>(
      tx,
      `select coalesce(max(version), 0) + 1 as n from ${this.table(kind)} where instance_id = $1`,
      [input.instanceId],
    );
    return this.one(
      tx,
      `${kind}_map`,
      `insert into ${this.table(kind)} (account_id, instance_id, version, entries, created_by) values ($1, $2, $3, $4, $5) returning *`,
      [input.accountId, input.instanceId, next?.n ?? 1, JSON.stringify(input.entries), input.createdBy],
    );
  }

  async updateMap(tx: Tx, kind: 'field' | 'state', id: string, assignments: Record<string, unknown>): Promise<void> {
    const values: Record<string, unknown> = { ...assignments };
    for (const key of ['entries', 'validation_report', 'samples']) {
      if (key in values && values[key] !== null) values[key] = JSON.stringify(values[key]);
    }
    const keys = Object.keys(values);
    if (keys.length === 0) return;
    const sets = keys.map((key, index) => `${quoteIdent(key)} = $${index + 2}`).join(', ');
    await tx.query(`update ${this.table(kind)} set ${sets} where id = $1`, [id, ...keys.map((key) => values[key])]);
  }

  async activateMap(tx: Tx, kind: 'field' | 'state', instanceId: string, id: string, by: string): Promise<void> {
    await tx.query(`update ${this.table(kind)} set state = 'retired' where instance_id = $1 and state = 'active'`, [
      instanceId,
    ]);
    await tx.query(
      `update ${this.table(kind)} set state = 'active', activated_at = now(), activated_by = $2 where id = $1`,
      [id, by],
    );
  }

  // Links -----------------------------------------------------------------------

  linkByExternal(tx: Tx, instanceId: string, sysId: string): Promise<LinkRow | undefined> {
    return this.maybeOne(tx, 'select * from acct.sync_links where instance_id = $1 and external_sys_id = $2', [
      instanceId,
      sysId,
    ]);
  }

  linksOfTicket(
    tx: Tx,
    ticketId: string,
  ): Promise<
    (LinkRow & { instance_name: string; base_url: string; table_name: string; mode: string; health: string })[]
  > {
    return this.many(
      tx,
      `select l.*, i.name as instance_name, i.base_url, i.table_name, i.mode, i.health
         from acct.sync_links l join acct.connector_instances i on i.id = l.instance_id
        where l.ticket_id = $1 order by l.created_at`,
      [ticketId],
    );
  }

  insertLink(
    tx: Tx,
    input: {
      accountId: string;
      instanceId: string;
      ticketId: string;
      sysId: string;
      number: string;
      sysUpdatedOn: Date;
    },
  ): Promise<LinkRow> {
    return this.one(
      tx,
      'sync_link',
      `insert into acct.sync_links (account_id, instance_id, ticket_id, external_sys_id, external_number, last_inbound_at, last_inbound_sys_updated_on)
       values ($1, $2, $3, $4, $5, now(), $6) returning *`,
      [input.accountId, input.instanceId, input.ticketId, input.sysId, input.number, input.sysUpdatedOn],
    );
  }

  async touchLink(tx: Tx, id: string, assignments: Record<string, unknown>): Promise<void> {
    const values: Record<string, unknown> = { ...assignments };
    if ('last_conflict' in values && values.last_conflict !== null)
      values.last_conflict = JSON.stringify(values.last_conflict);
    const keys = Object.keys(values);
    if (keys.length === 0) return;
    const sets = keys.map((key, index) => `${quoteIdent(key)} = $${index + 2}`).join(', ');
    await tx.query(`update acct.sync_links set ${sets} where id = $1`, [id, ...keys.map((key) => values[key])]);
  }

  journalLinkExists(tx: Tx, instanceId: string, externalJournalSysId: string): Promise<boolean> {
    return this.maybeOne(
      tx,
      'select 1 from acct.sync_journal_links where instance_id = $1 and external_journal_sys_id = $2',
      [instanceId, externalJournalSysId],
    ).then((row) => row !== undefined);
  }

  async insertJournalLink(
    tx: Tx,
    input: {
      accountId: string;
      instanceId: string;
      ticketId: string;
      kind: 'comment' | 'work_note';
      xmsId: string;
      externalSysId: string;
      direction: 'in' | 'out';
    },
  ): Promise<void> {
    await tx.query(
      `insert into acct.sync_journal_links (account_id, instance_id, ticket_id, xms_kind, xms_id, external_journal_sys_id, direction)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
      [
        input.accountId,
        input.instanceId,
        input.ticketId,
        input.kind,
        input.xmsId,
        input.externalSysId,
        input.direction,
      ],
    );
  }

  // Runs --------------------------------------------------------------------------

  async insertRun(tx: Tx, input: RunInput): Promise<void> {
    await tx.query(
      `insert into acct.sync_runs (account_id, instance_id, direction, ticket_id, external_sys_id, outbox_id, inbox_id, attempt, outcome, error_class, error_text, duration_ms, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.accountId,
        input.instanceId,
        input.direction,
        input.ticketId ?? null,
        input.externalSysId ?? null,
        input.outboxId ?? null,
        input.inboxId ?? null,
        input.attempt ?? 1,
        input.outcome,
        input.errorClass ?? null,
        input.errorText ?? null,
        input.durationMs ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
      ],
    );
  }

  runs(
    tx: Tx,
    instanceId: string,
    filter: { direction?: string; outcome?: string; from?: Date; to?: Date; limit?: number },
  ): Promise<Record<string, unknown>[]> {
    return this.many(
      tx,
      `select r.*, case when t.number is null then null else 'CS' || lpad(t.number::text, 7, '0') end as ticket_key
         from acct.sync_runs r left join acct.tickets t on t.id = r.ticket_id
        where r.instance_id = $1
          and ($2::text is null or r.direction = $2)
          and ($3::text is null or r.outcome = $3)
          and ($4::timestamptz is null or r.created_at >= $4)
          and ($5::timestamptz is null or r.created_at < $5)
        order by r.created_at desc limit $6`,
      [
        instanceId,
        filter.direction ?? null,
        filter.outcome ?? null,
        filter.from ?? null,
        filter.to ?? null,
        Math.min(filter.limit ?? 100, 500),
      ],
    );
  }

  runsOfTicket(tx: Tx, ticketId: string, limit = 20): Promise<Record<string, unknown>[]> {
    return this.many(tx, 'select * from acct.sync_runs where ticket_id = $1 order by created_at desc limit $2', [
      ticketId,
      limit,
    ]);
  }

  /** Attempts and failures in the trip window, for the health job. */
  windowStats(
    tx: Tx,
    instanceId: string,
    windowMinutes: number,
  ): Promise<{ attempts: number; failures: number; last_success_at: string | null }> {
    return this.one(
      tx,
      'sync_runs',
      `select count(*) filter (where outcome in ('success', 'retried', 'dead_lettered'))::int as attempts,
              count(*) filter (where outcome in ('retried', 'dead_lettered'))::int as failures,
              max(created_at) filter (where outcome = 'success') as last_success_at
         from acct.sync_runs where instance_id = $1 and created_at >= now() - ($2::int * interval '1 minute')`,
      [instanceId, windowMinutes],
    );
  }

  // Inbox (sys) -------------------------------------------------------------------

  /** Inserts unless the key exists; returns the new id or undefined for a duplicate. */
  async insertInbox(
    tx: Tx,
    input: {
      instanceId: string;
      externalId: string;
      externalVersion: string;
      accountId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<string | undefined> {
    const row = await this.maybeOne<{ id: string }>(
      tx,
      `insert into sys.inbox (connector_instance_id, external_id, external_version, account_id, payload)
       values ($1, $2, $3, $4, $5) on conflict (connector_instance_id, external_id, external_version) do nothing returning id`,
      [
        inboxKey(input.instanceId),
        input.externalId,
        input.externalVersion,
        input.accountId,
        JSON.stringify(input.payload),
      ],
    );
    return row?.id;
  }

  pendingInbox(tx: Tx, instanceId: string, limit = 50): Promise<InboxRow[]> {
    return this.many(
      tx,
      `select * from sys.inbox where connector_instance_id = $1 and applied_at is null order by id limit $2 for update skip locked`,
      [inboxKey(instanceId), limit],
    );
  }

  pendingInboxCount(tx: Tx, instanceId: string): Promise<number> {
    return this.one<{ n: number }>(
      tx,
      'inbox',
      'select count(*)::int as n from sys.inbox where connector_instance_id = $1 and applied_at is null',
      [inboxKey(instanceId)],
    ).then((row) => row.n);
  }

  async settleInbox(
    tx: Tx,
    id: string,
    outcome: 'applied' | 'dropped_duplicate' | 'dropped_reflection' | 'failed',
    error?: string | null,
  ): Promise<void> {
    await tx.query('update sys.inbox set applied_at = now(), outcome = $2, error = $3 where id = $1', [
      id,
      outcome,
      error ?? null,
    ]);
  }

  async retryInbox(tx: Tx, id: string, error: string): Promise<number> {
    const row = await this.one<{ attempts: number }>(
      tx,
      'inbox',
      'update sys.inbox set attempts = attempts + 1, error = $2 where id = $1 returning attempts',
      [id, error],
    );
    return row.attempts;
  }

  async reopenInbox(tx: Tx, id: string): Promise<void> {
    await tx.query('update sys.inbox set applied_at = null, outcome = null, error = null, attempts = 0 where id = $1', [
      id,
    ]);
  }

  // Dead letters (sys) --------------------------------------------------------------

  async insertDeadLetter(
    tx: Tx,
    input: {
      queue: string;
      accountId: string;
      correlationId?: string | null;
      payload: Record<string, unknown>;
      error: string;
      attempts: number;
    },
  ): Promise<string> {
    const row = await this.one<{ id: string }>(
      tx,
      'dead_letter',
      `insert into sys.dead_letters (queue, account_id, correlation_id, payload, error, attempts) values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        input.queue,
        input.accountId,
        input.correlationId ?? null,
        JSON.stringify(input.payload),
        input.error,
        input.attempts,
      ],
    );
    return row.id;
  }

  deadLetters(tx: Tx, instanceId: string, resolution?: string): Promise<DeadLetterRow[]> {
    return this.many(
      tx,
      `select * from sys.dead_letters where payload->>'instance_id' = $1 and ($2::text is null or resolution = $2) order by last_failed_at desc limit 200`,
      [instanceId, resolution ?? null],
    );
  }

  deadLetter(tx: Tx, id: string): Promise<DeadLetterRow> {
    return this.one(tx, 'dead_letter', 'select * from sys.dead_letters where id = $1', [id]);
  }

  openDeadLetterCount(tx: Tx, instanceId: string): Promise<number> {
    return this.one<{ n: number }>(
      tx,
      'dead_letters',
      `select count(*)::int as n from sys.dead_letters where payload->>'instance_id' = $1 and resolution = 'open'`,
      [instanceId],
    ).then((row) => row.n);
  }

  async resolveDeadLetter(
    tx: Tx,
    id: string,
    resolution: 'replayed' | 'discarded',
    by: string,
    reason: string | null,
  ): Promise<void> {
    await tx.query(
      `update sys.dead_letters set resolution = $2, resolved_by = $3, resolved_at = now(), resolution_reason = $4 where id = $1 and resolution = 'open'`,
      [id, resolution, by, reason],
    );
  }
}
