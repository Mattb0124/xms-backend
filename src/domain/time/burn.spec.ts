import { describe, expect, it } from 'vitest';
import { position } from './burn.js';

const classes = [
  { key: 'billable', consumes_contract: true },
  { key: 'non_billable', consumes_contract: false },
  { key: 'absorbed', consumes_contract: false },
];
const period = { starts_on: '2026-09-01', ends_on: '2026-09-30', contracted_minutes: 2400, carried_over_minutes: 600 };

describe('contract position', () => {
  it('sums consuming classes against the available minutes and reports the rest', () => {
    const result = position(
      period,
      [
        { activity_type: 'analysis', billable_class: 'billable', minutes: 600 },
        { activity_type: 'development', billable_class: 'billable', minutes: 300 },
        { activity_type: 'rework', billable_class: 'absorbed', minutes: 120 },
      ],
      classes,
      new Date('2026-09-10T12:00:00Z'),
    );
    expect(result).toMatchObject({
      available_minutes: 3000,
      consumed_minutes: 900,
      non_consuming_minutes: 120,
      remaining_minutes: 2100,
      percent_consumed: 30,
      by_class: { billable: 900, absorbed: 120 },
      by_activity: { analysis: 600, development: 300, rework: 120 },
    });
    expect(result.period).toEqual({ starts_on: '2026-09-01', ends_on: '2026-09-30', days_total: 30, days_elapsed: 10 });
    expect(result.percent_elapsed).toBe(33.3);
    expect(result.projected_minutes).toBe(2700);
    expect(result.status).toBe('on_track');
  });

  it('flags watch when the projection exceeds the allowance and over when consumed exceeds it', () => {
    const heavy = position(
      period,
      [{ activity_type: 'analysis', billable_class: 'billable', minutes: 1500 }],
      classes,
      new Date('2026-09-10T00:00:00Z'),
    );
    expect(heavy.status).toBe('watch');
    expect(heavy.projected_minutes).toBe(4500);
    const over = position(
      period,
      [{ activity_type: 'analysis', billable_class: 'billable', minutes: 3100 }],
      classes,
      new Date('2026-09-28T00:00:00Z'),
    );
    expect(over.status).toBe('over');
    expect(over.remaining_minutes).toBe(0);
  });

  it('handles a period that has not started and a zero allowance', () => {
    const early = position(period, [], classes, new Date('2026-08-20T00:00:00Z'));
    expect(early.period.days_elapsed).toBe(0);
    expect(early.projected_minutes).toBe(0);
    const free = position(
      { ...period, contracted_minutes: 0, carried_over_minutes: 0 },
      [{ activity_type: 'x', billable_class: 'billable', minutes: 60 }],
      classes,
      new Date('2026-09-10T00:00:00Z'),
    );
    expect(free.percent_consumed).toBe(0);
    expect(free.status).toBe('on_track');
  });
});
