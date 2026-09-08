import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { GLOBAL_ACCOUNT_ID } from '../../common/auth/principal.repository.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { OBJECT_STORE } from '../../common/storage/storage.module.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import {
  computeMeasures,
  notableTickets,
  previousWeek,
  type Measures,
  type Period,
} from '../../domain/reporting/measures.js';
import { AccountsRepository } from '../admin/accounts/accounts.repository.js';
import { ConfigService } from '../admin/config/config.service.js';
import { translate, type ConditionSet } from '../tickets/conditions.js';
import { TicketsRepository, ticketKey } from '../tickets/tickets.repository.js';
import { TimeRepository } from '../time/time.repository.js';
import { translateEvents, type EventQuery } from './audit-search.js';
import { ReportingRepository } from './reporting.repository.js';
import { neutraliseCell, toCsvRows } from '../../domain/reporting/csv.js';

/**
 * Dashboards, exports, audit search and the basic WSR pack (Dashboards &
 * Report Packs cut per Thirty-Day Build section 5; Audit & Analytics 7.1,
 * 7.2). Measures are computed on the server from fact rows under the
 * caller's binding; the client view is the whitelist; exports and pack
 * downloads write data.export.produced.
 */
const PORTAL_MEASURES = [
  'open_tickets',
  'volume_created',
  'volume_resolved',
  'sla_response_attainment',
  'sla_resolution_attainment',
  'mttr_minutes',
  'backlog_by_age',
  'consumption_minutes',
] as const;

export interface DashboardView {
  period: { start: string; end: string };
  measures: Measures;
  notable: ReturnType<typeof notableTickets>;
  per_account?: {
    account_id: string;
    key: string;
    name: string;
    measures: Pick<
      Measures,
      'open_tickets' | 'breached_now' | 'at_risk_now' | 'unassigned_now' | 'volume_created' | 'volume_resolved'
    >;
  }[];
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reporting: ReportingRepository,
    private readonly tickets: TicketsRepository,
    private readonly time: TimeRepository,
    private readonly accounts: AccountsRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  /** Operations dashboard: every granted account, with a per-account strip. */
  operations(principal: Principal, days = 7): Promise<DashboardView> {
    return this.uow.run(principal, async (tx) => {
      const accountIds = principal.accountIds.filter((id) => id !== GLOBAL_ACCOUNT_ID);
      const now = new Date();
      const period: Period = { start: new Date(now.getTime() - days * 86_400_000), end: now };
      const facts = await this.reporting.ticketFacts(tx, accountIds, period.start);
      const time = await this.reporting.timeFacts(
        tx,
        accountIds,
        iso(period.start),
        iso(now),
        await this.consumingClasses(tx),
      );
      const accounts = await this.accounts.summariesByIds(tx, accountIds);
      const perAccount = accounts.map((account) => {
        const measures = computeMeasures(
          facts.filter((fact) => fact.accountId === account.id),
          time.filter((entry) => entry.accountId === account.id),
          period,
          now,
        );
        return {
          account_id: account.id,
          key: account.key,
          name: account.name,
          measures: {
            open_tickets: measures.open_tickets,
            breached_now: measures.breached_now,
            at_risk_now: measures.at_risk_now,
            unassigned_now: measures.unassigned_now,
            volume_created: measures.volume_created,
            volume_resolved: measures.volume_resolved,
          },
        };
      });
      return {
        period: { start: period.start.toISOString(), end: period.end.toISOString() },
        measures: computeMeasures(facts, time, period, now),
        notable: notableTickets(facts, now, 10),
        per_account: perAccount,
      };
    });
  }

