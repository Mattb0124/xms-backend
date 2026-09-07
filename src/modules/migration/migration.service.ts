import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { OBJECT_STORE } from '../../common/storage/storage.module.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import { translateInbound, type StateMap } from '../../domain/sync/maps.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { coerceFieldMap } from '../connectors/connectors.service.js';
import { ConnectorsRepository, type InstanceRow } from '../connectors/connectors.repository.js';
import { fromSnowTime, type JournalEntry, type SnowClient, type SnowRecord } from '../connectors/snow-client.js';
import { SnowClientFactory } from '../connectors/snow-client.factory.js';
import { syncPrincipal } from '../connectors/sync.worker.js';
import { TicketsService, type TicketView } from '../tickets/tickets.service.js';
import type { CreateTicketDto, PatchTicketDto } from '../tickets/tickets.dto.js';
import { MigrationRepository, type BatchRow, type ReportLine, type ReportRow } from './migration.repository.js';

export interface CreateBatchInput {
  account_id: string;
  instance_id: string;
  object_kind?: 'case';
  opened_from: string;
  opened_to: string;
  dry_run?: boolean;
  supersedes_batch_id?: string;
}

const PAGE = 500;
const MAX_PAGES = 200;

/**
 * The migration rehearsal loop (Data Migration technical section 3; P2.22.1
 * cut): extract cases and their journals from a ServiceNow instance through
 * the connector's client into raw rows in the object store and pending
 * import records; map them through the instance's active field and state
 * maps; load them through the ticket service in import mode (origin import,
 * actor the instance's sync principal, no clocks, no outbox, no
 * notifications, source dates preserved, one `imported` audit event each);
 * reconcile counts per state against the target. Identity is
 * (account, object kind, sys_id) with a source hash: an unchanged row is
 * `skipped`, a changed one `updated`, a new one `loaded`. A dry run stops
 * after mapping and still produces the reconciliation preview.
 */
