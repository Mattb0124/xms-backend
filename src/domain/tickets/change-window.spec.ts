import { describe, expect, it } from 'vitest';
import {
  freezeAt,
  freezeOverlapping,
  freezeProblems,
  insideWindow,
  spansOverlap,
  withinSpan,
  type ChangeWindow,
} from './change-window.js';

const window = (over: Partial<ChangeWindow> = {}): ChangeWindow => ({
  id: 'w1',
  name: 'Azure Files cutover',
  startsAt: new Date('2026-11-14T22:00:00Z'),
  endsAt: new Date('2026-11-15T06:00:00Z'),
  freezeWindows: [],
  status: 'active',
  ...over,
});

describe('change window spans', () => {
  it('holds an instant from its start up to but not including its end', () => {
    const w = window();
    expect(insideWindow(w, new Date('2026-11-14T22:00:00Z'))).toBe(true);
    expect(insideWindow(w, new Date('2026-11-15T01:00:00Z'))).toBe(true);
    // Back-to-back windows never both hold the boundary.
    expect(insideWindow(w, new Date('2026-11-15T06:00:00Z'))).toBe(false);
    expect(insideWindow(w, new Date('2026-11-14T21:59:59Z'))).toBe(false);
  });

  it('is never inside a window that has no schedule', () => {
    expect(insideWindow(window({ startsAt: null }), new Date('2026-11-15T01:00:00Z'))).toBe(false);
    expect(insideWindow(window({ endsAt: null }), new Date('2026-11-15T01:00:00Z'))).toBe(false);
  });

  it('detects overlapping spans and touching ones that do not overlap', () => {
    const a = { startsAt: new Date('2026-11-14T22:00:00Z'), endsAt: new Date('2026-11-15T06:00:00Z') };
    expect(
      spansOverlap(a, { startsAt: new Date('2026-11-15T05:00:00Z'), endsAt: new Date('2026-11-15T08:00:00Z') }),
    ).toBe(true);
    expect(
      spansOverlap(a, { startsAt: new Date('2026-11-15T06:00:00Z'), endsAt: new Date('2026-11-15T08:00:00Z') }),
    ).toBe(false);
    expect(withinSpan(a, new Date('2026-11-15T00:00:00Z'))).toBe(true);
  });
});

describe('freeze windows', () => {
  const frozen = window({
    freezeWindows: [{ starts_at: '2026-11-15T00:00:00Z', ends_at: '2026-11-15T02:00:00Z', reason: 'Year end' }],
  });

  it('names the freeze covering an instant and the one a whole span runs into', () => {
    expect(freezeAt(frozen, new Date('2026-11-15T01:00:00Z'))?.reason).toBe('Year end');
    expect(freezeAt(frozen, new Date('2026-11-15T03:00:00Z'))).toBeUndefined();
    expect(
      freezeOverlapping(frozen, {
        startsAt: new Date('2026-11-14T22:00:00Z'),
        endsAt: new Date('2026-11-15T06:00:00Z'),
      })?.reason,
    ).toBe('Year end');
    expect(
      freezeOverlapping(frozen, {
        startsAt: new Date('2026-11-15T02:00:00Z'),
        endsAt: new Date('2026-11-15T06:00:00Z'),
      }),
    ).toBeUndefined();
  });

  it('names every problem with a freeze rather than accepting one nobody can apply', () => {
    expect(
      freezeProblems([
        { starts_at: 'not a date', ends_at: '2026-11-15T02:00:00Z' },
        { starts_at: '2026-11-15T02:00:00Z', ends_at: '2026-11-15T02:00:00Z' },
      ]),
    ).toEqual(['freeze 0: starts_at is not a date', 'freeze 1: ends_at must be after starts_at']);
  });
});
