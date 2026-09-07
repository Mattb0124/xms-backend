/**
 * Budget rules (Time, Contracts & Budget technical section 2 "core logic";
 * TB-07 to TB-09, TB-11): pure functions over the numbers the service
 * already holds. Minutes everywhere; money only where a rate is known.
 */
export type OverageRule = 'block' | 'allow_flag' | 'allow_rate';
export type RolloverRule = 'none' | 'carry_month' | 'carry_term' | 'cap';

export const OVERAGE_RULES: readonly OverageRule[] = ['block', 'allow_flag', 'allow_rate'];
export const ROLLOVER_RULES: readonly RolloverRule[] = ['none', 'carry_month', 'carry_term', 'cap'];

export function* dates(from: string, to: string): Generator<string> {
  let cursor = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  while (cursor <= end) {
    yield new Date(cursor).toISOString().slice(0, 10);
    cursor += 86_400_000;
  }
}

export interface ForecastInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  /** The day the forecast is made (YYYY-MM-DD). */
  readonly today: string;
  readonly available: number;
  readonly consumed: number;
  /** Consuming minutes per performed date. */
  readonly consumedByDay: ReadonlyMap<string, number>;
  /** N business days of run rate (account setting, default 10). */
  readonly windowDays: number;
  readonly isBusinessDay: (date: string) => boolean;
}

export interface Forecast {
  readonly business_days_total: number;
  readonly business_days_elapsed: number;
  readonly window_days: number;
  /** Consuming minutes per business day over the window. */
  readonly run_rate_minutes: number;
  readonly forecast_minutes: number;
  readonly forecast_percent: number;
  /** Business days until the available minutes are gone at the run rate; null when they never are. */
  readonly business_days_to_exhaustion: number | null;
}

/** TB-08: run rate over the last N business days projected over the business days left. */
export function forecast(input: ForecastInput): Forecast {
  const all = [...dates(input.periodStart, input.periodEnd)].filter(input.isBusinessDay);
  const elapsed = all.filter((date) => date <= input.today);
  const window = Math.min(Math.max(1, input.windowDays), Math.max(1, elapsed.length));
  const recent = elapsed.slice(-window);
  const recentMinutes = recent.reduce((sum, date) => sum + (input.consumedByDay.get(date) ?? 0), 0);
  const runRate = elapsed.length === 0 ? 0 : recentMinutes / window;
  const remainingDays = Math.max(0, all.length - elapsed.length);
  const projected = Math.round(input.consumed + runRate * remainingDays);
  const left = input.available - input.consumed;
  const toExhaustion =
    runRate > 0 && left > 0 ? Math.ceil(left / runRate) : left <= 0 && input.available > 0 ? 0 : null;
  return {
    business_days_total: all.length,
    business_days_elapsed: elapsed.length,
    window_days: window,
    run_rate_minutes: Math.round(runRate),
    forecast_minutes: projected,
    forecast_percent: input.available > 0 ? Math.round((projected / input.available) * 1000) / 10 : 0,
    business_days_to_exhaustion: toExhaustion,
  };
}

/** TB-09: the percentages crossed by `consumed` that have not fired yet, ascending. */
export function thresholdsToFire(
  percents: readonly number[],
  fired: readonly number[],
  consumed: number,
  available: number,
): number[] {
  if (available <= 0) return [];
  return [...new Set(percents)]
    .filter((percent) => percent > 0 && !fired.includes(percent) && consumed >= (available * percent) / 100)
    .sort((a, b) => a - b);
}

export interface OverageDecision {
  readonly blocked: boolean;
  readonly overBudget: boolean;
  /** Minutes of the new entry that fall beyond the available budget. */
  readonly overageMinutes: number;
  /** The multiplier the overage rule adds (1 when none). */
  readonly multiplier: number;
}

/**
 * TB-11 overage: with a budget, the new entry either fits, is refused
 * (`block`), is saved and flagged (`allow_flag`), or is saved at the
 * overage multiplier (`allow_rate`). Without a budget (T&M) nothing is over.
 */
export function overageDecision(
  rule: OverageRule,
  available: number,
  consumed: number,
  newMinutes: number,
  multiplier: number | null | undefined,
): OverageDecision {
  const fits = available <= 0 || consumed + newMinutes <= available;
  if (fits) return { blocked: false, overBudget: false, overageMinutes: 0, multiplier: 1 };
  const overageMinutes = Math.min(newMinutes, consumed + newMinutes - available);
  if (rule === 'block') return { blocked: true, overBudget: true, overageMinutes, multiplier: 1 };
  if (rule === 'allow_rate')
    return {
      blocked: false,
      overBudget: true,
      overageMinutes,
      multiplier: multiplier && multiplier >= 1 ? multiplier : 1,
    };
  return { blocked: false, overBudget: true, overageMinutes, multiplier: 1 };
}

export interface RateCardView {
  readonly id: string;
  readonly contract_id: string | null;
  readonly effective_from: string;
  readonly entries: readonly { role: string; bill_rate: number; overage_rate: number | null }[];
}

export interface RateSelection {
  readonly rate: number | null;
  readonly overageRate: number | null;
  readonly cardId: string | null;
  readonly source: 'contract' | 'account' | null;
}

/** Rate snapshot: the contract card in force on the date, else the account default in force; the entry for the role. */
export function rateFor(cards: readonly RateCardView[], role: string, on: string): RateSelection {
  const inForce = (contractScoped: boolean) =>
    cards
      .filter((card) => (contractScoped ? card.contract_id !== null : card.contract_id === null))
      .filter((card) => card.effective_from <= on)
      .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
  for (const [card, source] of [
    [inForce(true), 'contract'],
    [inForce(false), 'account'],
  ] as const) {
    if (!card) continue;
    const entry = card.entries.find((row) => row.role === role);
    if (entry) return { rate: entry.bill_rate, overageRate: entry.overage_rate, cardId: card.id, source };
  }
  return { rate: null, overageRate: null, cardId: null, source: null };
}

/** `minutes / 60 * rate * multiplier`, to the cent; null without a rate. */
export function amountOf(minutes: number, rate: number | null, multiplier: number): number | null {
  if (rate === null) return null;
  return Math.round((minutes / 60) * rate * multiplier * 100) / 100;
}

export interface PreviousPeriod {
  readonly starts_on: string;
  readonly ends_on: string;
  readonly contracted_minutes: number;
  readonly carried_over_minutes: number;
  readonly consumed_minutes: number;
}

function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Carry-over at period open (technical section 2): `carry_month` carries
 * the unused contracted minutes of the immediately preceding period only,
 * never its own carry-over again; `carry_term` carries cumulatively;
 * `cap` is `carry_term` bounded by the cap.
 */
export function carryOver(
  rule: RolloverRule,
  capHours: number | null | undefined,
  previous: PreviousPeriod | null,
  nextStartsOn: string,
): number {
  if (rule === 'none' || !previous) return 0;
  if (rule === 'carry_month') {
    if (nextDay(previous.ends_on) !== nextStartsOn) return 0;
    return Math.max(previous.contracted_minutes - previous.consumed_minutes, 0);
  }
  const cumulative = Math.max(
    previous.contracted_minutes + previous.carried_over_minutes - previous.consumed_minutes,
    0,
  );
  if (rule === 'cap') return Math.min(cumulative, Math.round((capHours ?? 0) * 60));
  return cumulative;
}
