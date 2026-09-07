import { instantOf, localParts } from '../calendar/business-calendar.js';

/**
 * Report schedules (Dashboards & Report Packs functional 5.7; DR-05): when
 * the next pack is due in the account's zone, and which period it covers.
 * Weekly runs on an ISO weekday, monthly and quarterly on a day of the
 * month (clamped to the month's length); the period is the previous whole
 * week, month or quarter before the run day.
 */
export type Cadence = 'weekly' | 'monthly' | 'quarterly';
export type PeriodKind = 'previous_week' | 'previous_month' | 'previous_quarter';

export interface ScheduleSpec {
  readonly cadence: Cadence;
  /** ISO weekday (1 = Monday to 7 = Sunday) for weekly; day of month otherwise. */
  readonly runDay: number;
  /** HH:MM in the account zone. */
  readonly runTime: string;
  readonly periodKind: PeriodKind;
}

function minuteOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The first run instant strictly after `after`, in the zone. */
export function nextRunAt(spec: ScheduleSpec, after: Date, timeZone: string): Date {
  const minute = minuteOf(spec.runTime);
  const local = localParts(after, timeZone);
  if (spec.cadence === 'weekly') {
    const isoWeekday = local.weekday === 0 ? 7 : local.weekday;
    let delta = (spec.runDay - isoWeekday + 7) % 7;
    let candidate = instantOf(local.year, local.month, local.day + delta, minute, timeZone);
    if (candidate <= after) {
      delta += 7;
      candidate = instantOf(local.year, local.month, local.day + delta, minute, timeZone);
    }
    return candidate;
  }
  const step = spec.cadence === 'monthly' ? 1 : 3;
  for (let offset = 0; offset < 24; offset += step) {
    const month = local.month - 1 + offset;
    const year = local.year + Math.floor(month / 12);
    const monthOfYear = ((month % 12) + 12) % 12;
    const day = Math.min(spec.runDay, daysInMonth(year, monthOfYear + 1));
    const candidate = instantOf(year, monthOfYear + 1, day, minute, timeZone);
    if (candidate > after) return candidate;
  }
  throw new Error('no run instant found within two years');
}

/** The period a run made at `runAt` covers: local dates, inclusive. */
export function periodBefore(kind: PeriodKind, runAt: Date, timeZone: string): { start: string; end: string } {
  const local = localParts(runAt, timeZone);
  const today = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  if (kind === 'previous_week') {
    const weekday = today.getUTCDay() === 0 ? 7 : today.getUTCDay();
    const thisMonday = new Date(today.getTime() - (weekday - 1) * 86_400_000);
    const start = new Date(thisMonday.getTime() - 7 * 86_400_000);
    return { start: iso(start), end: iso(new Date(thisMonday.getTime() - 86_400_000)) };
  }
  if (kind === 'previous_month') {
    const start = new Date(Date.UTC(local.year, local.month - 2, 1));
    const end = new Date(Date.UTC(local.year, local.month - 1, 0));
    return { start: iso(start), end: iso(end) };
  }
  const quarter = Math.floor((local.month - 1) / 3);
  const start = new Date(Date.UTC(local.year, quarter * 3 - 3, 1));
  const end = new Date(Date.UTC(local.year, quarter * 3, 0));
  return { start: iso(start), end: iso(end) };
}
