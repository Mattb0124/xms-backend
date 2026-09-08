/**
 * Measure functions (Dashboards & Report Packs technical 2.7, 3; cut to the
 * ten day-30 measures). Pure over row sets so the API (live), the worker
 * (snapshots) and the tests share one definition. Nothing here reads free
 * text: rows carry keys, states, priorities, timestamps and minutes only.
 */
export interface TicketFacts {
  readonly id: string;
  readonly key: string;
  readonly type: string;
  readonly state: string;
  readonly priority: string;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
  readonly reopenCount: number;
  readonly responseBreached: boolean;
  readonly resolutionBreached: boolean;
  readonly responseMet: boolean;
  readonly resolutionMet: boolean;
  readonly resolutionDueAt: Date | null;
  readonly resolutionRemainingMinutes: number | null;
  readonly resolutionTargetMinutes: number | null;
  readonly shortDescription: string;
}

export interface TimeFacts {
  readonly minutes: number;
  readonly consumesContract: boolean;
  readonly performedOn: string;
}

export interface Period {
  readonly start: Date;
  readonly end: Date;
}

export const OPEN_STATES_EXCLUDED = new Set(['closed', 'cancelled']);
export const AGE_BUCKETS = ['0_1d', '1_3d', '3_7d', '7_14d', '14d_plus'] as const;

export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** Open means still being worked: not resolved, closed or cancelled. */
export function isOpen(ticket: TicketFacts): boolean {
  return !OPEN_STATES_EXCLUDED.has(ticket.state) && ticket.resolvedAt === null;
}

export function ageBucket(createdAt: Date, now: Date): AgeBucket {
  const days = (now.getTime() - createdAt.getTime()) / 86_400_000;
  if (days < 1) return '0_1d';
  if (days < 3) return '1_3d';
  if (days < 7) return '3_7d';
  if (days < 14) return '7_14d';
  return '14d_plus';
}

/**
 * The counted keys in a declared order, then whatever the order did not
 * name in the order it was first seen. An object literal keeps insertion
 * order for non-numeric keys, which is the order the response carries and
 * the order a panel draws its rows in.
 */
function orderedCounts(counts: ReadonlyMap<string, number>, order: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of order) {
    const count = counts.get(key);
    if (count !== undefined) result[key] = count;
  }
  for (const [key, count] of counts) if (!(key in result)) result[key] = count;
  return result;
}

function inPeriod(at: Date | null, period: Period): boolean {
  return at !== null && at.getTime() >= period.start.getTime() && at.getTime() < period.end.getTime();
}

export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
}

function ratio(numerator: number, denominator: number): Ratio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10,
  };
}

export interface Measures {
  open_tickets: number;
  open_by_priority: Record<string, number>;
  open_by_type: Record<string, number>;
  /**
   * Open tickets per state, over the same open set as `open_by_priority`
   * and `open_by_type`, so all three breakdowns sum to `open_tickets`. A
   * resolved ticket awaiting closure is therefore left out, exactly as it
   * is left out of `open_tickets`. Keys come in the order `stateOrder`
   * declares, then any state the order does not name in first-seen order;
   * a state with no open ticket is absent rather than a zero.
   */
  open_by_state: Record<string, number>;
  breached_now: number;
  at_risk_now: number;
  unassigned_now: number;
  backlog_by_age: Record<AgeBucket, number>;
  volume_created: number;
  volume_resolved: number;
  sla_response_attainment: Ratio;
  sla_resolution_attainment: Ratio;
  mttr_minutes: number | null;
  reopen_rate: Ratio;
  consumption_minutes: number;
  time_logged_minutes: number;
  oldest_open_days: number;
}

