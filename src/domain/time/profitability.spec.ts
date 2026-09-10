import { describe, expect, it } from 'vitest';
import { costFor, costOf, profitability, type CostRateView, type MarginInput } from './profitability.js';

function line(overrides: Partial<MarginInput> = {}): MarginInput {
  return {
    person_id: 'u1',
    person_name: 'Ana Costa',
    role: 'consultant',
    performed_on: '2026-03-10',
    minutes: 60,
    rate_snapshot: 185,
    rate_multiplier: 1,
    currency: 'USD',
    ...overrides,
  };
}

const COSTS: CostRateView[] = [
  { person_id: 'u1', effective_from: '2026-01-01', cost_rate: 80, currency: 'USD' },
  { person_id: 'u1', effective_from: '2026-06-01', cost_rate: 95, currency: 'USD' },
  { person_id: 'u2', effective_from: '2026-01-01', cost_rate: 120, currency: 'USD' },
];

describe('costFor', () => {
  it('takes the rate in force on the day the work was done, not the latest one', () => {
    expect(costFor(COSTS, 'u1', '2026-03-10')?.cost_rate).toBe(80);
    expect(costFor(COSTS, 'u1', '2026-07-01')?.cost_rate).toBe(95);
  });

  it('has nothing to say before the first rate, or for somebody with none', () => {
    expect(costFor(COSTS, 'u1', '2025-12-31')).toBeNull();
    expect(costFor(COSTS, 'u9', '2026-03-10')).toBeNull();
  });
});

describe('costOf', () => {
  it('is minutes at a rate per hour, to the cent', () => {
    expect(costOf(90, 80)).toBe(120);
    expect(costOf(37, 80)).toBe(49.33);
  });

  it('is unknown without a rate, never zero', () => {
    expect(costOf(60, null)).toBeNull();
  });
});

describe('profitability', () => {
  it('is revenue less cost, with the share it keeps', () => {
    const result = profitability([line()], COSTS);
    expect(result.total.revenue).toBe(185);
    expect(result.total.cost).toBe(80);
    expect(result.total.margin).toBe(105);
    expect(result.total.margin_percent).toBe(56.8);
  });

  it('charges the premium to the client without paying it to the person', () => {
    // An hour at time and a half bills 277.50 and still costs one hour of pay.
    const result = profitability([line({ rate_multiplier: 1.5 })], COSTS);
    expect(result.total.revenue).toBe(277.5);
    expect(result.total.cost).toBe(80);
  });

  it('counts non-billable time as cost with no revenue, which is the point of the measure', () => {
    // A written-off hour: the finance line carries no rate, so it earns
    // nothing, and the hour was still worked and still paid for.
    const result = profitability([line({ rate_snapshot: null })], COSTS);
    expect(result.total.revenue).toBeNull();
    expect(result.total.cost).toBe(80);
    expect(result.total.minutes_without_rate).toBe(60);
    // Revenue unknown means margin unknown, not margin of minus eighty.
    expect(result.total.margin).toBeNull();
  });

  it('never reads a missing cost rate as free work', () => {
    const result = profitability([line({ person_id: 'u9', person_name: 'New Joiner' })], COSTS);
    expect(result.total.revenue).toBe(185);
    expect(result.total.cost).toBeNull();
    expect(result.total.margin).toBeNull();
    expect(result.total.minutes_without_cost).toBe(60);
  });

  it('takes an adjustment away with its revenue, the way the invoice does', () => {
    const result = profitability([line(), line({ minutes: -30 })], COSTS);
    expect(result.total.minutes).toBe(30);
    expect(result.total.revenue).toBe(92.5);
    expect(result.total.cost).toBe(40);
    expect(result.total.margin).toBe(52.5);
  });

  it('breaks down by role and by person, worst margin first', () => {
    const result = profitability(
      [
        line(),
        line({ person_id: 'u2', person_name: 'Ben Okafor', role: 'team_lead', rate_snapshot: 130, minutes: 120 }),
      ],
      COSTS,
    );
    expect(result.by_person.map((row) => row.label)).toEqual(['Ben Okafor', 'Ana Costa']);
    // Two hours billed at 130 against two hours costing 120 is a thin 20.
    expect(result.by_person[0].margin).toBe(20);
    expect(result.by_role.map((row) => row.key)).toEqual(['team_lead', 'consultant']);
    expect(result.total.margin).toBe(125);
  });

  it('names every currency in play, so figures that do not add up say so', () => {
    const result = profitability(
      [line(), line({ person_id: 'u2', person_name: 'Ben Okafor', currency: 'GBP' })],
      [...COSTS, { person_id: 'u2', effective_from: '2026-01-01', cost_rate: 90, currency: 'GBP' }],
    );
    expect(result.currencies).toEqual(['GBP', 'USD']);
  });

  it('words a line with no role rather than losing it', () => {
    const result = profitability([line({ role: null })], COSTS);
    expect(result.by_role[0].label).toBe('No role on file');
  });

  it('has a share of nothing to report where there is no revenue to divide', () => {
    const result = profitability([line({ rate_snapshot: 0 })], COSTS);
    expect(result.total.revenue).toBe(0);
    expect(result.total.margin).toBe(-80);
    expect(result.total.margin_percent).toBeNull();
  });
});
