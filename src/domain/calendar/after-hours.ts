import type { Calendar } from '../sla/engine.js';
import type { AfterHoursClass } from './business-calendar.js';

/**
 * After-hours classification of a time entry (Time, Contracts & Budget
 * TB-13; technical section 2 "After-hours class"). The class comes from the
 * account calendar for the date performed and, when the person stated it,
 * the start time; the contract's handling turns the class into a rate
 * multiplier (premium rate) or leaves it as a fact for the comp-time
 * report. Both are frozen on the entry when it is logged.
 */
export type AfterHoursHandling = 'premium_rate' | 'comp_time' | 'none';

export const AFTER_HOURS_CLASSES: readonly AfterHoursClass[] = ['standard', 'after_hours', 'weekend', 'holiday'];
export const AFTER_HOURS_HANDLINGS: readonly AfterHoursHandling[] = ['premium_rate', 'comp_time', 'none'];

/** "19:30" to 1170; undefined for anything that is not HH:MM on a 24-hour clock. */
export function minuteOfDay(start: string | null | undefined): number | undefined {
  if (!start) return undefined;
  const match = /^(\d{2}):(\d{2})$/.exec(start);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function classifies(
  calendar: Calendar,
): calendar is Calendar & { classify(date: string, minute?: number): AfterHoursClass } {
  return typeof (calendar as { classify?: unknown }).classify === 'function';
}

/**
 * The class of work performed on `date` (a local date in the calendar's
 * zone), optionally starting at `start` (HH:MM local). Without a calendar
 * (the wall clock) every minute is standard unless the person asserted
 * after hours; with one, the calendar decides, and the person's assertion
 * only counts when no start time lets the calendar judge.
 */
export function classifyPerformed(
  calendar: Calendar,
  date: string,
  start?: string | null,
  asserted?: boolean,
): AfterHoursClass {
  const minute = minuteOfDay(start);
  if (!classifies(calendar)) return asserted ? 'after_hours' : 'standard';
  const derived = calendar.classify(date, minute);
  if (derived === 'standard' && asserted && minute === undefined) return 'after_hours';
  return derived;
}

/** The multiplier frozen on the entry: the contract's premium for a non-standard class, otherwise 1. */
export function multiplierFor(
  handling: AfterHoursHandling,
  multiplier: number | null | undefined,
  afterHoursClass: AfterHoursClass,
): number {
  if (afterHoursClass === 'standard' || handling !== 'premium_rate') return 1;
  return multiplier && multiplier >= 1 ? multiplier : 1;
}