  /** Account dashboard; `asClient` restricts to the portal whitelist (the "View as client" toggle). */
  account(
    principal: Principal,
    accountId: string,
    days = 7,
    asClient = false,
  ): Promise<DashboardView | { period: DashboardView['period']; measures: Partial<Measures> }> {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.run(principal, async (tx) => {
      const now = new Date();
      const period: Period = { start: new Date(now.getTime() - days * 86_400_000), end: now };
      const facts = await this.reporting.ticketFacts(tx, [accountId], period.start);
      const time = await this.reporting.timeFacts(
        tx,
        [accountId],
        iso(period.start),
        iso(now),
        await this.consumingClasses(tx, accountId),
      );
      const measures = computeMeasures(facts, time, period, now);
      const view = {
        period: { start: period.start.toISOString(), end: period.end.toISOString() },
        measures,
        notable: notableTickets(facts, now, 10),
      };
      if (!asClient) return view;
      const settings = await tx.query<{ consumption_visible: boolean }>(
        'select consumption_visible from acct.account_settings where account_id = $1',
        [accountId],
      );
      return {
        period: view.period,
        measures: this.clientMeasures(measures, settings.rows[0]?.consumption_visible ?? false),
      };
    });
  }

  /** The portal's own view of its account. */
  portalDashboard(
    principal: Principal,
    days = 30,
  ): Promise<{ period: DashboardView['period']; measures: Partial<Measures> }> {
    const [accountId] = principal.accountIds;
    return this.uow.run(principal, async (tx) => {
      const now = new Date();
      const period: Period = { start: new Date(now.getTime() - days * 86_400_000), end: now };
      const facts = await this.reporting.ticketFactsPortal(tx, accountId, period.start);
      const settings = await tx
        .query<{ consumption_visible: boolean }>(
          'select consumption_visible from acct.account_settings where account_id = $1',
          [accountId],
        )
        .catch(() => ({ rows: [] as { consumption_visible: boolean }[] }));
      const measures = computeMeasures(facts, [], period, now);
      return {
        period: { start: period.start.toISOString(), end: period.end.toISOString() },
        measures: this.clientMeasures(measures, settings.rows[0]?.consumption_visible ?? false),
      };
    });
  }

  private clientMeasures(measures: Measures, consumptionVisible: boolean): Partial<Measures> {
    const picked: Partial<Measures> = {};
    for (const key of PORTAL_MEASURES) {
      if (key === 'consumption_minutes' && !consumptionVisible) continue;
      (picked as Record<string, unknown>)[key] = measures[key];
    }
    return picked;
  }

  private async consumingClasses(tx: Tx, accountId?: string): Promise<Set<string>> {
    const resolved = await this.config.resolve<{ items: { key: string; consumes_contract?: boolean }[] }>(
      tx,
      'billable_classes',
      '*',
      accountId,
    );
    return new Set(resolved.body.items.filter((item) => item.consumes_contract).map((item) => item.key));
  }

  // Exports -----------------------------------------------------------------

  async exportTickets(
    principal: Principal,
    ctx: RequestContext,
    format: 'xlsx' | 'csv',
    options: { conditions?: ConditionSet; accountIds?: string[] },
  ): Promise<{ fileName: string; contentType: string; body: Buffer; rows: number }> {
    return this.uow.run(principal, async (tx) => {
      const accountIds = (options.accountIds?.length ? options.accountIds : principal.accountIds).filter(
        (id) => principal.accountIds.includes(id) && id !== GLOBAL_ACCOUNT_ID,
      );
      const page = await this.tickets.list(
        tx,
        {
          accountIds,
          conditions: options.conditions
            ? (offset) => translate(options.conditions!, { userId: principal.userId }, offset)
            : undefined,
        },
        { limit: 5000, sort: 'updated_desc' },
      );
      const accounts = new Map(
        (await this.accounts.summariesByIds(tx, accountIds)).map((account) => [account.id, account]),
      );
      const columns = [
        'key',
        'account',
        'type',
        'state',
        'priority',
        'short_description',
        'assignee',
        'created_at',
        'updated_at',
        'resolved_at',
        'response_breached',
        'resolution_breached',
      ];
      const rows = page.rows.map((row) => [
        ticketKey(row.number),
        accounts.get(row.account_id)?.key ?? '',
        row.type,
        row.state,
        row.priority,
        row.short_description,
        row.assignee_name ?? '',
        row.created_at,
        row.updated_at,
        row.resolved_at ?? '',
        row.sla_response_breached,
        row.sla_resolution_breached,
      ]);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      let body: Buffer;
      if (format === 'csv') {
        body = Buffer.from(toCsvRows(columns, rows), 'utf8');
      } else {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Tickets');
        sheet.addRow(columns);
        for (const row of rows) sheet.addRow(row.map(neutraliseCell));
        sheet.getRow(1).font = { bold: true };
        body = Buffer.from(await workbook.xlsx.writeBuffer());
      }
      const checksum = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
      await this.security.write({
        type: 'data.export.produced',
        outcome: 'success',
        actorKind: 'user',
        actorId: principal.userId,
        actorName: principal.displayName,
        principalKind: principal.kind,
        requestId: ctx.requestId,
        attrs: { kind: 'tickets', format, rows: rows.length, checksum, accounts: accountIds.length },
      });
      return {
        fileName: `tickets-${stamp}.${format}`,
        contentType:
          format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body,
        rows: rows.length,
      };
    });
  }

