import { describe, expect, it } from 'vitest';
import { nextRunAt, periodBefore } from './schedule.js';

describe('nextRunAt', () => {
  it('weekly: the next Monday 06:00 in the zone, strictly after the reference', () => {
    const spec = { cadence: 'weekly' as const, runDay: 1, runTime: '06:00', periodKind: 'previous_week' as const };
    // Wednesday 2026-09-02 12:00Z: next Monday is the 7th, 06:00 London = 05:00Z.
    expect(nextRunAt(spec, new Date('2026-09-02T12:00:00Z'), 'Europe/London').toISOString()).toBe(
      '2026-09-07T05:00:00.000Z',
    );
    // Exactly at the instant: the following week.
    expect(nextRunAt(spec, new Date('2026-09-07T05:00:00Z'), 'Europe/London').toISOString()).toBe(
      '2026-09-14T05:00:00.000Z',
    );
    // Just before it: the same day.
    expect(nextRunAt(spec, new Date('2026-09-07T04:59:00Z'), 'Europe/London').toISOString()).toBe(
      '2026-09-07T05:00:00.000Z',
    );
  });

  it('monthly and quarterly: the day of month clamped to the month, in the zone', () => {
    const monthly = {
      cadence: 'monthly' as const,
      runDay: 31,
      runTime: '09:00',
      periodKind: 'previous_month' as const,
    };
    expect(nextRunAt(monthly, new Date('2026-02-10T00:00:00Z'), 'UTC').toISOString()).toBe('2026-02-28T09:00:00.000Z');
    expect(nextRunAt(monthly, new Date('2026-02-28T09:00:00Z'), 'UTC').toISOString()).toBe('2026-03-31T09:00:00.000Z');
    const quarterly = {
      cadence: 'quarterly' as const,
      runDay: 1,
      runTime: '08:00',
      periodKind: 'previous_quarter' as const,
    };
    expect(nextRunAt(quarterly, new Date('2026-09-07T00:00:00Z'), 'America/Sao_Paulo').toISOString()).toBe(
      '2026-12-01T11:00:00.000Z',
    );
  });
});

describe('periodBefore', () => {
  it('names the previous whole week, month or quarter in local dates', () => {
    expect(periodBefore('previous_week', new Date('2026-09-07T05:00:00Z'), 'Europe/London')).toEqual({
      start: '2026-08-31',
      end: '2026-09-06',
    });
    expect(periodBefore('previous_week', new Date('2026-09-09T12:00:00Z'), 'UTC')).toEqual({
      start: '2026-08-31',
      end: '2026-09-06',
    });
    expect(periodBefore('previous_month', new Date('2026-03-01T09:00:00Z'), 'UTC')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(periodBefore('previous_quarter', new Date('2026-10-01T08:00:00Z'), 'UTC')).toEqual({
      start: '2026-07-01',
      end: '2026-09-30',
    });
    expect(periodBefore('previous_quarter', new Date('2026-01-01T08:00:00Z'), 'UTC')).toEqual({
      start: '2025-10-01',
      end: '2025-12-31',
    });
  });
});
