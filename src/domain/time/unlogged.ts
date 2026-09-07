/**
 * Unlogged time (Time & Budget technical section 4; P2.18.3; the data
 * behind AI-06 nudges): per calendar day, the minutes the person's working
 * calendar expects minus the minutes logged. Weekends, days outside the
 * working days and holidays expect nothing; a day with more logged than
 * expected reports zero unlogged, never a negative.
 */
export interface PersonCalendarSpec {
  /** ISO weekday numbers, 1 = Monday to 7 = Sunday. */
  readonly workingDays: readonly number[];
  readonly hoursPerDay: number;
}

export interface UnloggedDay {
  readonly date: string;
  readonly weekday: number;
  readonly expected_minutes: number;
  readonly logged_minutes: number;
  readonly unlogged_minutes: number;
  readonly holiday: boolean;
}

export const DEFAULT_PERSON_CALENDAR: PersonCalendarSpec = { workingDays: [1, 2, 3, 4, 5], hoursPerDay: 8 };

function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function* days(from: string, to: string): Generator<string> {
  let cursor = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  while (cursor <= end) {
    yield new Date(cursor).toISOString().slice(0, 10);
    cursor += 86_400_000;
  }
}

export function unloggedByDay(input: {
  from: string;
  to: string;
  calendar: PersonCalendarSpec | null;
  holidays: ReadonlySet<string>;
  logged: ReadonlyMap<string, number>;
}): UnloggedDay[] {
  const calendar = input.calendar ?? DEFAULT_PERSON_CALENDAR;
  const expectedPerDay = Math.round(calendar.hoursPerDay * 60);
  const result: UnloggedDay[] = [];
  for (const date of days(input.from, input.to)) {
    const weekday = isoWeekday(date);
    const holiday = input.holidays.has(date);
    const expected = !holiday && calendar.workingDays.includes(weekday) ? expectedPerDay : 0;
    const logged = Math.max(0, Math.round(input.logged.get(date) ?? 0));
    result.push({
      date,
      weekday,
      expected_minutes: expected,
      logged_minutes: logged,
      unlogged_minutes: Math.max(0, expected - logged),
      holiday,
    });
  }
  return result;
}

/** Monday to Sunday of the ISO week containing the date (or the week given as YYYY-Www). */
export function weekBounds(reference: string): { from: string; to: string } {
  const match = reference.match(/^(\d{4})-W(\d{2})$/);
  let monday: Date;
  if (match) {
    const year = Number(match[1]);
    const week = Number(match[2]);
    const fourth = new Date(Date.UTC(year, 0, 4));
    const fourthWeekday = fourth.getUTCDay() === 0 ? 7 : fourth.getUTCDay();
    monday = new Date(fourth.getTime() - (fourthWeekday - 1) * 86_400_000 + (week - 1) * 7 * 86_400_000);
  } else {
    const date = new Date(`${reference}T00:00:00Z`);
    const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    monday = new Date(date.getTime() - (weekday - 1) * 86_400_000);
  }
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}