  // Audit search ------------------------------------------------------------

  async searchEvents(
    principal: Principal,
    ctx: RequestContext,
    query: EventQuery,
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    return this.uow.run(principal, async (tx) => {
      const limit = Math.min(query.limit ?? 100, 500);
      const translated = translateEvents(query, 0);
      const values = [...translated.values];
      // The grant clause, not the conditions, decides which accounts are
      // readable. Two of the four tables behind rpt.events_v carry forced
      // row-level security and the binding filters them already;
      // sys.security_events is an operator table with no policy of its own,
      // so without this an audit:read holder bound to one account would
      // read another account's security rows. Rows with no account (the
      // operator audit stream and the portfolio-wide security events) stay
      // visible: that is the operator scope the permission grants.
      values.push(principal.accountIds);
      const grantClause = ` and (account_id is null or account_id = any ($${values.length}::uuid[]))`;
      let cursorClause = '';
      if (query.cursor) {
        const parsed = decodeCursor(query.cursor);
        values.push(parsed.occurredAt, parsed.id);
        cursorClause = ` and (occurred_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
      }
      values.push(limit + 1);
      const rows = await tx.query<Record<string, unknown>>(
        `select * from rpt.events_v where ${translated.sql}${grantClause}${cursorClause} order by occurred_at desc, id desc limit $${values.length}`,
        values,
      );
      const items = rows.rows.slice(0, limit);
      const last = items[items.length - 1];
      void ctx;
      return {
        items,
        next_cursor: rows.rows.length > limit && last ? encodeCursor(String(last.occurred_at), String(last.id)) : null,
      };
    });
  }

  async exportEvents(
    principal: Principal,
    ctx: RequestContext,
    query: EventQuery,
  ): Promise<{ fileName: string; contentType: string; body: Buffer }> {
    const result = await this.searchEvents(principal, ctx, { ...query, limit: 500 });
    const columns = [
      'stream',
      'occurred_at',
      'event_type',
      'account_id',
      'actor_kind',
      'actor_id',
      'actor_name',
      'principal_kind',
      'request_id',
      'entity_kind',
      'entity_id',
      'outcome',
      'attrs',
    ];
    const body = Buffer.from(
      toCsvRows(
        columns,
        result.items.map((row) => columns.map((column) => row[column])),
      ),
      'utf8',
    );
    await this.security.write({
      type: 'data.export.produced',
      outcome: 'success',
      actorKind: 'user',
      actorId: principal.userId,
      actorName: principal.displayName,
      principalKind: principal.kind,
      requestId: ctx.requestId,
      attrs: { kind: 'events', format: 'csv', rows: result.items.length },
    });
    return {
      fileName: `events-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body,
    };
  }

  securityDashboard(principal: Principal, days = 7) {
    return this.uow.run(principal, async (tx) => ({
      by_type: await this.reporting.securityTiles(tx, days),
      signin_failures: await this.reporting.signinFailures(tx, days),
      isolation_probes: await this.reporting.isolationProbes(tx, days),
    }));
  }

  usageDashboard(principal: Principal, days = 7) {
    return this.uow.run(principal, async (tx) => {
      const tiles = await this.reporting.usageTiles(
        tx,
        principal.accountIds.filter((id) => id !== GLOBAL_ACCOUNT_ID),
        days,
      );
      const grouped: Record<string, { key: string; n: number }[]> = {};
      for (const tile of tiles) (grouped[tile.metric] ??= []).push({ key: tile.key ?? 'unknown', n: tile.n });
      return grouped;
    });
  }

  // Report packs ------------------------------------------------------------

  async generateWsr(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    reference = new Date(),
  ): Promise<{ run_id: string; pack_id: string; download: string }> {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.run(principal, async (tx) => {
      const account = await this.accounts.byId(tx, accountId);
      const period = previousWeek(reference);
      const run = await this.reporting.insertRun(tx, {
        accountId,
        packType: 'wsr',
        periodStart: iso(period.start),
        periodEnd: iso(new Date(period.end.getTime() - 1)),
        requestedBy: principal.userId,
      });
      try {
        const facts = await this.reporting.ticketFacts(tx, [accountId], period.start);
        const time = await this.reporting.timeFacts(
          tx,
          [accountId],
          iso(period.start),
          iso(period.end),
          await this.consumingClasses(tx, accountId),
        );
        const measures = computeMeasures(facts, time, period, reference);
        const notable = notableTickets(facts, reference, 5);
        const narrative = templatedNarrative(account.name, period, measures);
        const pptx = await renderWsr(account.name, period, measures, notable, narrative);
        const key = `accounts/${accountId}/reports/${run.id}/wsr-${iso(period.start)}.pptx`;
        await this.store.putObject(
          key,
          pptx,
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        );
        const pack = await this.reporting.insertPack(tx, {
          accountId,
          runId: run.id,
          periodStart: iso(period.start),
          periodEnd: iso(new Date(period.end.getTime() - 1)),
          measures,
          notable,
          narrative,
          pptxKey: key,
        });
        await this.reporting.finishRun(tx, run.id, pack.id, null);
        await this.audit.account(tx, accountId, actorOf(principal), ctx, [
          {
            entityKind: 'report_pack',
            entityId: pack.id,
            eventType: 'created',
            newValue: { run_id: run.id, period: [iso(period.start), iso(period.end)] },
          },
        ]);
        const download = await this.store.presignDownload(key, {
          fileName: `${account.key}-WSR-${iso(period.start)}.pptx`,
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        });
        await this.security.write(
          {
            type: 'data.export.produced',
            outcome: 'success',
            accountId,
            actorKind: 'user',
            actorId: principal.userId,
            actorName: principal.displayName,
            principalKind: principal.kind,
            requestId: ctx.requestId,
            entityKind: 'report_pack',
            entityId: pack.id,
            attrs: { kind: 'wsr', format: 'pptx' },
          },
          tx,
        );
        return { run_id: run.id, pack_id: pack.id, download };
      } catch (error) {
        await this.reporting.finishRun(tx, run.id, null, (error as Error).message.slice(0, 500));
        throw error;
      }
    });
  }

  /**
   * Builds a WSR pack for a period inside an open transaction: the run row,
   * the frozen measures and notable tickets, the templated narrative, the
   * rendered deck in the object store, the pack row and the audit event.
   * The "generate now" route, the schedule's run-now and the schedule runner
   * share it; the caller decides the actor and the transaction.
   */
  async buildWsr(
    tx: Tx,
    input: {
      accountId: string;
      period: Period;
      requestedBy: string;
      scheduleId?: string | null;
      actor: Parameters<AuditService['account']>[2];
      ctx: Parameters<AuditService['account']>[3];
    },
  ): Promise<{ run_id: string; pack_id: string; pptx_key: string; file_name: string }> {
    const account = await this.accounts.byId(tx, input.accountId);
    const period = input.period;
    const reference = new Date();
    const run = await this.reporting.insertRun(tx, {
      accountId: input.accountId,
      packType: 'wsr',
      periodStart: iso(period.start),
      periodEnd: iso(new Date(period.end.getTime() - 1)),
      requestedBy: input.requestedBy,
    });
    if (input.scheduleId)
      await tx.query('update acct.report_runs set schedule_id = $2 where id = $1', [run.id, input.scheduleId]);
    try {
      const facts = await this.reporting.ticketFacts(tx, [input.accountId], period.start);
      const time = await this.reporting.timeFacts(
        tx,
        [input.accountId],
        iso(period.start),
        iso(period.end),
        await this.consumingClasses(tx, input.accountId),
      );
      const measures = computeMeasures(facts, time, period, reference);
      const notable = notableTickets(facts, reference, 5);
      const narrative = templatedNarrative(account.name, period, measures);
      const pptx = await renderWsr(account.name, period, measures, notable, narrative);
      const key = `accounts/${input.accountId}/reports/${run.id}/wsr-${iso(period.start)}.pptx`;
      await this.store.putObject(
        key,
        pptx,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
      const pack = await this.reporting.insertPack(tx, {
        accountId: input.accountId,
        runId: run.id,
        periodStart: iso(period.start),
        periodEnd: iso(new Date(period.end.getTime() - 1)),
        measures,
        notable,
        narrative,
        pptxKey: key,
      });
      await this.reporting.finishRun(tx, run.id, pack.id, null);
      await this.audit.account(tx, input.accountId, input.actor, input.ctx, [
        {
          entityKind: 'report_pack',
          entityId: pack.id,
          eventType: 'created',
          newValue: {
            run_id: run.id,
            schedule_id: input.scheduleId ?? null,
            period: [iso(period.start), iso(period.end)],
          },
        },
      ]);
      return {
        run_id: run.id,
        pack_id: pack.id,
        pptx_key: key,
        file_name: `${account.key}-WSR-${iso(period.start)}.pptx`,
      };
    } catch (error) {
      await this.reporting.finishRun(tx, run.id, null, (error as Error).message.slice(0, 500));
      throw error;
    }
  }

  runs(principal: Principal, accountId: string) {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.run(principal, (tx) => this.reporting.runs(tx, accountId));
  }

  pack(principal: Principal, ctx: RequestContext, packId: string) {
    return this.uow.run(principal, async (tx) => {
      const pack = await this.reporting.pack(tx, packId);
      const download = pack.pptx_key
        ? await this.store.presignDownload(pack.pptx_key, {
            fileName: `wsr-${pack.period_start}.pptx`,
            contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          })
        : null;
      if (download)
        await this.security.write({
          type: 'data.export.produced',
          outcome: 'success',
          accountId: pack.account_id,
          actorKind: 'user',
          actorId: principal.userId,
          actorName: principal.displayName,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: 'report_pack',
          entityId: pack.id,
          attrs: { kind: 'wsr', format: 'pptx', download: true },
        });
      return { ...pack, download };
    });
  }

  assertPortfolio(principal: Principal): void {
    if (!principal.permissions.has('reports:view-portfolio'))
      throw new ForbiddenException({ code: 'forbidden', permission: 'reports:view-portfolio' });
  }
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ o: occurredAt, i: id })).toString('base64url');
}

