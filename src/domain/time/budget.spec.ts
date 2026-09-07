import { describe, expect, it } from 'vitest';
import { amountOf, carryOver, forecast, overageDecision, rateFor, thresholdsToFire } from './budget.js';

const weekdays = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

describe('forecast', () => {
  // September 2026: 22 business days; the 1st is a Tuesday.
  const base = {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    available: 2400,
    windowDays: 10,
    isBusinessDay: weekdays,
  };

  it('projects the run rate over the business days left', () => {
    const consumedByDay = new Map([
      ['2026-09-07', 120],
      ['2026-09-08', 120],
      ['2026-09-09', 120],
      ['2026-09-10', 120],
    ]);
    const result = forecast({ ...base, today: '2026-09-10', consumed: 480, consumedByDay });
    expect(result.business_days_total).toBe(22);
    expect(result.business_days_elapsed).toBe(8);
    expect(result.window_days).toBe(8);
    expect(result.run_rate_minutes).toBe(60);
    expect(result.forecast_minutes).toBe(480 + 60 * 14);
    expect(result.forecast_percent).toBe(55);
    expect(result.business_days_to_exhaustion).toBe(32);
  });

  it('uses only the last N business days for the run rate', () => {
    const consumedByDay = new Map([['2026-09-01', 600]]);
    const result = forecast({ ...base, today: '2026-09-18', consumed: 600, consumedByDay, windowDays: 5 });
    expect(result.window_days).toBe(5);
    expect(result.run_rate_minutes).toBe(0);
    expect(result.forecast_minutes).toBe(600);
    expect(result.business_days_to_exhaustion).toBeNull();
  });

  it('reports zero days to exhaustion once the budget is gone and nothing without a budget', () => {
    const gone = forecast({ ...base, today: '2026-09-10', consumed: 2500, consumedByDay: new Map() });
    expect(gone.business_days_to_exhaustion).toBe(0);
    const tm = forecast({ ...base, available: 0, today: '2026-09-10', consumed: 300, consumedByDay: new Map() });
    expect(tm.forecast_percent).toBe(0);
    expect(tm.business_days_to_exhaustion).toBeNull();
  });
});

describe('thresholdsToFire', () => {
  it('returns the crossed percentages not yet fired, ascending, and nothing without a budget', () => {
    expect(thresholdsToFire([50, 75, 90, 100], [], 1800, 2400)).toEqual([50, 75]);
    expect(thresholdsToFire([100, 50, 90, 75], [50], 2400, 2400)).toEqual([75, 90, 100]);
    expect(thresholdsToFire([50, 75], [50, 75], 2400, 2400)).toEqual([]);
    expect(thresholdsToFire([50], [], 100, 0)).toEqual([]);
  });
});

describe('overageDecision', () => {
  it('fits inside the budget or without one', () => {
    expect(overageDecision('block', 2400, 2000, 400, null)).toMatchObject({ blocked: false, overBudget: false });
    expect(overageDecision('block', 0, 5000, 400, null)).toMatchObject({ blocked: false, overBudget: false });
  });

  it('blocks, flags or rates the minutes beyond the budget', () => {
    expect(overageDecision('block', 2400, 2300, 200, null)).toMatchObject({ blocked: true, overageMinutes: 100 });
    expect(overageDecision('allow_flag', 2400, 2300, 200, 1.5)).toMatchObject({
      blocked: false,
      overBudget: true,
      overageMinutes: 100,
      multiplier: 1,
    });
    expect(overageDecision('allow_rate', 2400, 2300, 200, 1.5)).toMatchObject({ overBudget: true, multiplier: 1.5 });
    expect(overageDecision('allow_rate', 2400, 2500, 60, null)).toMatchObject({ overageMinutes: 60, multiplier: 1 });
  });
});

describe('rateFor and amountOf', () => {
  const cards = [
    {
      id: 'acct-1',
      contract_id: null,
      effective_from: '2026-01-01',
      entries: [{ role: 'consultant', bill_rate: 150, overage_rate: null }],
    },
    {
      id: 'acct-2',
      contract_id: null,
      effective_from: '2026-07-01',
      entries: [{ role: 'consultant', bill_rate: 160, overage_rate: 200 }],
    },
    {
      id: 'ct-1',
      contract_id: 'ct',
      effective_from: '2026-03-01',
      entries: [{ role: 'consultant', bill_rate: 140, overage_rate: null }],
    },
  ];

  it('prefers the contract card in force, else the account default in force, else none', () => {
    expect(rateFor(cards, 'consultant', '2026-08-01')).toMatchObject({ rate: 140, cardId: 'ct-1', source: 'contract' });
    expect(rateFor(cards, 'consultant', '2026-02-01')).toMatchObject({
      rate: 150,
      cardId: 'acct-1',
      source: 'account',
    });
    expect(
      rateFor(
        cards.filter((c) => c.contract_id === null),
        'consultant',
        '2026-08-01',
      ),
    ).toMatchObject({
      rate: 160,
      overageRate: 200,
      source: 'account',
    });
    expect(rateFor(cards, 'architect', '2026-08-01')).toEqual({
      rate: null,
      overageRate: null,
      cardId: null,
      source: null,
    });
    expect(rateFor(cards, 'consultant', '2025-12-31').rate).toBeNull();
  });

  it('computes the amount to the cent', () => {
    expect(amountOf(45, 150, 1)).toBe(112.5);
    expect(amountOf(45, 150, 1.5)).toBe(168.75);
    expect(amountOf(45, null, 1)).toBeNull();
    expect(amountOf(7, 99.99, 1)).toBe(11.67);
  });
});

describe('carryOver', () => {
  const previous = {
    starts_on: '2026-08-01',
    ends_on: '2026-08-31',
    contracted_minutes: 2400,
    carried_over_minutes: 300,
    consumed_minutes: 2000,
  };

  it('carries nothing under none or without a previous period', () => {
    expect(carryOver('none', null, previous, '2026-09-01')).toBe(0);
    expect(carryOver('carry_term', null, null, '2026-09-01')).toBe(0);
  });

  it('carry_month carries the unused contracted minutes of the adjacent period only', () => {
    expect(carryOver('carry_month', null, previous, '2026-09-01')).toBe(400);
    expect(carryOver('carry_month', null, previous, '2026-10-01')).toBe(0);
    expect(carryOver('carry_month', null, { ...previous, consumed_minutes: 2600 }, '2026-09-01')).toBe(0);
  });

  it('carry_term accumulates and cap bounds it', () => {
    expect(carryOver('carry_term', null, previous, '2026-09-01')).toBe(700);
    expect(carryOver('cap', 5, previous, '2026-09-01')).toBe(300);
    expect(carryOver('cap', 20, previous, '2026-09-01')).toBe(700);
  });
});
