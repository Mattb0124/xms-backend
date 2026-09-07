import { describe, expect, it } from 'vitest';
import { days, unloggedByDay, weekBounds } from './unlogged.js';

describe('unlogged time', () => {
  it('reports expected minus logged per working day, nothing on weekends and holidays, never negative', () => {
    const result = unloggedByDay({
      from: '2026-04-06',
      to: '2026-04-12',
      calendar: { workingDays: [1, 2, 3, 4, 5], hoursPerDay: 8 },
      holidays: new Set(['2026-04-06']),
      logged: new Map([
        ['2026-04-07', 240],
        ['2026-04-08', 600],
        ['2026-04-11', 60],
      ]),
    });
    expect(
      result.map((day) => `${day.date}:${day.expected_minutes}/${day.logged_minutes}/${day.unlogged_minutes}`),
    ).toEqual([
      '2026-04-06:0/0/0',
      '2026-04-07:480/240/240',
      '2026-04-08:480/600/0',
      '2026-04-09:480/0/480',
      '2026-04-10:480/0/480',
      '2026-04-11:0/60/0',
      '2026-04-12:0/0/0',
    ]);
    expect(result[0].holiday).toBe(true);
    expect(result[5].weekday).toBe(6);
  });

  it('falls back to a five-day eight-hour calendar and honours a part-time one', () => {
    const fallback = unloggedByDay({
      from: '2026-04-08',
      to: '2026-04-08',
      calendar: null,
      holidays: new Set(),
      logged: new Map(),
    });
    expect(fallback[0]).toMatchObject({ expected_minutes: 480, unlogged_minutes: 480 });
    const partTime = unloggedByDay({
      from: '2026-04-06',
      to: '2026-04-10',
      calendar: { workingDays: [1, 3, 5], hoursPerDay: 6.5 },
      holidays: new Set(),
      logged: new Map(),
    });
    expect(partTime.map((day) => day.expected_minutes)).toEqual([390, 0, 390, 0, 390]);
  });

  it('computes ISO week bounds from a date or a week string', () => {
    expect(weekBounds('2026-04-08')).toEqual({ from: '2026-04-06', to: '2026-04-12' });
    expect(weekBounds('2026-W15')).toEqual({ from: '2026-04-06', to: '2026-04-12' });
    expect(weekBounds('2026-01-01')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
    expect([...days('2026-02-27', '2026-03-02')]).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });
});
