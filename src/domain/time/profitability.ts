import { lineAmount } from './billing.js';

/**
 * Account profitability (TB-16): what the work billed at, what it cost, and
 * what is left.
 *
 * It is computed over the finance lines, not over the raw entries, and that
 * is the important decision here. Those lines are what billing itself
 * charges from: they carry the rate frozen onto the entry when it was
 * logged, the multiplier an after-hours premium or an overage applied, and
 * the adjustments as signed minutes, so a write-off reduces the revenue
 * here exactly as it reduces the invoice. Re-deriving revenue from the rate
 * cards would have produced a second opinion about money, and two opinions
 * about money is one too many.
 *
 * Cost is the half that was missing. It belongs to the person rather than to
 * the account, is read at the date the work was performed, and is not
 * multiplied: an after-hours premium is what the client pays more of, not
 * what the person costs more of.
 *
 * A missing half is never read as zero. Minutes worked by somebody with no
 * cost rate on file have an unknown cost, not a free one, and reporting them
 * as pure profit is the exact mistake this measure exists to prevent. They
 * are carried out separately so a screen can say what it could not weigh.
 */

export interface CostRateView {
  /** Keyed the way a time entry names a person, so the two can be matched. */
  readonly person_id: string;
  readonly effective_from: string;
  readonly cost_rate: number;
  readonly currency: string;
}

/** A finance line, as margin reads it. */
export interface MarginInput {
  readonly person_id: string;
  readonly person_name: string;
  readonly role: string | null;
  readonly performed_on: string;
  /** Signed: an adjustment takes minutes away, and takes their revenue with them. */
  readonly minutes: number;
  readonly rate_snapshot: number | null;
  readonly rate_multiplier: number;
  readonly currency: string;
}

export interface MarginLine {
  readonly key: string;
  readonly label: string;
  readonly minutes: number;
  readonly revenue: number | null;
  readonly cost: number | null;
  readonly margin: number | null;
  /** Margin as a share of revenue, to one decimal; null without revenue to divide by. */
  readonly margin_percent: number | null;
  readonly minutes_without_cost: number;
  readonly minutes_without_rate: number;
}

export interface Profitability {
  readonly total: MarginLine;
  readonly by_role: readonly MarginLine[];
  readonly by_person: readonly MarginLine[];
  /** Every currency in play. More than one and the figures do not add up. */
  readonly currencies: readonly string[];
}

/** The cost rate in force for a person on a day: the latest on or before it. */
export function costFor(rates: readonly CostRateView[], personId: string, on: string): CostRateView | null {
  return (
    rates
      .filter((rate) => rate.person_id === personId && rate.effective_from <= on)
      .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] ?? null
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Bucket {
  key: string;
  label: string;
  minutes: number;
  revenue: number;
  cost: number;
  hasRevenue: boolean;
  hasCost: boolean;
  minutesWithoutCost: number;
  minutesWithoutRate: number;
}

function empty(key: string, label: string): Bucket {
  return {
    key,
    label,
    minutes: 0,
    revenue: 0,
    cost: 0,
    hasRevenue: false,
    hasCost: false,
    minutesWithoutCost: 0,
    minutesWithoutRate: 0,
  };
}

function finish(bucket: Bucket): MarginLine {
  const revenue = bucket.hasRevenue ? round(bucket.revenue) : null;
  const cost = bucket.hasCost ? round(bucket.cost) : null;
  // A margin needs both halves. One of them missing is not a margin of the
  // other, it is an unknown.
  const margin = revenue !== null && cost !== null ? round(revenue - cost) : null;
  return {
    key: bucket.key,
    label: bucket.label,
    minutes: bucket.minutes,
    revenue,
    cost,
    margin,
    margin_percent:
      margin !== null && revenue !== null && revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : null,
    minutes_without_cost: bucket.minutesWithoutCost,
    minutes_without_rate: bucket.minutesWithoutRate,
  };
}

/** Cost of some minutes at a rate per hour, to the cent; null without a rate. */
export function costOf(minutes: number, rate: number | null): number | null {
  if (rate === null) return null;
  return Math.round((minutes / 60) * rate * 100) / 100;
}

/**
 * Revenue, cost and margin over a set of finance lines, in total and broken
 * down by role and by person.
 *
 * Non-billable time earns nothing and still costs, which is the whole point
 * of measuring margin rather than revenue: an account can be busy, fully
 * staffed and losing money, and only this number says so.
 */
export function profitability(lines: readonly MarginInput[], costs: readonly CostRateView[]): Profitability {
  const total = empty('total', 'Total');
  const roles = new Map<string, Bucket>();
  const people = new Map<string, Bucket>();
  const currencies = new Set<string>();

  for (const line of lines) {
    const roleKey = line.role ?? 'unknown';
    const role = roles.get(roleKey) ?? empty(roleKey, line.role ?? 'No role on file');
    const person = people.get(line.person_id) ?? empty(line.person_id, line.person_name);
    const buckets = [total, role, person];

    for (const bucket of buckets) bucket.minutes += line.minutes;

    const revenue = lineAmount(line);
    if (revenue === null) {
      for (const bucket of buckets) bucket.minutesWithoutRate += line.minutes;
    } else {
      for (const bucket of buckets) {
        bucket.revenue += revenue;
        bucket.hasRevenue = true;
      }
      currencies.add(line.currency);
    }

    const rate = costFor(costs, line.person_id, line.performed_on);
    const cost = costOf(line.minutes, rate ? rate.cost_rate : null);
    if (cost === null) {
      for (const bucket of buckets) bucket.minutesWithoutCost += line.minutes;
    } else {
      for (const bucket of buckets) {
        bucket.cost += cost;
        bucket.hasCost = true;
      }
      currencies.add(rate!.currency);
    }

    roles.set(roleKey, role);
    people.set(line.person_id, person);
  }

  // Worst first: a reader opens this to find what is losing money.
  const byMargin = (a: MarginLine, b: MarginLine) => (a.margin ?? Infinity) - (b.margin ?? Infinity);
  return {
    total: finish(total),
    by_role: [...roles.values()].map(finish).sort(byMargin),
    by_person: [...people.values()].map(finish).sort(byMargin),
    currencies: [...currencies].sort(),
  };
}
