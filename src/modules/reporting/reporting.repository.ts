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
      pdfKey: string;
    },
  ): Promise<{ id: string }> {
    return this.one(
      tx,
      'report_pack',
      `insert into acct.report_packs (account_id, run_id, period_start, period_end, measures, notable, narrative_source, narrative_versions, pptx_key, pdf_key)
       values ($1, $2, $3, $4, $5, $6, 'template', $7, $8, $9) returning id`,
      [
        input.accountId,
        input.runId,
        input.periodStart,
        input.periodEnd,
        JSON.stringify(input.measures),
        JSON.stringify(input.notable),
        // Version one is the templated narrative, sectioned the way the
        // review screen edits it, and it is rendered by definition: the two
        // renditions this row is about to name were built from it.
        JSON.stringify([
          {
            version: 1,
            text: input.narrative,
            sections: [{ key: 'headline', text: input.narrative }],
            author_kind: 'template',
            author_id: 'template',
            at: new Date().toISOString(),
            rendered: true,
          },
        ]),
        input.pptxKey,
        input.pdfKey,
      ],
    );
  }

  runs(tx: Tx, accountId: string): Promise<Record<string, unknown>[]> {
    return this.many(
      tx,
      `select r.*, p.id as pack_id_resolved, p.pptx_key, p.pdf_key from acct.report_runs r left join acct.report_packs p on p.run_id = r.id where r.account_id = $1 order by r.created_at desc limit 50`,
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
    pdf_key: string | null;
  }> {
    return this.one(tx, 'report_pack', 'select * from acct.report_packs where id = $1', [id]);
  }

  // Security and usage tiles ----------------------------------------------

  /**
   * The grant clause every read of `sys.security_events` carries. That
   * table is an operator table with no policy of its own, so the session
   * binding does nothing for it and the clause is the only thing standing
   * between an `audit:read` holder bound to one account and every other
   * account's security rows. The audit search writes the same clause for
   * the same reason. Rows with no account (the portfolio-wide events) stay
   * visible: that is the operator scope the permission grants.
   */
  private granted(position: number): string {
    return ` and (account_id is null or account_id = any ($${position}::uuid[]))`;
  }

  securityTiles(tx: Tx, days: number, accountIds: readonly string[]): Promise<Record<string, unknown>[]> {
    return this.many(
      tx,
      `select event_type, outcome, count(*)::int as n from sys.security_events
        where occurred_at >= now() - ($1::int * interval '1 day')${this.granted(2)}
        group by 1, 2 order by 3 desc`,
      [days, [...accountIds]],
    );
  }

  signinFailures(
    tx: Tx,
    days: number,
    accountIds: readonly string[],
  ): Promise<{ actor_id: string; ip_hash: string | null; n: number }[]> {
    return this.many(
      tx,
      `select actor_id, ip_hash, count(*)::int as n from sys.security_events
        where event_type = 'auth.signin.failed' and occurred_at >= now() - ($1::int * interval '1 day')${this.granted(2)}
        group by 1, 2 order by 3 desc limit 20`,
      [days, [...accountIds]],
    );
  }

  isolationProbes(tx: Tx, days: number, accountIds: readonly string[]): Promise<{ actor_id: string; n: number }[]> {
    return this.many(
      tx,
      `select actor_id, count(*)::int as n from sys.security_events
        where event_type in ('authz.isolation.filtered', 'authz.account.denied', 'authz.realm.denied')
          and occurred_at >= now() - ($1::int * interval '1 day')${this.granted(2)}
        group by 1 order by 2 desc limit 20`,
      [days, [...accountIds]],
    );
  }

  /**
   * The abuse half of the security stream by kind (`sys.security_events`,
   * the `abuse.*` group of the catalog): rate limits, bad webhook
   * signatures, suspected mail loops, rejected uploads and CSP reports.
   */
  abuseByKind(tx: Tx, days: number, accountIds: readonly string[]): Promise<{ event_type: string; n: number }[]> {
    return this.many(
      tx,
      `select event_type, count(*)::int as n from sys.security_events
        where event_type like 'abuse.%' and occurred_at >= now() - ($1::int * interval '1 day')${this.granted(2)}
        group by 1 order by 2 desc`,
      [days, [...accountIds]],
    );
  }

  /** Who the rate limiter turned away (`sys.security_events`, `abuse.rate_limited`). */
  rateLimitedClients(
    tx: Tx,
    days: number,
    accountIds: readonly string[],
  ): Promise<{ actor_id: string; principal_kind: string | null; n: number }[]> {
    return this.many(
      tx,
      `select actor_id, principal_kind, count(*)::int as n from sys.security_events
        where event_type = 'abuse.rate_limited' and occurred_at >= now() - ($1::int * interval '1 day')${this.granted(2)}
        group by 1, 2 order by 3 desc limit 20`,
      [days, [...accountIds]],
    );
  }

  /**
   * What is paused right now rather than what paused during the window:
   * neither `acct.webhook_subscriptions` nor `acct.connector_instances`
   * timestamps the pause, and a subscription that has been off for a month
   * is the more urgent of the two anyway. Both tables are account scoped,
   * so the binding decides which accounts are listed.
   *
   * One row per paused thing rather than a count per reason, because the
   * Security dashboard's job here is to hand the reader the record: the
   * kind says which screen opens it, the id says which row, and the
   * account says under which client. The counts stay beside it in
   * `pausedIntegrationsByReason`.
   */
  pausedIntegrations(tx: Tx): Promise<
    {
      kind: 'webhook_subscription' | 'connector_instance';
      id: string;
      account_id: string;
      account_key: string;
      name: string;
      reason: string;
    }[]
  > {
    return this.many(
      tx,
      `select 'webhook_subscription' as kind, w.id::text as id, w.account_id::text as account_id,
              a.key as account_key, w.endpoint_url as name, coalesce(w.paused_reason, 'unstated') as reason
         from acct.webhook_subscriptions w join op.accounts a on a.id = w.account_id
        where w.status = 'paused'
       union all
       select 'connector_instance', c.id::text, c.account_id::text, a.key, c.name, coalesce(c.trip_reason, 'unstated')
         from acct.connector_instances c join op.accounts a on a.id = c.account_id
        where c.kill_switch = 'tripped'
       order by 1, 4, 5`,
    );
  }

  /** The same two tables counted by kind and reason: the tile above the list. */
  pausedIntegrationsByReason(tx: Tx): Promise<{ kind: string; reason: string; n: number }[]> {
    return this.many(
      tx,
      `select 'webhook_subscription' as kind, coalesce(paused_reason, 'unstated') as reason, count(*)::int as n
         from acct.webhook_subscriptions where status = 'paused' group by 1, 2
       union all
       select 'connector_instance', coalesce(trip_reason, 'unstated'), count(*)::int
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
   * `resolution = 'open'`), split far enough for the reader to open the
   * record: the queue, the account the failure belongs to and, where the
   * queue is a connector queue, the instance its payload names
   * (`inbox` and `outbound` both carry `instance_id`).
   *
   * `sys.dead_letters` is an operator table with no policy of its own, so
   * this half binds to the grants the way the usage tiles and the audit
   * search do: an account row is listed only where the reader is bound to
   * that account, and a row with no account (the platform queues) is
   * always listed. The portfolio count stays operator wide in
   * `openDeadLettersByQueue`, which is the figure the tile shows.
   */
  openDeadLetters(
    tx: Tx,
    accountIds: readonly string[],
  ): Promise<
    {
      queue: string;
      n: number;
      oldest: string;
      account_id: string | null;
      instance_id: string | null;
      instance_name: string | null;
    }[]
  > {
    return this.many(
      tx,
      // The id follows the row's visibility, not the payload's word for
      // it: a dead letter carrying no account of its own used to hand back
      // the instance id whatever account owned that connector, while only
      // the name was suppressed by row-level security on the join.
      `select d.queue, count(*)::int as n, min(d.first_failed_at) as oldest,
              d.account_id::text as account_id,
              case when max(c.id::text) is null then null else d.payload->>'instance_id' end as instance_id,
              max(c.name) as instance_name
         from sys.dead_letters d
         left join acct.connector_instances c on c.id::text = d.payload->>'instance_id'
        where d.resolution = 'open' and (d.account_id is null or d.account_id = any ($1::uuid[]))
        group by d.queue, d.account_id, d.payload->>'instance_id'
        order by 2 desc, 1`,
      [[...accountIds]],
    );
  }

  /** The portfolio depth per queue, operator wide: a dead letter is an operations signal first. */
  openDeadLettersByQueue(tx: Tx): Promise<{ queue: string; n: number; oldest: string }[]> {
    return this.many(
      tx,
      `select queue, count(*)::int as n, min(first_failed_at) as oldest from sys.dead_letters
        where resolution = 'open' group by 1 order by 2 desc`,
    );
  }

  /**
   * What each stream of `rpt.events_v` holds right now: how many rows the
   * reader can see, and the oldest and newest instants among them. The
   * grant clause is the one the audit search applies (`account_id is null
   * or account_id = any (...)`), so the panel counts exactly the rows the
   * same reader could open in the search and no more.
   */
  eventStreamSpans(
    tx: Tx,
    accountIds: readonly string[],
  ): Promise<{ stream: string; n: number; oldest: string | null; newest: string | null }[]> {
    return this.many(
      tx,
      `select stream, count(*)::int as n, min(occurred_at) as oldest, max(occurred_at) as newest
         from rpt.events_v
        where account_id is null or account_id = any ($1::uuid[])
        group by 1 order by 1`,
      [[...accountIds]],
    );
  }

  /**
   * The core-loop funnel (Audit & Analytics 7.1: "ticket opened, first
   * reply, time logged, solution linked, resolved" with drop-off), counted
   * over the tickets one account opened in the window. Every step is a
   * column of `acct.tickets` except the third, which asks
   * `acct.time_entries` whether any time was logged against the ticket:
   * `first_response_at` for the first reply, `solution_article_id` for the
   * linked solution, `resolved_at` for the resolution. Both tables are
   * account scoped, so the caller's binding decides what is counted, and
   * the left join keeps an account with no tickets in the answer at zero
   * rather than dropping it out of the strip.
   *
   * A step is counted on its own, not as a subset of the step before it:
   * a ticket can be resolved with no time logged (a time exemption) or
   * with no solution article, and reporting those as if they had passed
   * through would be a fiction. The drop-off the screen shows is therefore
   * the difference between two step counts and can be negative where a
   * step was skipped.
   */
  coreLoopFunnel(
    tx: Tx,
    accountIds: readonly string[],
    days: number,
  ): Promise<
    {
      account_id: string;
      key: string;
      name: string;
      opened: number;
      first_response: number;
      time_logged: number;
      solution_linked: number;
      resolved: number;
      closed: number;
    }[]
  > {
    return this.many(
      tx,
      `select a.id as account_id, a.key, a.name,
              count(t.id)::int as opened,
              count(t.id) filter (where t.first_response_at is not null)::int as first_response,
              count(t.id) filter (where exists (select 1 from acct.time_entries e where e.ticket_id = t.id))::int as time_logged,
              count(t.id) filter (where t.solution_article_id is not null)::int as solution_linked,
              count(t.id) filter (where t.resolved_at is not null)::int as resolved,
              count(t.id) filter (where t.closed_at is not null)::int as closed
         from op.accounts a
         left join acct.tickets t
           on t.account_id = a.id and t.created_at >= now() - ($2::int * interval '1 day')
        where a.id = any ($1::uuid[])
        group by a.id, a.key, a.name
        order by a.key`,
      [[...accountIds], days],
    );
  }

  /**
   * Feature adoption (Audit & Analytics 7.1: "which actions each role uses,
   * first-use dates"). The actions are the `action.completed` rows of
   * `rpt.usage_events` with their `action` attribute; the role comes from
   * `op.role_assignments` joined to `op.roles` on the actor, because the
   * event carries the actor and the principal kind but never a role.
   *
   * `users` and `n` are the window; `first_used_at` is the first time that
   * role used that action at all, which is what a first-use date means and
   * what a window would destroy. A row appears only where the action was
   * used inside the window. A person holding two roles counts under both:
   * the question is which actions a role uses, not how many people used
   * one, and an actor with no role assignment is reported as `unassigned`
   * rather than dropped.
   */
  actionAdoption(
    tx: Tx,
    accountIds: readonly string[],
    days: number,
  ): Promise<
    { catalog: string; role: string; action: string; users: number; n: number; first_used_at: string | null }[]
  > {
    return this.many(
      tx,
      `with acted as (
         select e.actor_id, coalesce(e.attrs->>'action', 'unknown') as action, e.occurred_at
           from rpt.usage_events e
          where e.event_type = 'action.completed'
            and (e.account_id is null or e.account_id = any ($1::uuid[]))
       ),
       assigned as (
         select distinct ra.user_id::text as actor_id, r.catalog, r.name as role
           from op.role_assignments ra join op.roles r on r.id = ra.role_id
       )
       select coalesce(s.catalog, 'none') as catalog, coalesce(s.role, 'unassigned') as role, a.action,
              count(distinct a.actor_id) filter (where a.occurred_at >= now() - ($2::int * interval '1 day'))::int as users,
              count(*) filter (where a.occurred_at >= now() - ($2::int * interval '1 day'))::int as n,
              min(a.occurred_at) as first_used_at
         from acted a
         left join assigned s on s.actor_id = a.actor_id
        group by 1, 2, 3
       having count(*) filter (where a.occurred_at >= now() - ($2::int * interval '1 day')) > 0
        order by 2, 3`,
      [[...accountIds], days],
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

  /**
   * The per-account strip of the Usage dashboard. One correlated count per
   * figure, each from the table that records it:
   * `acct.tickets.created_at` and `.closed_at`, `acct.time_entries.minutes`
   * over `performed_on`, the portal sign-ins from `sys.security_events`
   * (`auth.signin.success` with a portal principal), the API client calls
   * and the active users from `rpt.usage_events` (`api.request` with an
   * api_client principal, and every non-request event respectively).
   */
  usagePerAccount(
    tx: Tx,
    accountIds: string[],
    days: number,
  ): Promise<
    {
      account_id: string;
      key: string;
      name: string;
      tickets_created: number;
      tickets_closed: number;
      minutes_logged: number;
      portal_signins: number;
      api_calls: number;
      active_users: number;
    }[]
  > {
    return this.many(
      tx,
      `select a.id as account_id, a.key, a.name,
              (select count(*)::int from acct.tickets t
                where t.account_id = a.id and t.created_at >= now() - ($2::int * interval '1 day')) as tickets_created,
              (select count(*)::int from acct.tickets t
                where t.account_id = a.id and t.closed_at >= now() - ($2::int * interval '1 day')) as tickets_closed,
              (select coalesce(sum(e.minutes), 0)::int from acct.time_entries e
                where e.account_id = a.id and e.performed_on >= (current_date - $2::int)) as minutes_logged,
              (select count(*)::int from sys.security_events s
                where s.account_id = a.id and s.event_type = 'auth.signin.success' and s.principal_kind = 'portal'
                  and s.occurred_at >= now() - ($2::int * interval '1 day')) as portal_signins,
              (select count(*)::int from rpt.usage_events u
                where u.account_id = a.id and u.event_type = 'api.request' and u.principal_kind = 'api_client'
                  and u.occurred_at >= now() - ($2::int * interval '1 day')) as api_calls,
              (select count(distinct u.actor_id)::int from rpt.usage_events u
                where u.account_id = a.id and u.event_type <> 'api.request'
                  and u.occurred_at >= now() - ($2::int * interval '1 day')) as active_users
         from op.accounts a
        where a.id = any ($1::uuid[])
        order by a.key`,
      [accountIds, days],
    );
  }
}
