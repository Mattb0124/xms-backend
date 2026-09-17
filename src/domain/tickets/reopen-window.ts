import { BusinessCalendar, localParts } from '../calendar/business-calendar.js';

/**
 * Reopen window after Resolved or Closed (Email Intake functional §5.3 /
 * open question 8). Pure: the service loads settings, the type override and
 * the account calendar, then asks this module. Inbound, the portal list and
 * the transition API share it so the three surfaces cannot drift.
 */
export type WindowSource = 'account' | 'type_override';

export interface ReopenCalendar {
  readonly timeZone: string;
  isWorkingDate(localDate: string): boolean;
}

export interface WindowResolution {
  readonly days: number;
  readonly source: WindowSource;
}

export interface ReopenDecision {
  readonly allowed: boolean;
  readonly startedOn: string | null;
  readonly deadline: string | null;
}

/** What GET /transitions and the 409 body carry, so the three surfaces cannot drift. */
export interface ReopenWindowView {
  readonly days: number;
  readonly source: WindowSource;
  readonly started_on: string | null;
  readonly deadline: string | null;
  readonly allowed: boolean;
}

const MAX_STEPS = 5_000;

/** Monday to Friday, the fallback when the account has no business calendar. */
export function isWeekday(day: string): boolean {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

export function weekdayCalendar(timeZone: string): ReopenCalendar {
  return { timeZone, isWorkingDate: isWeekday };
}

export function fromBusinessCalendar(calendar: BusinessCalendar): ReopenCalendar {
  return { timeZone: calendar.timeZone, isWorkingDate: (date) => calendar.isWorkingDate(date) };
}

export function resolveWindowDays(
  accountDays: number,
  typeOverride: number | null | undefined,
): WindowResolution {
  if (typeOverride !== null && typeOverride !== undefined) {
    return { days: typeOverride, source: 'type_override' };
  }
  return { days: accountDays, source: 'account' };
}

export function localDateOn(instant: Date, timeZone: string): string {
  return localParts(instant, timeZone).date;
}

export function mayReopen(input: {
  windowDays: number;
  resolvedAt: Date | string | null | undefined;
  closedAt: Date | string | null | undefined;
  now: Date;
  calendar: ReopenCalendar;
}): ReopenDecision {
  const start = input.resolvedAt ?? input.closedAt ?? null;
  if (start === null || start === undefined || start === '') {
    return { allowed: false, startedOn: null, deadline: null };
  }
  const startedOn = localDateOn(asDate(start), input.calendar.timeZone);
  if (!Number.isInteger(input.windowDays) || input.windowDays <= 0) {
    return { allowed: false, startedOn, deadline: null };
  }
  const deadline = addWorkingDays(startedOn, input.windowDays, input.calendar);
  const today = localDateOn(input.now, input.calendar.timeZone);
  return { allowed: today <= deadline, startedOn, deadline };
}

export function toWindowView(resolution: WindowResolution, decision: ReopenDecision): ReopenWindowView {
  return {
    days: resolution.days,
    source: resolution.source,
    started_on: decision.startedOn,
    deadline: decision.deadline,
    allowed: decision.allowed,
  };
}

/** Desk and portal reopen vs an inbound reply; the allowed copy differs. */
export type ReopenCause = 'reply' | 'transition';

export function reopenSentence(view: ReopenWindowView, cause: ReopenCause = 'transition'): string {
  if (view.started_on === null) return 'The ticket has no resolved or closed time.';
  if (view.days <= 0) return 'The reopen window is set to never.';
  if (view.allowed) {
    if (cause === 'reply') {
      return `reply inside reopen window (${view.days} working days, deadline ${view.deadline}).`;
    }
    return `Reopened inside the ${view.days} working-day window (deadline ${view.deadline}).`;
  }
  return `The ${view.days} working-day reopen window ended on ${view.deadline}.`;
}

/** First comment on a spawned follow-up: the old key and why it was not reopened. */
export function spawnFollowUpComment(oldKey: string, window: ReopenWindowView, body: string): string {
  return `Follow-up to ${oldKey}. ${reopenSentence(window)}\n\n${body}`;
}

export function addWorkingDays(start: string, n: number, calendar: ReopenCalendar): string {
  let date = start;
  let added = 0;
  for (let step = 0; step < MAX_STEPS && added < n; step += 1) {
    date = addCivilDays(date, 1);
    if (calendar.isWorkingDate(date)) added += 1;
  }
  return date;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function addCivilDays(day: string, count: number): string {
  const next = new Date(new Date(`${day}T12:00:00Z`).getTime() + count * 86_400_000);
  return next.toISOString().slice(0, 10);
}
