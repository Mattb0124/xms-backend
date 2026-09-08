import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CSAT on ticket close (Client Portal functional 5.7; CP-07): whether a
 * closed ticket earns a survey, when to remind and expire it, and the
 * one-time link token that answers it without a portal session.
 */
export type SuppressionReason = 'cancelled' | 'duplicate' | 'too_fast' | 'daily_cap';

export const TOO_FAST_MINUTES = 15;
export const REMIND_AFTER_DAYS = 3;
export const EXPIRE_AFTER_DAYS = 10;
export const LOW_SCORE_MAX = 2;

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

/** Reminder and expiry instants from the send instant (calendar days; business days wait for the calendar). */
export function surveyTimings(sentAt: Date): { remindAt: Date; expiresAt: Date } {
  return {
    remindAt: new Date(sentAt.getTime() + REMIND_AFTER_DAYS * 86_400_000),
    expiresAt: new Date(sentAt.getTime() + EXPIRE_AFTER_DAYS * 86_400_000),
  };
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
