import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';

export interface BatchRow {
  id: string;
  account_id: string;
  object_kind: string;
  source_kind: 'servicenow_table_api' | 'servicenow_export_files' | 'finance_workbook';
  source_ref: Record<string, unknown>;
  source_range: Record<string, unknown>;
  map_versions: Record<string, unknown>;
  dry_run: boolean;
  status: string;
  counts: { extracted: number; loaded: number; updated: number; skipped: number; unmatched: number; errors: number };
  checkpoint: Record<string, unknown> | null;
  supersedes_batch_id: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  started_at: string | null;
  finished_at: string | null;
  run_by: string | null;
  error: string | null;
  log: { at: string; message: string }[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RecordRow {
  id: string;
  account_id: string;
  batch_id: string;
  object_kind: string;
  source_id: string;
  source_key: string | null;
  target_table: string | null;
  target_id: string | null;
  status: 'pending' | 'loaded' | 'updated' | 'skipped' | 'unmatched' | 'error';
  message: string | null;
  source_payload_key: string | null;
  source_hash: string;
  source_timestamp: string | null;
  created_at: string;
}

export interface ReportLine {
  kind: 'count_by_state' | 'count_by_object' | 'hours_by_contract_period' | 'balance_by_contract_period';
  subject: string;
  source_figure: number;
  target_figure: number;
  delta: number;
  status: 'matched' | 'delta_explained' | 'delta_open';
  explanation?: string | null;
  explained_by?: string | null;
  explained_at?: string | null;
}

export interface ReportRow {
  id: string;
  account_id: string;
  scope: 'batch' | 'account' | 'delta';
  batch_id: string | null;
  status: 'pending' | 'open' | 'signed_off';
  snapshot_key: string | null;
  signed_by: string | null;
  signed_at: string | null;
  lines: ReportLine[];
  version: number;
  created_at: string;
  updated_at: string;
}

/** SQL for the migration tables (Data Migration technical section 2). Account-scoped; every query runs under the caller's binding. */
@Injectable()
export class MigrationRepository extends RepositoryBase {
  batches(tx: Tx, filter: { accountId?: string; objectKind?: string; status?: string }): Promise<BatchRow[]> {
    return this.many(
      tx,
      `select * from acct.import_batches
        where ($1::uuid is null or account_id = $1) and ($2::text is null or object_kind = $2) and ($3::text is null or status = $3)
        order by created_at desc limit 200`,
      [filter.accountId ?? null, filter.objectKind ?? null, filter.status ?? null],
    );
  }

  batch(tx: Tx, id: string): Promise<BatchRow> {
    return this.one(tx, 'import_batch', 'select * from acct.import_batches where id = $1', [id]);
  }

  insertBatch(
    tx: Tx,
    input: {
      accountId: string;
      objectKind: string;
      sourceKind: string;
      sourceRef: Record<string, unknown>;
      sourceRange: Record<string, unknown>;
      mapVersions: Record<string, unknown>;
      dryRun: boolean;
      runBy: string;
    },
  ): Promise<BatchRow> {
    return this.one(
      tx,
      'import_batch',
      `insert into acct.import_batches (account_id, object_kind, source_kind, source_ref, source_range, map_versions, dry_run, run_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        input.accountId,
        input.objectKind,
        input.sourceKind,
        JSON.stringify(input.sourceRef),
        JSON.stringify(input.sourceRange),
        JSON.stringify(input.mapVersions),
        input.dryRun,
        input.runBy,
      ],
    );
  }

  async touchBatch(tx: Tx, id: string, assignments: Record<string, unknown>): Promise<void> {
    const values: Record<string, unknown> = { ...assignments };
    for (const key of ['counts', 'checkpoint', 'log', 'source_ref', 'map_versions'])
      if (key in values && values[key] !== null) values[key] = JSON.stringify(values[key]);
    const keys = Object.keys(values);
    if (keys.length === 0) return;
    const sets = keys.map((key, index) => `"${key}" = $${index + 2}`).join(', ');
    await tx.query(`update acct.import_batches set ${sets} where id = $1`, [id, ...keys.map((key) => values[key])]);
  }

  async appendLog(tx: Tx, id: string, message: string): Promise<void> {
    await tx.query(`update acct.import_batches set log = log || $2::jsonb where id = $1`, [
      id,
      JSON.stringify([{ at: new Date().toISOString(), message: message.slice(0, 500) }]),
    ]);
  }

  async supersede(
    tx: Tx,
    accountId: string,
    objectKind: string,
    sourceRange: Record<string, unknown>,
    exceptId: string,
  ): Promise<void> {
    await tx.query(
      `update acct.import_batches set status = 'superseded'
        where account_id = $1 and object_kind = $2 and source_range::text = $3::jsonb::text and id <> $4 and status not in ('superseded', 'failed')`,
      [accountId, objectKind, JSON.stringify(sourceRange), exceptId],
    );
  }

  records(tx: Tx, batchId: string, filter: { status?: string; q?: string }, limit = 500): Promise<RecordRow[]> {
    return this.many(
      tx,
      `select * from acct.import_records where batch_id = $1
          and ($2::text is null or status = $2)
          and ($3::text is null or source_id ilike '%' || $3 || '%' or source_key ilike '%' || $3 || '%')
        order by created_at limit $4`,
      [batchId, filter.status ?? null, filter.q ?? null, limit],
    );
  }

  record(tx: Tx, batchId: string, id: string): Promise<RecordRow> {
    return this.one(tx, 'import_record', 'select * from acct.import_records where batch_id = $1 and id = $2', [
      batchId,
      id,
    ]);
  }

  insertRecord(
    tx: Tx,
    input: {
      accountId: string;
      batchId: string;
      objectKind: string;
      sourceId: string;
      sourceKey?: string | null;
      targetTable?: string | null;
      targetId?: string | null;
      status: RecordRow['status'];
      message?: string | null;
      sourcePayloadKey?: string | null;
      sourceHash: string;
      sourceTimestamp?: Date | null;
    },
  ): Promise<RecordRow> {
    return this.one(
      tx,
      'import_record',
      `insert into acct.import_records (account_id, batch_id, object_kind, source_id, source_key, target_table, target_id, status, message, source_payload_key, source_hash, source_timestamp)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [
        input.accountId,
        input.batchId,
        input.objectKind,
        input.sourceId,
        input.sourceKey ?? null,
        input.targetTable ?? null,
        input.targetId ?? null,
        input.status,
        input.message ?? null,
        input.sourcePayloadKey ?? null,
        input.sourceHash,
        input.sourceTimestamp ?? null,
      ],
    );
  }

  /** The latest record with a target for an identity, across batches: the loader's idempotency lookup. */
  latestTarget(tx: Tx, accountId: string, objectKind: string, sourceId: string): Promise<RecordRow | undefined> {
    return this.maybeOne(
      tx,
      `select * from acct.import_records
        where account_id = $1 and object_kind = $2 and source_id = $3 and target_id is not null
        order by created_at desc limit 1`,
      [accountId, objectKind, sourceId],
    );
  }

  reports(tx: Tx, accountId: string, scope?: string): Promise<ReportRow[]> {
    return this.many(
      tx,
      `select * from acct.reconciliation_reports where account_id = $1 and ($2::text is null or scope = $2) order by created_at desc limit 50`,
      [accountId, scope ?? null],
    );
  }

  report(tx: Tx, id: string): Promise<ReportRow> {
    return this.one(tx, 'reconciliation_report', 'select * from acct.reconciliation_reports where id = $1', [id]);
  }

  reportOfBatch(tx: Tx, batchId: string): Promise<ReportRow | undefined> {
    return this.maybeOne(
      tx,
      `select * from acct.reconciliation_reports where batch_id = $1 order by created_at desc limit 1`,
      [batchId],
    );
  }

  insertReport(
    tx: Tx,
    input: { accountId: string; scope: string; batchId: string | null; lines: ReportLine[] },
  ): Promise<ReportRow> {
    return this.one(
      tx,
      'reconciliation_report',
      `insert into acct.reconciliation_reports (account_id, scope, batch_id, lines) values ($1, $2, $3, $4) returning *`,
      [input.accountId, input.scope, input.batchId, JSON.stringify(input.lines)],
    );
  }

  updateReport(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<ReportRow> {
    const values: Record<string, unknown> = { ...assignments };
    if ('lines' in values) values.lines = JSON.stringify(values.lines);
    return this.updateVersioned(tx, 'reconciliation_report', 'acct.reconciliation_reports', id, version, values);
  }

  /** Target counts per state for the reconciliation, scoped to the source the batch imported from. */
  ticketCountsBySource(tx: Tx, accountId: string, source: string): Promise<{ state: string; n: number }[]> {
    return this.many(
      tx,
      `select state, count(*)::int as n from acct.tickets where account_id = $1 and external_refs->>'source' = $2 group by state order by state`,
      [accountId, source],
    );
  }

  commentCountBySource(tx: Tx, accountId: string, source: string): Promise<number> {
    return this.one<{ n: number }>(
      tx,
      'comments',
      `select count(*)::int as n from acct.comments c join acct.tickets t on t.id = c.ticket_id where c.account_id = $1 and c.source = 'import' and t.external_refs->>'source' = $2`,
      [accountId, source],
    ).then((row) => row.n);
  }
}