@Injectable()
export class MigrationService {
  private readonly logger = new Logger(MigrationService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: MigrationRepository,
    private readonly connectors: ConnectorsRepository,
    private readonly clients: SnowClientFactory,
    private readonly tickets: TicketsService,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  // Batches ------------------------------------------------------------------

  list(principal: Principal, filter: { account_id?: string; object_kind?: string; status?: string }) {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.repo.batches(tx, {
        accountId: filter.account_id,
        objectKind: filter.object_kind,
        status: filter.status,
      });
      const names = await this.repo.userNames(
        tx,
        rows.map((row) => row.run_by),
      );
      return rows.map((row) => ({ ...row, run_by_name: row.run_by ? (names.get(row.run_by) ?? null) : null }));
    });
  }

  get(principal: Principal, id: string) {
    return this.uow.run(principal, async (tx) => {
      const batch = await this.repo.batch(tx, id);
      const report = (await this.repo.reportOfBatch(tx, id)) ?? null;
      const names = await this.repo.userNames(tx, [
        batch.run_by,
        report?.signed_by,
        ...(report?.lines.map((line) => line.explained_by) ?? []),
      ]);
      return {
        ...batch,
        run_by_name: batch.run_by ? (names.get(batch.run_by) ?? null) : null,
        report: report ? this.decorateReport(report, batch, names, principal) : null,
      };
    });
  }

  /**
   * Names beside the ids on a report and the four-eyes answer up front:
   * `can_sign` is false for the person who ran the batch, for a signed
   * report, and while a delta is open, so a screen can say why before the
   * request is made (the service still enforces every rule on sign-off).
   */
  private decorateReport(report: ReportRow, batch: BatchRow | null, names: Map<string, string>, principal: Principal) {
    const deltaOpen = report.lines.some((line) => line.status === 'delta_open');
    const ranBatch = batch?.run_by === principal.userId;
    const blocker =
      report.status === 'signed_off'
        ? 'report_signed'
        : ranBatch
          ? 'signer_ran_batch'
          : deltaOpen
            ? 'delta_open'
            : null;
    return {
      ...report,
      signed_by_name: report.signed_by ? (names.get(report.signed_by) ?? null) : null,
      lines: report.lines.map((line) => ({
        ...line,
        explained_by_name: line.explained_by ? (names.get(line.explained_by) ?? null) : null,
      })),
      can_sign: blocker === null,
      sign_blocker: blocker,
    };
  }

  create(principal: Principal, ctx: RequestContext, input: CreateBatchInput) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.opened_from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.opened_to) ||
      input.opened_to < input.opened_from
    )
      throw new BadRequestException({ code: 'bad_range' });
    return this.uow.run(principal, async (tx) => {
      const instance = await this.connectors.instance(tx, input.instance_id);
      if (instance.account_id !== input.account_id)
        throw new NotFoundException({ code: 'not_found', entity: 'connector_instance' });
      if (!instance.active_field_map_id) throw new ConflictException({ code: 'no_active_field_map' });
      const row = await this.repo.insertBatch(tx, {
        accountId: input.account_id,
        objectKind: input.object_kind ?? 'case',
        sourceKind: 'servicenow_table_api',
        sourceRef: { instance_id: instance.id, instance_name: instance.name, table_name: instance.table_name },
        sourceRange: { opened_from: input.opened_from, opened_to: input.opened_to },
        mapVersions: { field_map_id: instance.active_field_map_id, state_map_id: instance.active_state_map_id },
        dryRun: input.dry_run ?? true,
        runBy: principal.userId,
      });
      if (input.supersedes_batch_id)
        await this.repo.touchBatch(tx, row.id, { supersedes_batch_id: input.supersedes_batch_id });
      await this.repo.supersede(tx, input.account_id, row.object_kind, row.source_range, row.id);
      await this.audit.account(tx, input.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'import_batch',
          entityId: row.id,
          eventType: 'migration.batch.created',
          newValue: {
            object_kind: row.object_kind,
            range: row.source_range,
            dry_run: row.dry_run,
            instance: instance.name,
          },
        },
      ]);
      return this.repo.batch(tx, row.id);
    });
  }

  records(principal: Principal, batchId: string, filter: { status?: string; q?: string }) {
    return this.uow.run(principal, async (tx) => {
      await this.repo.batch(tx, batchId);
      return this.repo.records(tx, batchId, filter);
    });
  }

  record(principal: Principal, batchId: string, recordId: string) {
    return this.uow.run(principal, async (tx) => {
      const row = await this.repo.record(tx, batchId, recordId);
      let payload: unknown = null;
      if (row.source_payload_key) {
        try {
          payload = JSON.parse((await this.store.getObject(row.source_payload_key)).toString('utf8'));
        } catch {
          payload = null;
        }
      }
      return { ...row, payload };
    });
  }

  // The pipeline ---------------------------------------------------------------

  /** Runs extract, map, load (unless dry) and reconcile for the batch, in the request; returns the batch with counts. */
  async run(principal: Principal, ctx: RequestContext, id: string) {
    const batch = await this.uow.run(principal, async (tx) => {
      const row = await this.repo.batch(tx, id);
      if (!['draft', 'failed'].includes(row.status))
        throw new ConflictException({ code: 'batch_not_runnable', status: row.status });
      await this.repo.touchBatch(tx, id, {
        status: 'extracting',
        started_at: new Date(),
        finished_at: null,
        error: null,
        run_by: principal.userId,
        log: [],
      });
      await this.audit.account(tx, row.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'import_batch',
          entityId: id,
          eventType: 'migration.batch.run',
          newValue: { dry_run: row.dry_run },
        },
      ]);
      return row;
    });
    try {
      const instance = await this.uow.run(principal, (tx) =>
        this.connectors.instance(tx, String(batch.source_ref.instance_id)),
      );
      const client = await this.clients.forInstance(instance);
      const extracted = await this.extract(principal, batch, instance, client);
      const mapped = await this.map(principal, batch, instance, extracted);
      if (!batch.dry_run) await this.load(principal, batch, instance, mapped);
      await this.reconcile(principal, batch, instance, mapped);
      await this.uow.run(principal, async (tx) => {
        await this.repo.touchBatch(tx, id, {
          status: 'reconciled',
          finished_at: new Date(),
          lease_owner: null,
          lease_until: null,
        });
      });
    } catch (error) {
      const detail = (error as Error).message.slice(0, 500);
      this.logger.error(`batch ${id} failed: ${detail}`);
      await this.uow.run(principal, (tx) =>
        this.repo.touchBatch(tx, id, { status: 'failed', error: detail, finished_at: new Date() }),
      );
    }
    return this.get(principal, id);
  }

  private async extract(principal: Principal, batch: BatchRow, instance: InstanceRow, client: SnowClient) {
    const from = new Date(`${batch.source_range.opened_from}T00:00:00Z`);
    const to = new Date(`${batch.source_range.opened_to}T23:59:59Z`);
    const rows: { record: SnowRecord; journal: JournalEntry[]; key: string; hash: string }[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const records = await client.range(instance.table_name, from, to, offset, PAGE);
      for (const record of records) {
        const journal = await client.journal(record.sys_id, null);
        const key = `accounts/${batch.account_id}/migration/${batch.id}/raw/${record.sys_id}.json`;
        await this.store.putObject(key, JSON.stringify({ record, journal }), 'application/json');
        rows.push({ record, journal, key, hash: sourceHash({ record, journal }) });
      }
      await this.uow.run(principal, (tx) =>
        this.repo.touchBatch(tx, batch.id, {
          checkpoint: { offset: offset + records.length, page },
          counts: { ...batch.counts, extracted: rows.length },
        }),
      );
      if (records.length < PAGE) break;
      offset += PAGE;
    }
    await this.uow.run(principal, async (tx) => {
      await this.repo.touchBatch(tx, batch.id, { status: 'extracted' });
      await this.repo.appendLog(tx, batch.id, `extracted ${rows.length} cases from ${instance.name}`);
    });
    return rows;
  }

  private async map(
    principal: Principal,
    batch: BatchRow,
    instance: InstanceRow,
    rows: { record: SnowRecord; journal: JournalEntry[]; key: string; hash: string }[],
  ) {
    return this.uow.run(principal, async (tx) => {
      await this.repo.touchBatch(tx, batch.id, { status: 'mapping' });
      const fieldMap = coerceFieldMap(
        (await this.connectors.map<unknown>(tx, 'field', String(batch.map_versions.field_map_id))).entries,
      );
      const stateMap = batch.map_versions.state_map_id
        ? (((await this.connectors.map<StateMap>(tx, 'state', String(batch.map_versions.state_map_id))).entries ??
            {}) as StateMap)
        : undefined;
      const mapped: MappedRow[] = [];
      let unmatched = 0;
      for (const row of rows) {
        const translation = translateInbound(fieldMap, row.record);
        const patch = translation.patch;
        const existing = await this.repo.latestTarget(tx, batch.account_id, batch.object_kind, row.record.sys_id);
        const problems: string[] = [];
        if (!patch.short_description) problems.push('short_description unmapped or empty');
        if (!patch.requester_email) problems.push('requester_email unmapped or empty');
        const decision: MappedRow['decision'] =
          problems.length > 0
            ? 'unmatched'
            : !existing
              ? 'load'
              : existing.source_hash === row.hash
                ? 'skip'
                : 'update';
        if (decision === 'unmatched') unmatched += 1;
        mapped.push({ ...row, patch, stateMap, existingTargetId: existing?.target_id ?? null, decision, problems });
        if (batch.dry_run || decision === 'unmatched' || decision === 'skip') {
          await this.repo.insertRecord(tx, {
            accountId: batch.account_id,
            batchId: batch.id,
            objectKind: batch.object_kind,
            sourceId: row.record.sys_id,
            sourceKey: String(row.record.number ?? ''),
            targetTable: existing ? 'acct.tickets' : null,
            targetId: existing?.target_id ?? null,
            status: decision === 'unmatched' ? 'unmatched' : decision === 'skip' ? 'skipped' : 'pending',
            message:
              problems.length > 0
                ? problems.join('; ')
                : decision === 'skip'
                  ? 'unchanged since the last run'
                  : batch.dry_run
                    ? `dry run: would ${decision}`
                    : null,
            sourcePayloadKey: row.key,
            sourceHash: row.hash,
            sourceTimestamp: fromSnowTime(row.record.sys_updated_on),
          });
        }
      }
      const skipped = mapped.filter((row) => row.decision === 'skip').length;
      await this.repo.touchBatch(tx, batch.id, {
        status: 'mapped',
        counts: { ...batch.counts, extracted: rows.length, unmatched, skipped, loaded: 0, updated: 0, errors: 0 },
      });
      await this.repo.appendLog(
        tx,
        batch.id,
        `mapped ${mapped.length}: ${mapped.filter((row) => row.decision === 'load').length} to load, ${mapped.filter((row) => row.decision === 'update').length} to update, ${skipped} unchanged, ${unmatched} unmatched`,
      );
      return mapped;
    });
  }

  private async load(principal: Principal, batch: BatchRow, instance: InstanceRow, mapped: MappedRow[]) {
    await this.uow.run(principal, (tx) => this.repo.touchBatch(tx, batch.id, { status: 'loading' }));
    const actor = syncPrincipal(instance);
    const source = `servicenow:${instance.id}`;
    let loaded = 0;
    let updated = 0;
    let errors = 0;
    for (const row of mapped) {
      if (row.decision !== 'load' && row.decision !== 'update') continue;
      const ctx: RequestContext = { requestId: `import-${batch.id}-${row.record.sys_id}`, origin: 'import' };
      try {
        await this.uow.worker([batch.account_id], async (tx) => {
          let ticket: TicketView;
          const openedAt = fromSnowTime(String(row.record.opened_at ?? row.record.sys_created_on));
          if (row.decision === 'load') {
            const type =
              row.stateMap && Object.keys(row.stateMap).length === 1 ? Object.keys(row.stateMap)[0] : 'incident';
            ticket = (await this.tickets.create(
              actor,
              ctx,
              {
                account_id: batch.account_id,
                type,
                short_description: String(row.patch.short_description).slice(0, 300),
                description: row.patch.description === undefined ? undefined : String(row.patch.description),
                category: row.patch.category === undefined ? undefined : String(row.patch.category),
                impact: row.patch.impact as CreateTicketDto['impact'],
                urgency: row.patch.urgency as CreateTicketDto['urgency'],
                requester_email: String(row.patch.requester_email),
                requester_name: row.patch.requester_name === undefined ? undefined : String(row.patch.requester_name),
                source: 'import',
                created_at: openedAt.toISOString(),
              } as unknown as CreateTicketDto,
              tx,
            )) as TicketView;
            ticket = (await this.tickets.patch(
              actor,
              ctx,
              ticket.id,
              {
                version: ticket.version,
                external_refs: {
                  servicenow: String(row.record.number ?? row.record.sys_id),
                  servicenow_sys_id: row.record.sys_id,
                  source,
                  ...(row.patch.client_reference !== undefined
                    ? { client_reference: String(row.patch.client_reference) }
                    : {}),
                },
              } as PatchTicketDto,
              tx,
            )) as TicketView;
          } else {
            ticket = (await this.tickets.get(actor, row.existingTargetId!, tx)) as TicketView;
          }
          // State through the state map, on import only into reachable targets (closed history lands as closed).
          if (row.stateMap && row.record.state !== undefined) {
            const entry = row.stateMap[ticket.type];
            const target = entry?.inbound[String(pickValue(row.record.state))];
            if (target && target !== ticket.state)
              ticket = await this.tickets.importState(
                actor,
                ctx,
                ticket.id,
                {
                  state: target,
                  at: fromSnowTime(String(row.record.closed_at ?? row.record.resolved_at ?? row.record.sys_updated_on)),
                },
                tx,
              );
          }
          // Journals in source order with their source author and time; work notes only when the instance syncs them.
          const seen = new Set(await this.existingJournalIds(tx, ticket.id));
          for (const entry of row.journal.filter((j) => j.element_id === row.record.sys_id)) {
            if (seen.has(entry.sys_id)) continue;
            const kind =
              entry.element === instance.journal_public
                ? 'comment'
                : entry.element === 'work_notes'
                  ? 'work_note'
                  : undefined;
            if (!kind || (kind === 'work_note' && !instance.sync_work_notes) || !entry.value.trim()) continue;
            const overrides = {
              createdAt: fromSnowTime(entry.sys_created_on),
              authorName: entry.sys_created_by,
              authorKind: kind === 'comment' ? 'portal_user' : 'user',
              operatorResponse: false,
            };
            const created = (
              kind === 'comment'
                ? await this.tickets.addComment(actor, ctx, ticket.id, { body: entry.value }, tx, overrides)
                : await this.tickets.addWorkNote(actor, ctx, ticket.id, { body: entry.value }, tx, overrides)
            ) as { id: string };
            await this.connectors.insertJournalLink(tx, {
              accountId: batch.account_id,
              instanceId: instance.id,
              ticketId: ticket.id,
              kind,
              xmsId: created.id,
              externalSysId: entry.sys_id,
              direction: 'in',
            });
          }
          await this.audit.account(
            tx,
            batch.account_id,
            { kind: 'system', id: 'system:migration', name: 'Migration' },
            ctx,
            [
              {
                entityKind: 'ticket',
                entityId: ticket.id,
                ticketId: ticket.id,
                eventType: 'imported',
                newValue: {
                  batch_id: batch.id,
                  source_timestamp: row.record.sys_updated_on,
                  source_key: row.record.number ?? null,
                  decision: row.decision,
                },
              },
            ],
          );
          await this.repo.insertRecord(tx, {
            accountId: batch.account_id,
            batchId: batch.id,
            objectKind: batch.object_kind,
            sourceId: row.record.sys_id,
            sourceKey: String(row.record.number ?? ''),
            targetTable: 'acct.tickets',
            targetId: ticket.id,
            status: row.decision === 'load' ? 'loaded' : 'updated',
            sourcePayloadKey: row.key,
            sourceHash: row.hash,
            sourceTimestamp: fromSnowTime(row.record.sys_updated_on),
          });
        });
        if (row.decision === 'load') loaded += 1;
        else updated += 1;
      } catch (error) {
        errors += 1;
        const detail = describe(error);
        this.logger.warn(`import ${row.record.sys_id} failed: ${detail}`);
        await this.uow.run(principal, (tx) =>
          this.repo.insertRecord(tx, {
            accountId: batch.account_id,
            batchId: batch.id,
            objectKind: batch.object_kind,
            sourceId: row.record.sys_id,
            sourceKey: String(row.record.number ?? ''),
            status: 'error',
            message: detail,
            sourcePayloadKey: row.key,
            sourceHash: row.hash,
            sourceTimestamp: fromSnowTime(row.record.sys_updated_on),
          }),
        );
      }
    }
    await this.uow.run(principal, async (tx) => {
      const fresh = await this.repo.batch(tx, batch.id);
      await this.repo.touchBatch(tx, batch.id, {
        status: 'loaded',
        counts: { ...fresh.counts, loaded, updated, errors },
      });
      await this.repo.appendLog(tx, batch.id, `loaded ${loaded}, updated ${updated}, errors ${errors}`);
    });
  }

  private async existingJournalIds(tx: Tx, ticketId: string): Promise<string[]> {
    const rows = await tx.query<{ external_journal_sys_id: string }>(
      'select external_journal_sys_id from acct.sync_journal_links where ticket_id = $1',
      [ticketId],
    );
    return rows.rows.map((row) => row.external_journal_sys_id);
  }

  private async reconcile(principal: Principal, batch: BatchRow, instance: InstanceRow, mapped: MappedRow[]) {
    await this.uow.run(principal, async (tx) => {
      await this.repo.touchBatch(tx, batch.id, { status: 'reconciling' });
      const stateMap = mapped[0]?.stateMap;
      const type = stateMap && Object.keys(stateMap).length === 1 ? Object.keys(stateMap)[0] : 'incident';
      const inbound = stateMap?.[type]?.inbound ?? {};
      const sourceByState = new Map<string, number>();
      for (const row of mapped) {
        if (row.decision === 'unmatched') continue;
        const state = inbound[String(pickValue(row.record.state))] ?? 'new';
        sourceByState.set(state, (sourceByState.get(state) ?? 0) + 1);
      }
      const source = `servicenow:${instance.id}`;
      const target = new Map(
        (await this.repo.ticketCountsBySource(tx, batch.account_id, source)).map((row) => [row.state, row.n]),
      );
      const lines: ReportLine[] = [];
      for (const state of new Set([...sourceByState.keys(), ...target.keys()])) {
        const sourceFigure = sourceByState.get(state) ?? 0;
        const targetFigure = batch.dry_run ? sourceFigure : (target.get(state) ?? 0);
        lines.push({
          kind: 'count_by_state',
          subject: state,
          source_figure: sourceFigure,
          target_figure: targetFigure,
          delta: targetFigure - sourceFigure,
          status: targetFigure === sourceFigure ? 'matched' : 'delta_open',
        });
      }
      const sourceComments = mapped
        .filter((row) => row.decision !== 'unmatched')
        .reduce(
          (sum, row) => sum + row.journal.filter((j) => j.element === instance.journal_public && j.value.trim()).length,
          0,
        );
      const targetComments = batch.dry_run
        ? sourceComments
        : await this.repo.commentCountBySource(tx, batch.account_id, source);
      lines.push({
        kind: 'count_by_object',
        subject: 'comments',
        source_figure: sourceComments,
        target_figure: targetComments,
        delta: targetComments - sourceComments,
        status: targetComments === sourceComments ? 'matched' : 'delta_open',
      });
      const existing = await this.repo.reportOfBatch(tx, batch.id);
      if (existing && existing.status !== 'signed_off')
        await this.repo.updateReport(tx, existing.id, existing.version, { lines, status: 'open' });
      else await this.repo.insertReport(tx, { accountId: batch.account_id, scope: 'batch', batchId: batch.id, lines });
      await this.repo.appendLog(
        tx,
        batch.id,
        `reconciled: ${lines.filter((line) => line.status === 'matched').length} of ${lines.length} lines matched`,
      );
    });
  }

  // Reconciliation --------------------------------------------------------------

  reports(principal: Principal, accountId: string, scope?: string) {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.repo.reports(tx, accountId, scope);
      const batches = new Map<string, BatchRow>();
      for (const row of rows)
        if (row.batch_id && !batches.has(row.batch_id))
          batches.set(row.batch_id, await this.repo.batch(tx, row.batch_id));
      const names = await this.repo.userNames(tx, [
        ...rows.map((row) => row.signed_by),
        ...rows.flatMap((row) => row.lines.map((line) => line.explained_by)),
        ...[...batches.values()].map((batch) => batch.run_by),
      ]);
      return rows.map((row) =>
        this.decorateReport(row, row.batch_id ? (batches.get(row.batch_id) ?? null) : null, names, principal),
      );
    });
  }

  explain(
    principal: Principal,
    ctx: RequestContext,
    reportId: string,
    line: number,
    input: { explanation: string; version: number },
  ) {
    return this.uow.run(principal, async (tx) => {
      const report = await this.repo.report(tx, reportId);
      if (report.status === 'signed_off') throw new ConflictException({ code: 'report_signed' });
      if (!report.lines[line]) throw new NotFoundException({ code: 'not_found', entity: 'line' });
      const lines = report.lines.map((row, index) =>
        index === line
          ? {
              ...row,
              explanation: input.explanation,
              explained_by: principal.userId,
              explained_at: new Date().toISOString(),
              status: row.delta === 0 ? 'matched' : 'delta_explained',
            }
          : row,
      ) as ReportLine[];
      const updated = await this.repo.updateReport(tx, reportId, input.version, { lines });
      await this.audit.account(tx, report.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'reconciliation_report',
          entityId: reportId,
          eventType: 'migration.report.explained',
          field: `line:${line}`,
          newValue: { subject: lines[line].subject, explanation: input.explanation },
        },
      ]);
      return updated;
    });
  }

  /** Freezes the report; refused with an open delta or when the signer ran the batch (four-eyes). */
  signOff(principal: Principal, ctx: RequestContext, reportId: string, version: number) {
    return this.uow.run(principal, async (tx) => {
      const report = await this.repo.report(tx, reportId);
      if (report.status === 'signed_off') throw new ConflictException({ code: 'report_signed' });
      if (report.batch_id) {
        const batch = await this.repo.batch(tx, report.batch_id);
        if (batch.run_by === principal.userId) throw new ForbiddenException({ code: 'signer_ran_batch' });
      }
      if (report.lines.some((line) => line.status === 'delta_open'))
        throw new ConflictException({ code: 'delta_open' });
      const snapshotKey = `accounts/${report.account_id}/migration/reports/${reportId}.json`;
      await this.store.putObject(
        snapshotKey,
        JSON.stringify({ ...report, signed_by: principal.userId, signed_at: new Date().toISOString() }),
        'application/json',
      );
      const signed = await this.repo.updateReport(tx, reportId, version, {
        status: 'signed_off',
        signed_by: principal.userId,
        signed_at: new Date(),
        snapshot_key: snapshotKey,
      });
      if (report.batch_id) await this.repo.touchBatch(tx, report.batch_id, { status: 'signed_off' });
      await this.audit.account(tx, report.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'reconciliation_report',
          entityId: reportId,
          eventType: 'migration.report.signed',
          newValue: { lines: report.lines.length, batch_id: report.batch_id },
        },
      ]);
      return signed as ReportRow;
    });
  }
}

interface MappedRow {
  record: SnowRecord;
  journal: JournalEntry[];
  key: string;
  hash: string;
  patch: Record<string, unknown>;
  stateMap: StateMap | undefined;
  existingTargetId: string | null;
  decision: 'load' | 'update' | 'skip' | 'unmatched';
  problems: string[];
}

/** SHA-256 over the normalised row and journal: key order and whitespace do not change it. */
export function sourceHash(payload: { record: Record<string, unknown>; journal: readonly unknown[] }): string {
  const normalise = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalise);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as object)
          .sort()
          .map((key) => [key, normalise((value as Record<string, unknown>)[key])]),
      );
    }
    return typeof value === 'string' ? value.trim() : value;
  };
  return createHash('sha256')
    .update(JSON.stringify(normalise(payload)))
    .digest('hex');
}

function pickValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in (value as object)) return (value as { value: unknown }).value;
  return value;
}

function describe(error: unknown): string {
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException
  ) {
    const response = error.getResponse();
    return typeof response === 'string' ? response : JSON.stringify(response).slice(0, 500);
  }
  return (error as Error).message.slice(0, 500);
}
