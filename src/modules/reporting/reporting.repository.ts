import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import type { TicketFacts, TimeFacts } from '../../domain/reporting/measures.js';

/**
 * Row sets for the measures and the report pack (Dashboards & Report Packs
 * technical 2.7). Every query runs under the caller's binding; the fact
 * projection carries keys, states and timestamps, never free text beyond
 * the short description used in the notable list.
 */
@Injectable()
export class ReportingRepository extends RepositoryBase {
  async ticketFacts(
    tx: Tx,
    accountIds: string[],
    since: Date,
  ): Promise<(TicketFacts & { accountId: string; assigneeId: string | null })[]> {
    const rows = await this.many<Record<string, unknown>>(
      tx,
      `select t.id, t.account_id, t.number, t.type, t.state, t.priority, t.created_at, t.resolved_at, t.closed_at, t.reopen_count,
              t.sla_response_breached, t.sla_resolution_breached, t.assignee_id, t.short_description,
              rc.met_at as response_met_at, sc.met_at as resolution_met_at, sc.due_at as resolution_due_at, sc.target_minutes as resolution_target_minutes, sc.paused_at as resolution_paused_at
         from acct.tickets t
         left join acct.sla_clocks rc on rc.ticket_id = t.id and rc.kind = 'response'
         left join acct.sla_clocks sc on sc.ticket_id = t.id and sc.kind = 'resolution'
        where t.account_id = any ($1::uuid[]) and (t.state not in ('closed', 'cancelled') or t.updated_at >= $2)`,
      [accountIds, since],
    );
    const now = Date.now();
    return rows.map((row) => {
      const dueAt = row.resolution_due_at ? new Date(String(row.resolution_due_at)) : null;
      const remaining = dueAt && !row.resolution_met_at ? Math.floor((dueAt.getTime() - now) / 60_000) : null;
      return {
        id: String(row.id),
        accountId: String(row.account_id),
        key: `CS${String(row.number).padStart(7, '0')}`,
        type: String(row.type),
        state: String(row.state),
        priority: String(row.priority),
        createdAt: new Date(String(row.created_at)),
        resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)) : null,
        closedAt: row.closed_at ? new Date(String(row.closed_at)) : null,
        reopenCount: Number(row.reopen_count),
        responseBreached: Boolean(row.sla_response_breached),
        resolutionBreached: Boolean(row.sla_resolution_breached),
        responseMet: Boolean(row.response_met_at),
        resolutionMet: Boolean(row.resolution_met_at),
        resolutionDueAt: dueAt,
        resolutionRemainingMinutes: row.resolution_paused_at ? null : remaining,
        resolutionTargetMinutes: row.resolution_target_minutes === null ? null : Number(row.resolution_target_minutes),
        shortDescription: String(row.short_description),
        assigneeId: (row.assignee_id as string | null) ?? null,
      };
    });
  }

  /** The portal role reads tickets only (no clocks): breach flags come from the denormalised columns. */
  async ticketFactsPortal(tx: Tx, accountId: string, since: Date): Promise<TicketFacts[]> {
    const rows = await this.many<Record<string, unknown>>(
      tx,
      `select id, number, type, state, priority, created_at, resolved_at, closed_at, reopen_count, sla_response_breached, sla_resolution_breached, first_response_at, short_description
         from acct.tickets where account_id = $1 and (state not in ('closed', 'cancelled') or updated_at >= $2)`,
      [accountId, since],
    );
    return rows.map((row) => ({
      id: String(row.id),
      key: `CS${String(row.number).padStart(7, '0')}`,
      type: String(row.type),
      state: String(row.state),
      priority: String(row.priority),
      createdAt: new Date(String(row.created_at)),
      resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)) : null,
      closedAt: row.closed_at ? new Date(String(row.closed_at)) : null,
      reopenCount: Number(row.reopen_count),
      responseBreached: Boolean(row.sla_response_breached),
      resolutionBreached: Boolean(row.sla_resolution_breached),
      responseMet: Boolean(row.first_response_at) && !row.sla_response_breached,
      resolutionMet: Boolean(row.resolved_at) && !row.sla_resolution_breached,
      resolutionDueAt: null,
      resolutionRemainingMinutes: null,
      resolutionTargetMinutes: null,
      shortDescription: String(row.short_description),
    }));
  }

  async timeFacts(
    tx: Tx,
    accountIds: string[],
    from: string,
    to: string,
    consumingClasses: ReadonlySet<string>,
  ): Promise<(TimeFacts & { accountId: string })[]> {
    const rows = await this.many<{ account_id: string; minutes: number; billable_class: string; performed_on: string }>(
      tx,
      `select account_id, minutes, billable_class, performed_on from acct.time_entries where account_id = any ($1::uuid[]) and performed_on between $2 and $3`,
      [accountIds, from, to],
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      minutes: Number(row.minutes),
      consumesContract: consumingClasses.has(row.billable_class),
      performedOn: row.performed_on,
    }));
  }

  async insertSnapshot(
    tx: Tx,
    accountId: string,
    date: string,
    measure: string,
    grain: Record<string, unknown>,
    value: number,
    numerator: number | null,
    denominator: number | null,
    source: string,
  ): Promise<void> {
    await tx.query(
      `insert into rpt.daily_snapshots (account_id, snapshot_date, measure, grain, value, numerator, denominator, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (account_id, snapshot_date, measure, grain) do nothing`,
      [accountId, date, measure, JSON.stringify(grain), value, numerator, denominator, source],
    );
  }

  series(
    tx: Tx,
    accountId: string,
    measure: string,
    days: number,
  ): Promise<{ snapshot_date: string; value: string; grain: Record<string, unknown> }[]> {
    return this.many(
      tx,
      `select snapshot_date, value, grain from rpt.daily_snapshots where account_id = $1 and measure = $2 and snapshot_date >= current_date - $3::int order by snapshot_date`,
      [accountId, measure, days],
    );
  }

  async lastSnapshotDate(tx: Tx, accountId: string): Promise<string | undefined> {
    const row = await this.maybeOne<{ d: string | null }>(
      tx,
      'select max(snapshot_date)::text as d from rpt.daily_snapshots where account_id = $1',
      [accountId],
    );
    return row?.d ?? undefined;
  }

  // Report runs and packs ---------------------------------------------------

  insertRun(
    tx: Tx,
    input: { accountId: string; packType: string; periodStart: string; periodEnd: string; requestedBy: string },
  ): Promise<{ id: string; version: number }> {
    return this.one(
      tx,
      'report_run',
      `insert into acct.report_runs (account_id, pack_type, period_start, period_end, requested_by, status) values ($1, $2, $3, $4, $5, 'generating') returning id, version`,
      [input.accountId, input.packType, input.periodStart, input.periodEnd, input.requestedBy],
    );
  }

  async finishRun(tx: Tx, id: string, packId: string | null, error: string | null): Promise<void> {
    await tx.query(
      `update acct.report_runs set status = $2, pack_id = $3, error = $4, finished_at = now() where id = $1`,
      [id, error ? 'failed' : 'ready_for_review', packId, error],
    );
  }

  insertPack(
    tx: Tx,
    input: {
      accountId: string;
      runId: string;
      periodStart: string;
      periodEnd: string;
      measures: unknown;
      notable: unknown;
      narrative: string;
      pptxKey: string;
    },
  ): Promise<{ id: string }> {
    return this.one(
      tx,
      'report_pack',
      `insert into acct.report_packs (account_id, run_id, period_start, period_end, measures, notable, narrative_source, narrative_versions, pptx_key)
       values ($1, $2, $3, $4, $5, $6, 'template', $7, $8) returning id`,
      [
        input.accountId,
        input.runId,
        input.periodStart,
        input.periodEnd,
        JSON.stringify(input.measures),
        JSON.stringify(input.notable),
        JSON.stringify([
          {
            version: 1,
            text: input.narrative,
            author_kind: 'template',
            author_id: 'template',
            at: new Date().toISOString(),
          },
        ]),
        input.pptxKey,
      ],
    );
  }

  runs(tx: Tx, accountId: string): Promise<Record<string, unknown>[]> {
    return this.many(
      tx,
      `select r.*, p.id as pack_id_resolved, p.pptx_key from acct.report_runs r left join acct.report_packs p on p.run_id = r.id where r.account_id = $1 order by r.created_at desc limit 50`,
      [accountId],
    );
  }

  pack(
    tx: Tx,
    id: string,
  ): Promise<{
    id: string;
    account_id: string;
    run_id: string;
    period_start: string;
    period_end: string;
    measures: unknown;
    notable: unknown;
    narrative_versions: unknown[];
    pptx_key: string | null;
  }> {
    return this.one(tx, 'report_pack', 'select * from acct.report_packs where id = $1', [id]);
  }

  // Security and usage tiles ----------------------------------------------

  securityTiles(tx: Tx, days: number): Promise<Record<string, unknown>[]> {
    return this.many(
      tx,
      `select event_type, outcome, count(*)::int as n from sys.security_events where occurred_at >= now() - ($1::int * interval '1 day') group by 1, 2 order by 3 desc`,
      [days],
    );
  }

  signinFailures(tx: Tx, days: number): Promise<{ actor_id: string; ip_hash: string | null; n: number }[]> {
    return this.many(
      tx,
      `select actor_id, ip_hash, count(*)::int as n from sys.security_events where event_type = 'auth.signin.failed' and occurred_at >= now() - ($1::int * interval '1 day') group by 1, 2 order by 3 desc limit 20`,
      [days],
    );
  }

  isolationProbes(tx: Tx, days: number): Promise<{ actor_id: string; n: number }[]> {
    return this.many(
      tx,
      `select actor_id, count(*)::int as n from sys.security_events where event_type in ('authz.isolation.filtered', 'authz.account.denied', 'authz.realm.denied') and occurred_at >= now() - ($1::int * interval '1 day') group by 1 order by 2 desc limit 20`,
      [days],
    );
  }

  /**
   * The abuse half of the security stream by kind (`sys.security_events`,
   * the `abuse.*` group of the catalog): rate limits, bad webhook
   * signatures, suspected mail loops, rejected uploads and CSP reports.
   */
  abuseByKind(tx: Tx, days: number): Promise<{ event_type: string; n: number }[]> {
    return this.many(
      tx,
      `select event_type, count(*)::int as n from sys.security_events
        where event_type like 'abuse.%' and occurred_at >= now() - ($1::int * interval '1 day')
        group by 1 order by 2 desc`,
      [days],
    );
  }

  /** Who the rate limiter turned away (`sys.security_events`, `abuse.rate_limited`). */
  rateLimitedClients(tx: Tx, days: number): Promise<{ actor_id: string; principal_kind: string | null; n: number }[]> {
    return this.many(
      tx,
      `select actor_id, principal_kind, count(*)::int as n from sys.security_events
        where event_type = 'abuse.rate_limited' and occurred_at >= now() - ($1::int * interval '1 day')
        group by 1, 2 order by 3 desc limit 20`,
      [days],
    );
  }

  /**
   * What is paused right now rather than what paused during the window:
   * neither `acct.webhook_subscriptions` nor `acct.connector_instances`
   * timestamps the pause, and a subscription that has been off for a month
   * is the more urgent of the two anyway. Both tables are account scoped,
   * so the binding decides which accounts are counted.
   */
  pausedIntegrations(tx: Tx): Promise<{ kind: string; reason: string; n: number }[]> {
    return this.many(
      tx,
      `select 'webhook' as kind, coalesce(paused_reason, 'unstated') as reason, count(*)::int as n
         from acct.webhook_subscriptions where status = 'paused' group by 1, 2
       union all
       select 'connector', coalesce(trip_reason, 'unstated'), count(*)::int
         from acct.connector_instances where kill_switch = 'tripped' group by 1, 2
       order by 3 desc`,
    );
  }

  /** Files the scanner held back in the window (`acct.attachments.scan_state`). */
  quarantinedAttachments(tx: Tx, days: number): Promise<{ origin: string; n: number }[]> {
    return this.many(
      tx,
      `select origin, count(*)::int as n from acct.attachments
        where scan_state = 'quarantined' and created_at >= now() - ($1::int * interval '1 day')
        group by 1 order by 2 desc`,
      [days],
    );
  }

  /**
   * The queues with work nobody has claimed back (`sys.dead_letters`,
   * `resolution = 'open'`). Operator wide, like the rest of the sys stream:
   * a dead letter is an operations signal before it is an account one.
   */
  openDeadLetters(tx: Tx): Promise<{ queue: string; n: number; oldest: string }[]> {
    return this.many(
      tx,
      `select queue, count(*)::int as n, min(first_failed_at) as oldest from sys.dead_letters
        where resolution = 'open' group by 1 order by 2 desc`,
    );
  }

  usageTiles(tx: Tx, accountIds: string[], days: number): Promise<{ metric: string; key: string; n: number }[]> {
    return this.many(
      tx,
      `select 'active_users' as metric, principal_kind as key, count(distinct actor_id)::int as n
         from rpt.usage_events where occurred_at >= now() - ($2::int * interval '1 day') and (account_id is null or account_id = any ($1::uuid[])) and event_type <> 'api.request' group by 2
       union all
       select 'actions', attrs->>'action', count(*)::int from rpt.usage_events
        where event_type = 'action.completed' and occurred_at >= now() - ($2::int * interval '1 day') and (account_id is null or account_id = any ($1::uuid[])) group by 2
       union all
       select 'screens', attrs->>'screen', count(*)::int from rpt.usage_events
        where event_type = 'screen.view' and occurred_at >= now() - ($2::int * interval '1 day') and (account_id is null or account_id = any ($1::uuid[])) group by 2
       union all
       select 'no_result_searches', coalesce(attrs->>'scope', 'global'), count(*)::int from rpt.usage_events
        where event_type = 'search.run' and (attrs->>'result_count')::int = 0 and occurred_at >= now() - ($2::int * interval '1 day') and (account_id is null or account_id = any ($1::uuid[])) group by 2
       union all
       select 'api_errors', attrs->>'route', count(*)::int from rpt.usage_events
        where event_type = 'api.request' and outcome <> 'success' and occurred_at >= now() - ($2::int * interval '1 day') group by 2
       order by 1, 3 desc`,
      [accountIds, days],
    );
  }
}
