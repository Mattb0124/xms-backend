/**
 * Capacity math (Capacity & Allocation technical section 2.9; CAP-03,
 * CAP-05, CAP-06): pure functions over a person's calendar, holidays, PTO,
 * employment dates and the month. Minutes everywhere; the worker and the
 * inline preview call the same code.
 */
export interface PersonMonthInput {
  /** First day of the month, YYYY-MM-DD. */
  readonly month: string;
  /** ISO weekday numbers the person works (1 = Monday to 7 = Sunday, or 0 = Sunday as stored). */
  readonly workingDays: readonly number[] | null;
  readonly hoursPerDay: number;
  readonly ftePercent: number;
  /** Person's overhead percent, or the operator default. */
  readonly overheadPercent: number;
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** Holiday dates (YYYY-MM-DD). */
  readonly holidays: ReadonlySet<string>;
  readonly pto: readonly { starts_on: string; ends_on: string; fraction: number }[];
  readonly allocatedMinutes: number;
  readonly actualMinutes: number;
  readonly warningRatio?: number;
}

export type CapacityStatus = 'available' | 'warning' | 'over' | 'no_calendar';

export interface PersonMonth {
  readonly working_days: number;
  readonly contracted_minutes: number;
  readonly pto_minutes: number;
  readonly holiday_minutes: number;
  readonly overhead_minutes: number;
  readonly available_minutes: number;
  readonly allocated_minutes: number;
  readonly actual_minutes: number;
  readonly remaining_minutes: number;
  readonly status: CapacityStatus;
}

export function monthBounds(month: string): { from: string; to: string } {
  const [year, mon] = month.split('-').map(Number);
  const to = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
  return { from: `${month.slice(0, 7)}-01`, to };
}

/** First day of the month a date falls in. */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function* days(from: string, to: string): Generator<string> {
  let cursor = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  while (cursor <= end) {
    yield new Date(cursor).toISOString().slice(0, 10);
    cursor += 86_400_000;
  }
}

/** Weekday as stored on the person calendar: 0 = Sunday to 6 = Saturday, with 7 accepted for Sunday. */
function worksOn(workingDays: readonly number[], date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return workingDays.includes(day) || (day === 0 && workingDays.includes(7));
}

/**
 * The person's month: working days inside the employment dates, the
 * contracted minutes at the FTE, holidays first, then PTO on the working
 * days left (a holiday inside a PTO range is never counted twice), the
 * overhead on what remains, and the status against the allocation.
 */
export function personMonth(input: PersonMonthInput): PersonMonth {
  if (!input.workingDays || input.workingDays.length === 0 || input.hoursPerDay <= 0) {
    return {
      working_days: 0,
      contracted_minutes: 0,
      pto_minutes: 0,
      holiday_minutes: 0,
      overhead_minutes: 0,
      available_minutes: 0,
      allocated_minutes: input.allocatedMinutes,
      actual_minutes: input.actualMinutes,
      remaining_minutes: 0,
      status: 'no_calendar',
    };
  }
  const { from, to } = monthBounds(input.month);
  const minutesPerDay = input.hoursPerDay * 60;
  let workingDays = 0;
  let holidayDays = 0;
  let ptoDays = 0;
  for (const date of days(from, to)) {
    if (input.startDate && date < input.startDate) continue;
    if (input.endDate && date > input.endDate) continue;
    if (!worksOn(input.workingDays, date)) continue;
    workingDays += 1;
    if (input.holidays.has(date)) {
      holidayDays += 1;
      continue;
    }
    const fraction = input.pto
      .filter((row) => date >= row.starts_on && date <= row.ends_on)
      .reduce((sum, row) => sum + row.fraction, 0);
    ptoDays += Math.min(1, fraction);
  }
  const fte = input.ftePercent / 100;
  const contracted = Math.round(workingDays * minutesPerDay * fte);
  const holiday = Math.round(holidayDays * minutesPerDay * fte);
  const pto = Math.round(ptoDays * minutesPerDay * fte);
  const net = Math.max(0, contracted - holiday - pto);
  const overhead = Math.round((net * input.overheadPercent) / 100);
  const available = Math.max(0, net - overhead);
  const ratio = available > 0 ? input.allocatedMinutes / available : input.allocatedMinutes > 0 ? Infinity : 0;
  const warning = input.warningRatio ?? 0.9;
  const status: CapacityStatus = ratio > 1 ? 'over' : ratio >= warning ? 'warning' : 'available';
  return {
    working_days: workingDays,
    contracted_minutes: contracted,
    pto_minutes: pto,
    holiday_minutes: holiday,
    overhead_minutes: overhead,
    available_minutes: available,
    allocated_minutes: input.allocatedMinutes,
    actual_minutes: input.actualMinutes,
    remaining_minutes: Math.max(0, available - input.allocatedMinutes),
    status,
  };
}

/** CAP-05: actual minus planned, and the ratio when planned is positive. */
export function variance(planned: number, actual: number): { variance_minutes: number; variance_ratio: number | null } {
  const value = actual - planned;
  return { variance_minutes: value, variance_ratio: planned > 0 ? Math.round((value / planned) * 1000) / 1000 : null };
}
