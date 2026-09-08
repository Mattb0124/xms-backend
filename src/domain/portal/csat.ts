import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CSAT (Client Portal functional 5.7; CP-07): the two surveys, whether a
 * closed ticket earns one, which quarter is due, when to remind and expire
 * each kind, and the one-time link token that answers without a portal
 * session.
 */
export type SuppressionReason = 'cancelled' | 'duplicate' | 'too_fast' | 'daily_cap';

export type SurveyKind = 'ticket_close' | 'quarterly';

export const TOO_FAST_MINUTES = 15;
export const REMIND_AFTER_DAYS = 3;
export const EXPIRE_AFTER_DAYS = 10;
export const LOW_SCORE_MAX = 2;

// The questions --------------------------------------------------------------

export interface Question {
  readonly key: string;
  readonly text: string;
}

/** The single five-point question on ticket close. */
export const TICKET_CLOSE_QUESTION: Question = {
  key: 'score',
  text: 'How satisfied are you with the handling of this request?',
};

/**
 * The five questions of the quarterly relationship survey, in the order
 * functional 5.7 names them. The keys are the answer document's keys and
 * the column headings of the account summary, so they never change.
 */
export const QUARTERLY_QUESTIONS: readonly Question[] = [
  { key: 'responsiveness', text: 'How responsive were we this quarter?' },
  { key: 'quality', text: 'How would you rate the quality of the work delivered?' },
  { key: 'communication', text: 'How clear and timely was our communication?' },
  { key: 'value', text: 'How well does the service represent value for money?' },
  { key: 'recommend', text: 'How likely are you to recommend us to a colleague?' },
];

export const QUARTERLY_KEYS: readonly string[] = QUARTERLY_QUESTIONS.map((question) => question.key);

export function questionsFor(kind: SurveyKind): readonly Question[] {
  return kind === 'quarterly' ? QUARTERLY_QUESTIONS : [TICKET_CLOSE_QUESTION];
}

export interface ClosedTicketFacts {
  readonly state: string;
  readonly resolution_code: string | null;
  readonly created_at: string | Date;
  readonly closed_at: string | Date | null;
  readonly cancelled_at?: string | Date | null;
}

/** The reason a closed ticket gets no survey, or null when it does. */
export function suppressionReason(
  ticket: ClosedTicketFacts,
  requesterSurveyedToday: boolean,
): SuppressionReason | null {
  if (ticket.state === 'cancelled' || ticket.cancelled_at) return 'cancelled';
  if (ticket.resolution_code && /duplicate/i.test(ticket.resolution_code)) return 'duplicate';
  const created = new Date(ticket.created_at).getTime();
  const closed = ticket.closed_at ? new Date(ticket.closed_at).getTime() : Date.now();
  if (closed - created < TOO_FAST_MINUTES * 60_000) return 'too_fast';
  if (requesterSurveyedToday) return 'daily_cap';
  return null;
}

/**
 * The reminder cadence per kind, in days after the prompt went out.
 * Ticket close: one reminder after three days, expiry after ten
 * (functional 5.7). Quarterly: two reminders over three weeks, so day 7 and
 * day 14, and the survey expires at the end of the third week.
 */
export const REMINDER_SCHEDULE: Record<SurveyKind, { remindAfterDays: readonly number[]; expireAfterDays: number }> = {
  ticket_close: { remindAfterDays: [REMIND_AFTER_DAYS], expireAfterDays: EXPIRE_AFTER_DAYS },
  quarterly: { remindAfterDays: [7, 14], expireAfterDays: 21 },
};

/** Reminder and expiry instants from the send instant (calendar days; business days wait for the calendar). */
export function surveyTimings(sentAt: Date, kind: SurveyKind = 'ticket_close'): { remindAt: Date; expiresAt: Date } {
  const schedule = REMINDER_SCHEDULE[kind];
  return {
    remindAt: new Date(sentAt.getTime() + schedule.remindAfterDays[0] * 86_400_000),
    expiresAt: new Date(sentAt.getTime() + schedule.expireAfterDays * 86_400_000),
  };
}

/**
 * The next reminder due after `after`, or null when the cadence is spent.
 * The tick stamps this on the row as it sends, so a second reminder is a
 * date on the row rather than a counter the worker has to remember.
 */
