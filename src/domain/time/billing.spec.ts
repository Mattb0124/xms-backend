import { describe, expect, it } from 'vitest';
import { billingTransition, FINANCE_COLUMNS, financeRows, lineAmount, periodSummary, toCsv } from './billing.js';
import type { FinanceLine } from './billing.js';

const line = (over: Partial<FinanceLine> = {}): FinanceLine => ({
  kind: 'entry',
  id: 'e1',
  entry_id: 'e1',
  account_key: 'BRK',
  contract_key: 'CT10001',
  person_id: 'u1',
  person_name: 'Cara Lee',
  role: 'consultant',
  performed_on: '2026-09-03',
  minutes: 90,
  activity_type: 'analysis',
  billable_class: 'billable',
  rate_snapshot: 150,
  rate_multiplier: 1,
  currency: 'USD',
  ticket_key: 'CS0000001',
  after_hours_class: 'standard',
  reason: null,
  ...over,
});

describe('billingTransition', () => {
  it('follows the functional 5.7 table', () => {
    expect(billingTransition('open', 'submit')).toEqual({ ok: true, to: 'submitted' });
    expect(billingTransition('submitted', 'reopen')).toEqual({ ok: true, to: 'open' });
    expect(billingTransition('submitted', 'approve')).toEqual({ ok: true, to: 'approved' });
    expect(billingTransition('approved', 'lock')).toEqual({ ok: true, to: 'locked' });
    expect(billingTransition('locked', 'mark_exported')).toEqual({ ok: true, to: 'exported' });
  });

  it('refuses a step backwards from approved and names what is allowed', () => {
    expect(billingTransition('approved', 'reopen')).toEqual({
      ok: false,
      code: 'invalid_transition',
      allowed: ['lock'],
    });
    expect(billingTransition('exported', 'lock')).toEqual({ ok: false, code: 'invalid_transition', allowed: [] });
    expect(billingTransition('open', 'approve')).toMatchObject({ ok: false, allowed: ['submit', 'lock'] });
  });
});

describe('finance rows and summary', () => {
  it('amounts to the cent, signed with the minutes, null without a rate', () => {
    expect(lineAmount(line())).toBe(225);
    expect(lineAmount(line({ minutes: -30, rate_multiplier: 1.5 }))).toBe(-112.5);
    expect(lineAmount(line({ rate_snapshot: null }))).toBeNull();
  });

  it('lays one row per line out in the column order', () => {
    const rows = financeRows(
      [line(), line({ kind: 'adjustment', id: 'a1', minutes: -30, reason: 'Overstated' })],
      '2026-09',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(FINANCE_COLUMNS.length);
    expect(rows[0][FINANCE_COLUMNS.indexOf('amount')]).toBe(225);
    expect(rows[1][FINANCE_COLUMNS.indexOf('kind')]).toBe('adjustment');
    expect(rows[1][FINANCE_COLUMNS.indexOf('minutes')]).toBe(-30);
    expect(rows[1][FINANCE_COLUMNS.indexOf('reason')]).toBe('Overstated');
    expect(rows[0][FINANCE_COLUMNS.indexOf('period')]).toBe('2026-09');
  });

  it('summarises by class and contract, counting unrated minutes', () => {
    const summary = periodSummary([
      line(),
      line({ id: 'e2', entry_id: 'e2', billable_class: 'absorbed', rate_snapshot: null, minutes: 60 }),
      line({ kind: 'adjustment', id: 'a1', minutes: -30, contract_key: 'CT10002' }),
    ]);
    expect(summary).toMatchObject({ entries: 2, adjustments: 1, minutes: 120, amount: 150, unrated_minutes: 60 });
    expect(summary.by_class).toEqual({ billable: { minutes: 60, amount: 150 }, absorbed: { minutes: 60, amount: 0 } });
    expect(summary.by_contract).toEqual({
      CT10001: { minutes: 150, amount: 225 },
      CT10002: { minutes: -30, amount: -75 },
    });
  });

  it('writes CSV with quoting and formula neutralisation', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['=SUM(1)', 'say "hi", twice'],
        [null, 3],
      ],
    );
    expect(csv.split('\r\n')).toEqual(['a,b', `'=SUM(1),"say ""hi"", twice"`, ',3']);
  });
});