function decodeCursor(cursor: string): { occurredAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: string; i: string };
    return { occurredAt: parsed.o, id: parsed.i };
  } catch {
    return { occurredAt: new Date().toISOString(), id: randomUUID() };
  }
}

function templatedNarrative(accountName: string, period: Period, measures: Measures): string {
  const attainment = measures.sla_resolution_attainment.value;
  return [
    `${accountName}: week of ${iso(period.start)}.`,
    `${measures.volume_created} requests were raised and ${measures.volume_resolved} resolved. ${measures.open_tickets} remain open, ${measures.breached_now} past their target and ${measures.at_risk_now} at risk.`,
    attainment === null
      ? 'No resolution targets came due this week.'
      : `Resolution targets were met on ${attainment} percent of the requests that came due.`,
    measures.mttr_minutes === null
      ? ''
      : `Average time to resolve was ${Math.round(measures.mttr_minutes / 60)} hours.`,
    `${Math.round(measures.consumption_minutes / 60)} contract hours were consumed.`,
  ]
    .filter(Boolean)
    .join(' ');
}

async function renderWsr(
  accountName: string,
  period: Period,
  measures: Measures,
  notable: ReturnType<typeof notableTickets>,
  narrative: string,
): Promise<Buffer> {
  // pptxgenjs ships CommonJS; under nodenext the default import may be the module namespace.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Pptx = ((PptxGenJS as unknown as { default?: unknown }).default ?? PptxGenJS) as unknown as new () => any;
  const deck = new Pptx();
  deck.layout = 'LAYOUT_WIDE';
  const navy = '10193A';
  const cover = deck.addSlide();
  cover.background = { color: navy };
  cover.addText('Weekly status report', {
    x: 0.6,
    y: 1.8,
    w: 12,
    h: 1,
    fontSize: 36,
    bold: true,
    color: 'FFFFFF',
    fontFace: 'Calibri',
  });
  cover.addText(`${accountName}   ${iso(period.start)} to ${iso(new Date(period.end.getTime() - 1))}`, {
    x: 0.6,
    y: 2.9,
    w: 12,
    h: 0.6,
    fontSize: 18,
    color: 'DCE3F0',
    fontFace: 'Calibri',
  });

  const headline = deck.addSlide();
  headline.addText('Headline', { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 24, bold: true, color: navy });
  headline.addText(narrative, { x: 0.6, y: 1.2, w: 12, h: 3.5, fontSize: 16, color: '0F172A', valign: 'top' });

  const sla = deck.addSlide();
  sla.addText('Service levels', { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 24, bold: true, color: navy });
  const tiles: [string, string][] = [
    ['Open requests', String(measures.open_tickets)],
    ['Past target', String(measures.breached_now)],
    ['At risk', String(measures.at_risk_now)],
    [
      'Response met',
      measures.sla_response_attainment.value === null ? 'n/a' : `${measures.sla_response_attainment.value}%`,
    ],
    [
      'Resolution met',
      measures.sla_resolution_attainment.value === null ? 'n/a' : `${measures.sla_resolution_attainment.value}%`,
    ],
    ['Avg time to resolve', measures.mttr_minutes === null ? 'n/a' : `${Math.round(measures.mttr_minutes / 60)} h`],
  ];
  tiles.forEach(([label, value], index) => {
    const x = 0.6 + (index % 3) * 4.1;
    const y = 1.3 + Math.floor(index / 3) * 2.2;
    sla.addShape(deck.ShapeType.rect, { x, y, w: 3.8, h: 1.8, fill: { color: 'F4F5F7' }, line: { color: 'E2E8F0' } });
    sla.addText(value, { x: x + 0.2, y: y + 0.2, w: 3.4, h: 0.9, fontSize: 32, bold: true, color: navy });
    sla.addText(label, { x: x + 0.2, y: y + 1.1, w: 3.4, h: 0.5, fontSize: 14, color: '475569' });
  });

  const backlog = deck.addSlide();
  backlog.addText('Backlog and notable requests', {
    x: 0.6,
    y: 0.4,
    w: 12,
    h: 0.6,
    fontSize: 24,
    bold: true,
    color: navy,
  });
  const ages = Object.entries(measures.backlog_by_age).map(([bucket, count]) => [
    bucket.replace('_', ' to ').replace('d', ' days').replace('plus', 'or more'),
    String(count),
  ]);
  backlog.addTable(
    [
      [
        { text: 'Age', options: { bold: true } },
        { text: 'Open', options: { bold: true } },
      ],
      ...ages.map((row) => row.map((cell) => ({ text: cell }))),
    ],
    { x: 0.6, y: 1.2, w: 4, colW: [2.6, 1.4], fontSize: 12 },
  );
  const rows = notable.map((row) => [
    row.key,
    row.title.slice(0, 60),
    row.state.replace(/_/g, ' '),
    row.priority.toUpperCase(),
    `${row.age_days} d`,
  ]);
  backlog.addTable(
    [
      ['Key', 'Title', 'State', 'Priority', 'Age'].map((cell) => ({ text: cell, options: { bold: true } })),
      ...rows.map((row) => row.map((cell) => ({ text: cell }))),
    ],
    { x: 5, y: 1.2, w: 7.8, colW: [1.3, 3.5, 1.3, 0.9, 0.8], fontSize: 11 },
  );

  const consumption = deck.addSlide();
  consumption.addText('Consumption', { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 24, bold: true, color: navy });
  consumption.addText(
    `${Math.round(measures.consumption_minutes / 60)} contract hours consumed this week; ${Math.round(measures.time_logged_minutes / 60)} hours logged in total.`,
    { x: 0.6, y: 1.3, w: 12, h: 1, fontSize: 18, color: '0F172A' },
  );

  const output = await deck.write({ outputType: 'nodebuffer' });
  return Buffer.from(output as Buffer);
}