export function nextRemindAt(kind: SurveyKind, sentAt: Date, after: Date): Date | null {
  for (const days of REMINDER_SCHEDULE[kind].remindAfterDays) {
    const at = new Date(sentAt.getTime() + days * 86_400_000);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

// The quarterly cycle ---------------------------------------------------------

/** The quarter that had ended before `on`, as its period label and last day. */
export function quarterEndedBefore(on: Date): { period: string; endsOn: string } {
  const year = on.getUTCFullYear();
  const quarter = Math.floor(on.getUTCMonth() / 3) + 1;
  // The quarter in progress is not the one being asked about; step back one.
  const previous = quarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: quarter - 1 };
  const endMonth = previous.quarter * 3; // 3, 6, 9 or 12
  const endsOn = new Date(Date.UTC(previous.year, endMonth, 0));
  return { period: `${previous.year}-Q${previous.quarter}`, endsOn: isoDay(endsOn) };
}

/** The first day after `endsOn` that `isWorkingDay` accepts, searched up to a fortnight out. */
export function firstBusinessDayAfter(endsOn: string, isWorkingDay: (day: string) => boolean): string {
  let day = addDays(endsOn, 1);
  for (let step = 0; step < 14; step += 1) {
    if (isWorkingDay(day)) return day;
    day = addDays(day, 1);
  }
  // A calendar with no working day in a fortnight is a misconfiguration, not
  // a reason to withhold the survey for a quarter.
  return addDays(endsOn, 1);
}

/** Monday to Friday, the fallback when the account has no business calendar. */
export function isWeekday(day: string): boolean {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

export function addDays(day: string, count: number): string {
  return isoDay(new Date(new Date(`${day}T12:00:00Z`).getTime() + count * 86_400_000));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A fresh one-time token and the hash the row keeps; only the hash is stored. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compares a presented token against the stored hash in constant time. */
export function tokenMatches(storedHash: string, token: string): boolean {
  const expected = Buffer.from(storedHash, 'utf8');
  const given = Buffer.from(hashToken(token), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function isLowScore(score: number): boolean {
  return score <= LOW_SCORE_MAX;
}

// The quarterly answer document ----------------------------------------------

export interface QuarterlyPeriodSummary {
  readonly period: string;
  readonly responses: number;
  /** The mean of the five questions in that period, or null with no answer. */
  readonly average: number | null;
}

export interface QuarterlySummary {
  readonly latest_period: string | null;
  readonly responses: number;
  /** The mean per question in the latest period, keyed as the answers are. */
  readonly averages: Record<string, number | null>;
  readonly average: number | null;
  /** The last periods answered, oldest first, so the trend reads left to right. */
  readonly trend: QuarterlyPeriodSummary[];
}

/**
 * Averages per question for the latest period and the trend over the last
 * `periods` answered quarters. The caller hands over one row per response
 * with the period it belongs to; the arithmetic lives here so the summary
 * and any report pack computing it agree to the decimal.
 */
export function summariseQuarterly(
  rows: readonly { period: string; answers: Record<string, unknown> }[],
  periods = 4,
): QuarterlySummary {
  const byPeriod = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const bucket = byPeriod.get(row.period);
    if (bucket) bucket.push(row.answers);
    else byPeriod.set(row.period, [row.answers]);
  }
  const ordered = [...byPeriod.keys()].sort();
  const kept = ordered.slice(Math.max(0, ordered.length - periods));
  const trend = kept.map((period) => {
    const answers = byPeriod.get(period) ?? [];
    return {
      period,
      responses: answers.length,
      average: mean(answers.flatMap((answer) => QUARTERLY_KEYS.map((key) => numberOf(answer[key])))),
    };
  });
  const latest = kept[kept.length - 1];
  const latestAnswers = latest ? (byPeriod.get(latest) ?? []) : [];
  const averages: Record<string, number | null> = {};
  for (const key of QUARTERLY_KEYS) averages[key] = mean(latestAnswers.map((answer) => numberOf(answer[key])));
  return {
    latest_period: latest ?? null,
    responses: latestAnswers.length,
    averages,
    average: trend[trend.length - 1]?.average ?? null,
    trend,
  };
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return Math.round((present.reduce((total, value) => total + value, 0) / present.length) * 100) / 100;
}

export interface ScoreSummary {
  readonly responses: number;
  readonly average: number | null;
  readonly distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  readonly low: number;
}

/** Average and distribution over ticket-close scores. */
export function summarise(scores: readonly number[]): ScoreSummary {
  const distribution: ScoreSummary['distribution'] = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let total = 0;
  let low = 0;
  for (const score of scores) {
    const key = String(Math.min(5, Math.max(1, Math.round(score)))) as keyof ScoreSummary['distribution'];
    distribution[key] += 1;
    total += score;
    if (isLowScore(score)) low += 1;
  }
  return {
    responses: scores.length,
    average: scores.length === 0 ? null : Math.round((total / scores.length) * 100) / 100,
    distribution,
    low,
  };
}