export function computeMeasures(
  tickets: readonly TicketFacts[],
  time: readonly TimeFacts[],
  period: Period,
  now: Date,
  stateOrder: readonly string[] = [],
): Measures {
  const open = tickets.filter(isOpen);
  const created = tickets.filter((ticket) => inPeriod(ticket.createdAt, period));
  const resolvedInPeriod = tickets.filter((ticket) => inPeriod(ticket.resolvedAt, period));
  const backlog: Record<AgeBucket, number> = { '0_1d': 0, '1_3d': 0, '3_7d': 0, '7_14d': 0, '14d_plus': 0 };
  const byPriority: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byState = new Map<string, number>();
  let oldest = 0;
  for (const ticket of open) {
    backlog[ageBucket(ticket.createdAt, now)] += 1;
    byPriority[ticket.priority] = (byPriority[ticket.priority] ?? 0) + 1;
    byType[ticket.type] = (byType[ticket.type] ?? 0) + 1;
    byState.set(ticket.state, (byState.get(ticket.state) ?? 0) + 1);
    oldest = Math.max(oldest, (now.getTime() - ticket.createdAt.getTime()) / 86_400_000);
  }
  const responseJudged = resolvedInPeriod.filter((ticket) => ticket.responseMet || ticket.responseBreached);
  const resolutionJudged = resolvedInPeriod.filter((ticket) => ticket.resolutionMet || ticket.resolutionBreached);
  const durations = resolvedInPeriod.map(
    (ticket) => (ticket.resolvedAt!.getTime() - ticket.createdAt.getTime()) / 60_000,
  );
  const reopened = resolvedInPeriod.filter((ticket) => ticket.reopenCount > 0);
  return {
    open_tickets: open.length,
    open_by_priority: byPriority,
    open_by_type: byType,
    open_by_state: orderedCounts(byState, stateOrder),
    breached_now: open.filter((ticket) => ticket.responseBreached || ticket.resolutionBreached).length,
    at_risk_now: open.filter(
      (ticket) =>
        !ticket.resolutionBreached &&
        ticket.resolutionRemainingMinutes !== null &&
        ticket.resolutionTargetMinutes !== null &&
        ticket.resolutionRemainingMinutes >= 0 &&
        ticket.resolutionRemainingMinutes < ticket.resolutionTargetMinutes * 0.25,
    ).length,
    unassigned_now: open.filter(
      (ticket) => !('assigneeId' in ticket) || (ticket as { assigneeId?: string | null }).assigneeId === null,
    ).length,
    backlog_by_age: backlog,
    volume_created: created.length,
    volume_resolved: resolvedInPeriod.length,
    sla_response_attainment: ratio(
      responseJudged.filter((ticket) => ticket.responseMet && !ticket.responseBreached).length,
      responseJudged.length,
    ),
    sla_resolution_attainment: ratio(
      resolutionJudged.filter((ticket) => ticket.resolutionMet && !ticket.resolutionBreached).length,
      resolutionJudged.length,
    ),
    mttr_minutes: durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    reopen_rate: ratio(reopened.length, resolvedInPeriod.length),
    consumption_minutes: time.filter((entry) => entry.consumesContract).reduce((sum, entry) => sum + entry.minutes, 0),
    time_logged_minutes: time.reduce((sum, entry) => sum + entry.minutes, 0),
    oldest_open_days: Math.round(oldest * 10) / 10,
  };
}

/** Rows a report may show: key, title, state, priority, age; never a note. */
export function notableTickets(
  tickets: readonly TicketFacts[],
  now: Date,
  limit = 5,
): { key: string; title: string; state: string; priority: string; age_days: number; breached: boolean }[] {
  return tickets
    .filter(isOpen)
    .map((ticket) => ({
      key: ticket.key,
      title: ticket.shortDescription,
      state: ticket.state,
      priority: ticket.priority,
      age_days: Math.round(((now.getTime() - ticket.createdAt.getTime()) / 86_400_000) * 10) / 10,
      breached: ticket.responseBreached || ticket.resolutionBreached,
    }))
    .sort(
      (a, b) =>
        Number(b.breached) - Number(a.breached) || a.priority.localeCompare(b.priority) || b.age_days - a.age_days,
    )
    .slice(0, limit);
}

/** The previous ISO week (Monday to Sunday) relative to a date, in UTC. */
export function previousWeek(reference: Date): Period {
  const day = reference.getUTCDay() || 7;
  const monday = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() - day + 1),
  );
  const start = new Date(monday.getTime() - 7 * 86_400_000);
  return { start, end: monday };
}
