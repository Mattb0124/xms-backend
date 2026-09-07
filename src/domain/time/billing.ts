/**
 * Billing periods (Time, Contracts & Budget functional 5.7; TB-14): the
 * state machine an account's month moves through, the finance export rows
 * (one per entry or adjustment, THG finance layout as assumed in the
 * functional open questions), and the summary produced at submit and kept
 * with the period.
 */
export type BillingState = 'open' | 'submitted' | 'approved' | 'locked' | 'exported';
export type BillingAction = 'submit' | 'reopen' | 'approve' | 'lock' | 'mark_exported';

export const BILLING_TRANSITIONS: Readonly<
  Record<BillingAction, { readonly from: readonly BillingState[]; readonly to: BillingState }>
> = {
  submit: { from: ['open'], to: 'submitted' },
  reopen: { from: ['submitted'], to: 'open' },
  approve: { from: ['submitted'], to: 'approved' },
  lock: { from: ['open', 'submitted', 'approved'], to: 'locked' },
  mark_exported: { from: ['locked'], to: 'exported' },
};

export type TransitionResult =
  | { readonly ok: true; readonly to: BillingState }
  | { readonly ok: false; readonly code: 'invalid_transition'; readonly allowed: BillingAction[] };

/** The next state for an action, or the actions the current state allows. */
export function billingTransition(state: BillingState, action: BillingAction): TransitionResult {
  const rule = BILLING_TRANSITIONS[action];
  if (rule.from.includes(state)) return { ok: true, to: rule.to };
  const allowed = (Object.keys(BILLING_TRANSITIONS) as BillingAction[]).filter((key) =>
    BILLING_TRANSITIONS[key].from.includes(state),
  );
  return { ok: false, code: 'invalid_transition', allowed };
}

/** A source line for the finance export: an entry or an adjustment, already joined to its names. */
export interface FinanceLine {
  readonly kind: 'entry' | 'adjustment';
  readonly id: string;
  readonly entry_id: string;
  readonly account_key: string;
  readonly contract_key: string;
  readonly person_id: string;
  readonly person_name: string;
  readonly role: string | null;
  readonly performed_on: string;
  readonly minutes: number;
  readonly activity_type: string;
  readonly billable_class: string;
  readonly rate_snapshot: number | null;
  readonly rate_multiplier: number;
  readonly currency: string;
  readonly ticket_key: string | null;
  readonly after_hours_class: string;
  readonly reason: string | null;
}

export const FINANCE_COLUMNS = [
  'kind',
  'id',
  'entry_id',
  'account',
  'contract',
  'period',
  'person_id',
  'person',
  'role',
  'date',
  'minutes',
  'activity',
  'billable_class',
  'rate',
  'multiplier',
  'currency',
  'amount',
  'ticket',
  'after_hours_class',
  'reason',
] as const;

export type FinanceRow = readonly (string | number | null)[];

/** `minutes / 60 * rate * multiplier` to the cent, signed with the minutes; null without a rate. */
export function lineAmount(line: Pick<FinanceLine, 'minutes' | 'rate_snapshot' | 'rate_multiplier'>): number | null {
  if (line.rate_snapshot === null) return null;
  return Math.round((line.minutes / 60) * line.rate_snapshot * line.rate_multiplier * 100) / 100;
}

/** One row per line in FINANCE_COLUMNS order; adjustments carry their signed minutes. */
export function financeRows(lines: readonly FinanceLine[], period: string): FinanceRow[] {
  return lines.map((line) => [
    line.kind,
    line.id,
    line.entry_id,
    line.account_key,
    line.contract_key,
    period,
    line.person_id,
    line.person_name,
    line.role ?? '',
    line.performed_on,
    line.minutes,
    line.activity_type,
    line.billable_class,
    line.rate_snapshot,
    line.rate_multiplier,
    line.currency,
    lineAmount(line),
    line.ticket_key ?? '',
    line.after_hours_class,
    line.reason ?? '',
  ]);
}

export interface PeriodSummary {
  readonly entries: number;
  readonly adjustments: number;
  readonly minutes: number;
  readonly amount: number;
  readonly unrated_minutes: number;
  readonly by_class: Record<string, { minutes: number; amount: number }>;
  readonly by_contract: Record<string, { minutes: number; amount: number }>;
}

/** The figures kept on the period at submit and matched by the export to the cent. */
export function periodSummary(lines: readonly FinanceLine[]): PeriodSummary {
  const byClass: Record<string, { minutes: number; amount: number }> = {};
  const byContract: Record<string, { minutes: number; amount: number }> = {};
  let minutes = 0;
  let amount = 0;
  let unrated = 0;
  let entries = 0;
  let adjustments = 0;
  const add = (bucket: Record<string, { minutes: number; amount: number }>, key: string, m: number, a: number) => {
    const row = bucket[key] ?? { minutes: 0, amount: 0 };
    row.minutes += m;
    row.amount = Math.round((row.amount + a) * 100) / 100;
    bucket[key] = row;
  };
  for (const line of lines) {
    const value = lineAmount(line) ?? 0;
    if (line.rate_snapshot === null) unrated += line.minutes;
    if (line.kind === 'entry') entries += 1;
    else adjustments += 1;
    minutes += line.minutes;
    amount = Math.round((amount + value) * 100) / 100;
    add(byClass, line.billable_class, line.minutes, value);
    add(byContract, line.contract_key, line.minutes, value);
  }
  return {
    entries,
    adjustments,
    minutes,
    amount,
    unrated_minutes: unrated,
    by_class: byClass,
    by_contract: byContract,
  };
}

/** CSV with CRLF rows, quoting where needed and spreadsheet formula neutralisation. */
export function toCsv(columns: readonly string[], rows: readonly FinanceRow[]): string {
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.join(','), ...rows.map((row) => row.map(escape).join(','))].join('\r\n');
}
