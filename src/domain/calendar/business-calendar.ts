import type { Calendar } from '../sla/engine.js';

/**
 * The business calendar engine (Accounts & Administration technical 3.2;
 * TM-06): working hours per weekday in an IANA zone, a holiday set, and
 * the two operations the SLA engine needs: the instant `n` working minutes
 * after a start, and the working minutes between two instants. Pure and
 * dependency-free: zone math goes through Intl, minutes are wall-clock
 * minutes in the calendar's zone, so a day with a DST change still has
 * its configured hours (09:00 to 17:00 is 480 working minutes whatever
 * the clocks did that night).
 */
export interface CalendarHours {
  /** 0 = Sunday to 6 = Saturday, as stored. */
  readonly weekday: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface BusinessCalendarSpec {
  readonly id: string;
  readonly timeZone: string;
  readonly hours: readonly CalendarHours[];
  /** Local dates (YYYY-MM-DD) with no working time. */
  readonly holidays?: Iterable<string>;
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly minute: number;
  readonly date: string;
}

const MAX_DAYS = 5_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) parts[part.type] = part.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  return {
    year,
    month,
    day,
    weekday: WEEKDAYS[parts.weekday] ?? new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minute: hour * 60 + Number(parts.minute),
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** Zone offset in minutes at an instant (positive east of UTC). */
export function offsetMinutes(date: Date, timeZone: string): number {
  const local = localParts(date, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, 0, local.minute);
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** The instant of a local wall-clock time; across a DST gap the later offset wins, across a fold the earlier one. */
export function instantOf(year: number, month: number, day: number, minuteOfDay: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  let instant = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  const check = offsetMinutes(new Date(instant), timeZone);
  const corrected = guess - check * 60_000;
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

function nextDay(year: number, month: number, day: number): [number, number, number] {
  const next = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

export class CalendarError extends Error {}

export class BusinessCalendar implements Calendar {
  readonly id: string;
  readonly timeZone: string;
  private readonly byWeekday: Map<number, CalendarHours[]>;
  private readonly holidays: Set<string>;

  constructor(spec: BusinessCalendarSpec) {
    this.id = spec.id;
    this.timeZone = spec.timeZone;
    this.byWeekday = new Map();
    for (const hours of spec.hours) {
      if (hours.endMinute <= hours.startMinute) continue;
      const list = this.byWeekday.get(hours.weekday) ?? [];
      list.push(hours);
      this.byWeekday.set(hours.weekday, list);
    }
    for (const list of this.byWeekday.values()) list.sort((a, b) => a.startMinute - b.startMinute);
    this.holidays = new Set(spec.holidays ?? []);
    if (this.byWeekday.size === 0) throw new CalendarError(`calendar ${spec.id} has no working hours`);
  }

  private intervals(parts: LocalParts): CalendarHours[] {
    if (this.holidays.has(parts.date)) return [];
    return this.byWeekday.get(parts.weekday) ?? [];
  }

  isWorkingTime(at: Date): boolean {
    const parts = localParts(at, this.timeZone);
    return this.intervals(parts).some((hours) => parts.minute >= hours.startMinute && parts.minute < hours.endMinute);
  }

  nextWorkingInstant(at: Date): Date {
    let parts = localParts(at, this.timeZone);
    let minuteOfDay = parts.minute;
    let [year, month, day] = [parts.year, parts.month, parts.day];
    for (let steps = 0; steps < MAX_DAYS; steps += 1) {
      for (const hours of this.intervals(parts)) {
        if (hours.endMinute <= minuteOfDay) continue;
        if (hours.startMinute <= minuteOfDay && steps === 0) return at;
        return instantOf(year, month, day, Math.max(hours.startMinute, minuteOfDay), this.timeZone);
      }
      [year, month, day] = nextDay(year, month, day);
      minuteOfDay = 0;
      parts = localParts(instantOf(year, month, day, 0, this.timeZone), this.timeZone);
    }
    throw new CalendarError(`calendar ${this.id} found no working time within ${MAX_DAYS} days`);
  }

  /** The instant `minutes` working minutes after `from`; zero minutes is `from` itself, wherever it falls. */
  addMinutes(from: Date, minutes: number): Date {
    let remaining = Math.floor(minutes);
    if (remaining <= 0) return from;
    let parts = localParts(from, this.timeZone);
    let minuteOfDay = parts.minute;
    let [year, month, day] = [parts.year, parts.month, parts.day];
    for (let steps = 0; steps < MAX_DAYS; steps += 1) {
      for (const hours of this.intervals(parts)) {
        if (hours.endMinute <= minuteOfDay) continue;
        const start = Math.max(hours.startMinute, minuteOfDay);
        const available = hours.endMinute - start;
        if (remaining <= available) return instantOf(year, month, day, start + remaining, this.timeZone);
        remaining -= available;
      }
      [year, month, day] = nextDay(year, month, day);
      minuteOfDay = 0;
      parts = localParts(instantOf(year, month, day, 0, this.timeZone), this.timeZone);
    }
    throw new CalendarError(`calendar ${this.id} found no working time within ${MAX_DAYS} days`);
  }

  minutesBetween(a: Date, b: Date): number {
    if (b.getTime() <= a.getTime()) return 0;
    const start = localParts(a, this.timeZone);
    const end = localParts(b, this.timeZone);
    let total = 0;
    let [year, month, day] = [start.year, start.month, start.day];
    let parts = start;
    for (let steps = 0; steps < MAX_DAYS; steps += 1) {
      const last = parts.date === end.date;
      const from = steps === 0 ? start.minute : 0;
      const to = last ? end.minute : 1440;
      for (const hours of this.intervals(parts)) {
        const overlap = Math.min(hours.endMinute, to) - Math.max(hours.startMinute, from);
        if (overlap > 0) total += overlap;
      }
      if (last) return total;
      [year, month, day] = nextDay(year, month, day);
      parts = localParts(instantOf(year, month, day, 0, this.timeZone), this.timeZone);
      if (parts.date > end.date) return total;
    }
    return total;
  }
}

/** Validation for the editor: every entry in range, no overlap per weekday, at least one working interval. */
export function validateHours(hours: readonly CalendarHours[]): string[] {
  const problems: string[] = [];
  if (hours.length === 0) problems.push('at least one working interval is required');
  const byDay = new Map<number, CalendarHours[]>();
  for (const [index, entry] of hours.entries()) {
    if (!Number.isInteger(entry.weekday) || entry.weekday < 0 || entry.weekday > 6)
      problems.push(`entry ${index}: weekday must be 0 to 6`);
    if (!Number.isInteger(entry.startMinute) || entry.startMinute < 0 || entry.startMinute > 1440)
      problems.push(`entry ${index}: start must be 0 to 1440`);
    if (!Number.isInteger(entry.endMinute) || entry.endMinute < 0 || entry.endMinute > 1440)
      problems.push(`entry ${index}: end must be 0 to 1440`);
    if (entry.endMinute <= entry.startMinute) problems.push(`entry ${index}: end must be after start`);
    byDay.set(entry.weekday, [...(byDay.get(entry.weekday) ?? []), entry]);
  }
  for (const [weekday, list] of byDay) {
    const sorted = [...list].sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].startMinute < sorted[index - 1].endMinute)
        problems.push(`weekday ${weekday}: intervals overlap`);
    }
  }
  return problems;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
