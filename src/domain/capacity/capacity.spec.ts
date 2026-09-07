import { describe, expect, it } from 'vitest';
import { monthBounds, monthOf, personMonth, variance } from './capacity.js';

// September 2026: 22 weekdays, the 1st is a Tuesday.
const base = {
  month: '2026-09-01',
  workingDays: [1, 2, 3, 4, 5],
  hoursPerDay: 8,
  ftePercent: 100,
  overheadPercent: 10,
  startDate: null,
  endDate: null,
  holidays: new Set<string>(),
  pto: [],
  allocatedMinutes: 0,
  actualMinutes: 0,
};

describe('monthBounds and monthOf', () => {
  it('finds the month edges', () => {
    expect(monthBounds('2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthBounds('2026-02-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthOf('2026-09-17')).toBe('2026-09-01');
  });
});

describe('personMonth', () => {
  it('contracts the working days at the FTE and takes the overhead off', () => {
    const result = personMonth(base);
    expect(result.working_days).toBe(22);
    expect(result.contracted_minutes).toBe(22 * 480);
    expect(result.overhead_minutes).toBe(1056);
    expect(result.available_minutes).toBe(10560 - 1056);
    expect(result.status).toBe('available');
  });

  it('applies the FTE and the employment dates', () => {
    const half = personMonth({ ...base, ftePercent: 50 });
    expect(half.contracted_minutes).toBe(5280);
    const joiner = personMonth({ ...base, startDate: '2026-09-21' });
    expect(joiner.working_days).toBe(8);
    const leaver = personMonth({ ...base, endDate: '2026-09-04' });
    expect(leaver.working_days).toBe(4);
  });

  it('counts a holiday first and never double-counts it inside PTO', () => {
    const result = personMonth({
      ...base,
      holidays: new Set(['2026-09-07']),
      pto: [
        { starts_on: '2026-09-07', ends_on: '2026-09-09', fraction: 1 },
        { starts_on: '2026-09-11', ends_on: '2026-09-11', fraction: 0.5 },
      ],
    });
    expect(result.holiday_minutes).toBe(480);
    expect(result.pto_minutes).toBe(2 * 480 + 240);
    expect(result.available_minutes).toBe(Math.round((10560 - 480 - 1200) * 0.9));
  });

  it('flags warning and over against the allocation, and no_calendar without hours', () => {
    const available = personMonth(base).available_minutes;
    expect(personMonth({ ...base, allocatedMinutes: Math.round(available * 0.95) }).status).toBe('warning');
    expect(personMonth({ ...base, allocatedMinutes: available + 60 }).status).toBe('over');
    expect(personMonth({ ...base, allocatedMinutes: available + 60 }).remaining_minutes).toBe(0);
    expect(personMonth({ ...base, workingDays: null, allocatedMinutes: 60 })).toMatchObject({
      status: 'no_calendar',
      available_minutes: 0,
    });
  });

  it('accepts 7 for Sunday on a weekend calendar', () => {
    const weekend = personMonth({ ...base, workingDays: [6, 7] });
    expect(weekend.working_days).toBe(8);
  });
});

describe('variance', () => {
  it('signs the minutes and ratios only against a plan', () => {
    expect(variance(600, 450)).toEqual({ variance_minutes: -150, variance_ratio: -0.25 });
    expect(variance(0, 120)).toEqual({ variance_minutes: 120, variance_ratio: null });
  });
});
