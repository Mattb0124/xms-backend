import { describe, expect, it } from 'vitest';
import {
  latch,
  markMet,
  pause,
  remaining,
  restampForPriority,
  resume,
  startClocks,
  view,
  WALL_CLOCK,
  type Clock,
} from './engine.js';

/**
 * Ticket Management technical 8: pause and resume shift exactly the
 * excluded minutes (the proof-of-concept case: a 10-minute pause shifts
 * both due times by 600 seconds); latch-before-pause; resume-then-latch;
 * restamp from the moment of change; a breach can never be rescued.
 */
const t0 = new Date('2026-09-07T09:00:00Z');
const minutes = (n: number): Date => new Date(t0.getTime() + n * 60_000);

function clocks(): Clock[] {
  return startClocks({ response_minutes: 60, resolution_minutes: 480 }, 'policy-v1', WALL_CLOCK, t0);
}

describe('startClocks', () => {
  it('creates one clock per configured target with the due time from the calendar', () => {
    const result = clocks();
    expect(result.map((clock) => clock.kind)).toEqual(['response', 'resolution']);
    expect(result[0].dueAt).toEqual(minutes(60));
    expect(result[1].dueAt).toEqual(minutes(480));
  });

  it('creates no clock for a null target (No SLA)', () => {
    expect(startClocks({ response_minutes: null, resolution_minutes: null }, 'p', WALL_CLOCK, t0)).toEqual([]);
  });
});

describe('pause and resume', () => {
  it('a 10 minute pause shifts both due times by exactly 600 seconds', () => {
    const [response, resolution] = clocks();
    const pausedResponse = pause(response, minutes(5));
    const pausedResolution = pause(resolution, minutes(5));
    const resumedResponse = resume(pausedResponse, WALL_CLOCK, minutes(15));
    const resumedResolution = resume(pausedResolution, WALL_CLOCK, minutes(15));
    expect(resumedResponse.excludedMinutes).toBe(10);
    expect(resumedResponse.clock.dueAt.getTime() - response.dueAt.getTime()).toBe(600_000);
    expect(resumedResolution.clock.dueAt.getTime() - resolution.dueAt.getTime()).toBe(600_000);
    expect(resumedResponse.clock.pausedTotalMinutes).toBe(10);
    expect(resumedResponse.clock.pausedAt).toBeNull();
  });

  it('does not tick while paused', () => {
    const [response] = clocks();
    const paused = pause(response, minutes(30));
    expect(remaining(paused, WALL_CLOCK, minutes(59))).toBe(30);
    expect(remaining(paused, WALL_CLOCK, minutes(500))).toBe(30);
  });

  it('pausing twice or resuming an unpaused clock is a no-op', () => {
    const [response] = clocks();
    const once = pause(response, minutes(1));
    expect(pause(once, minutes(2))).toBe(once);
    expect(resume(response, WALL_CLOCK, minutes(2)).excludedMinutes).toBe(0);
  });
});

describe('latch', () => {
  it('latches once the due time has passed and never again', () => {
    const [response] = clocks();
    expect(latch(response, minutes(59)).latched).toBe(false);
    const first = latch(response, minutes(60));
    expect(first.latched).toBe(true);
    expect(first.clock.breachedAt).toEqual(minutes(60));
    expect(latch(first.clock, minutes(61)).latched).toBe(false);
  });

  it('a breach cannot be rescued by pausing after the fact (latch runs before pause)', () => {
    const [response] = clocks();
    const overdue = minutes(61);
    const latched = latch(response, overdue).clock;
    const paused = pause(latched, overdue);
    expect(paused.breachedAt).toEqual(overdue);
    expect(paused.pausedAt).toBeNull();
  });

  it('does not latch a paused clock; resumed time counts (latch runs after resume)', () => {
    const [response] = clocks();
    const paused = pause(response, minutes(30));
    expect(latch(paused, minutes(120)).latched).toBe(false);
    const resumed = resume(paused, WALL_CLOCK, minutes(120)).clock;
    expect(resumed.dueAt).toEqual(minutes(150));
    expect(latch(resumed, minutes(149)).latched).toBe(false);
    expect(latch(resumed, minutes(150)).latched).toBe(true);
  });
});

describe('markMet', () => {
  it('stops the clock and keeps an earlier latch', () => {
    const [response] = clocks();
    const late = latch(response, minutes(70)).clock;
    const met = markMet(late, minutes(75));
    expect(met.metAt).toEqual(minutes(75));
    expect(met.breachedAt).toEqual(minutes(70));
    expect(latch(met, minutes(500)).latched).toBe(false);
  });
});

describe('restampForPriority', () => {
  it('restamps the remaining window from the moment of change', () => {
    const [, resolution] = clocks();
    // 100 minutes consumed, new target 240: due in 140 minutes from now.
    const restamped = restampForPriority(resolution, 240, WALL_CLOCK, minutes(100));
    expect(restamped.targetMinutes).toBe(240);
    expect(restamped.dueAt).toEqual(minutes(240));
  });

  it('excludes paused minutes from the consumed time', () => {
    const [, resolution] = clocks();
    const resumed = resume(pause(resolution, minutes(10)), WALL_CLOCK, minutes(40)).clock;
    const restamped = restampForPriority(resumed, 120, WALL_CLOCK, minutes(100));
    // consumed = 100 - 30 paused = 70; remaining = 50
    expect(restamped.dueAt).toEqual(minutes(150));
  });

  it('a shorter target already exhausted is due now, and still latches only through latch', () => {
    const [, resolution] = clocks();
    const restamped = restampForPriority(resolution, 30, WALL_CLOCK, minutes(100));
    expect(restamped.dueAt).toEqual(minutes(100));
    expect(restamped.breachedAt).toBeNull();
    expect(latch(restamped, minutes(100)).latched).toBe(true);
  });
});

describe('view', () => {
  it('reports negative remaining minutes once overdue and the flags', () => {
    const [response] = clocks();
    const v = view(latch(response, minutes(90)).clock, WALL_CLOCK, minutes(90));
    expect(v).toMatchObject({
      kind: 'response',
      remainingMinutes: -30,
      breached: true,
      paused: false,
      met: false,
      targetMinutes: 60,
    });
  });
});
