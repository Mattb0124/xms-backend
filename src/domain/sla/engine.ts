/**
 * The SLA engine (Ticket Management technical 3.2), ported from the studio
 * XMS proof of concept and generalised over a calendar. Pure: every function
 * takes the clock and the instant and returns the next clock. The service
 * persists what comes back and writes the pause rows as evidence.
 *
 * Ordering rule kept from the proof of concept: on any mutation, `latch`
 * runs before `pause` so a blown clock cannot be rescued by pausing after
 * the fact, and `latch` runs after `resume` so resumed time counts.
 */
export interface Calendar {
  readonly id: string;
  /** The instant `minutes` working minutes after `from`. */
  addMinutes(from: Date, minutes: number): Date;
  /** Working minutes between two instants (zero when b <= a). */
  minutesBetween(a: Date, b: Date): number;
}

/** Wall clock: every minute is a working minute (the day-30 calendar). */
export const WALL_CLOCK: Calendar = {
  id: '24x7',
  addMinutes: (from, minutes) => new Date(from.getTime() + minutes * 60_000),
  minutesBetween: (a, b) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60_000)),
};

export type ClockKind = 'response' | 'resolution';

export interface Clock {
  readonly kind: ClockKind;
  readonly policyRef: string;
  readonly calendarId: string;
  readonly targetMinutes: number;
  readonly startedAt: Date;
  readonly dueAt: Date;
  readonly pausedAt: Date | null;
  readonly pausedTotalMinutes: number;
  readonly metAt: Date | null;
  readonly breachedAt: Date | null;
}

export interface SlaTargets {
  readonly response_minutes: number | null;
  readonly resolution_minutes: number | null;
}

export function startClocks(targets: SlaTargets, policyRef: string, calendar: Calendar, now: Date): Clock[] {
  const clocks: Clock[] = [];
  const make = (kind: ClockKind, minutes: number): Clock => ({
    kind,
    policyRef,
    calendarId: calendar.id,
    targetMinutes: minutes,
    startedAt: now,
    dueAt: calendar.addMinutes(now, minutes),
    pausedAt: null,
    pausedTotalMinutes: 0,
    metAt: null,
    breachedAt: null,
  });
  if (targets.response_minutes && targets.response_minutes > 0) clocks.push(make('response', targets.response_minutes));
  if (targets.resolution_minutes && targets.resolution_minutes > 0)
    clocks.push(make('resolution', targets.resolution_minutes));
  return clocks;
}

export function isLive(clock: Clock): boolean {
  return clock.metAt === null && clock.breachedAt === null;
}

/** Idempotent: returns the clock and whether it newly latched. */
export function latch(clock: Clock, now: Date): { clock: Clock; latched: boolean } {
  if (!isLive(clock) || clock.pausedAt !== null) return { clock, latched: false };
  if (now.getTime() < clock.dueAt.getTime()) return { clock, latched: false };
  return { clock: { ...clock, breachedAt: now }, latched: true };
}

export function pause(clock: Clock, now: Date): Clock {
  if (!isLive(clock) || clock.pausedAt !== null) return clock;
  return { ...clock, pausedAt: now };
}

/** Resumes and shifts the due time by the excluded working minutes. */
export function resume(clock: Clock, calendar: Calendar, now: Date): { clock: Clock; excludedMinutes: number } {
  if (clock.pausedAt === null) return { clock, excludedMinutes: 0 };
  const excluded = calendar.minutesBetween(clock.pausedAt, now);
  const next: Clock = {
    ...clock,
    pausedAt: null,
    pausedTotalMinutes: clock.pausedTotalMinutes + excluded,
    dueAt: calendar.addMinutes(clock.dueAt, excluded),
  };
  return { clock: next, excludedMinutes: excluded };
}

export function markMet(clock: Clock, now: Date): Clock {
  if (clock.metAt !== null) return clock;
  // A breached clock can still be met (late), the latch stays.
  return { ...clock, metAt: now };
}

/**
 * A priority change restamps the remaining window from the moment of the
 * change: the new due time is now plus the new target minus the minutes
 * already consumed (working minutes since start, excluding pauses).
 */
export function restampForPriority(clock: Clock, newTargetMinutes: number, calendar: Calendar, now: Date): Clock {
  if (!isLive(clock)) return clock;
  const consumed = calendar.minutesBetween(clock.startedAt, clock.pausedAt ?? now) - clock.pausedTotalMinutes;
  const remaining = Math.max(0, newTargetMinutes - Math.max(0, consumed));
  return { ...clock, targetMinutes: newTargetMinutes, dueAt: calendar.addMinutes(clock.pausedAt ?? now, remaining) };
}

export interface ClockView {
  readonly kind: ClockKind;
  readonly dueAt: string;
  readonly remainingMinutes: number;
  readonly paused: boolean;
  readonly breached: boolean;
  readonly met: boolean;
  readonly targetMinutes: number;
  readonly pausedTotalMinutes: number;
}

export function remaining(clock: Clock, calendar: Calendar, now: Date): number {
  const reference = clock.pausedAt ?? now;
  const signed =
    clock.dueAt.getTime() >= reference.getTime()
      ? calendar.minutesBetween(reference, clock.dueAt)
      : -calendar.minutesBetween(clock.dueAt, reference);
  return signed;
}

export function view(clock: Clock, calendar: Calendar, now: Date): ClockView {
  return {
    kind: clock.kind,
    dueAt: clock.dueAt.toISOString(),
    remainingMinutes: remaining(clock, calendar, now),
    paused: clock.pausedAt !== null,
    breached: clock.breachedAt !== null,
    met: clock.metAt !== null,
    targetMinutes: clock.targetMinutes,
    pausedTotalMinutes: clock.pausedTotalMinutes,
  };
}
