import { describe, expect, it } from 'vitest';
import { hashToken, isLowScore, newToken, summarise, suppressionReason, surveyTimings } from './csat.js';

const closed = {
  state: 'closed',
  resolution_code: 'fixed',
  created_at: '2026-09-01T09:00:00Z',
  closed_at: '2026-09-01T12:00:00Z',
};

describe('suppressionReason', () => {
  it('names the functional 5.7 reasons in order and otherwise allows the survey', () => {
    expect(suppressionReason(closed, false)).toBeNull();
    expect(suppressionReason({ ...closed, state: 'cancelled' }, false)).toBe('cancelled');
    expect(suppressionReason({ ...closed, cancelled_at: '2026-09-01T10:00:00Z' }, false)).toBe('cancelled');
    expect(suppressionReason({ ...closed, resolution_code: 'duplicate_of' }, false)).toBe('duplicate');
    expect(suppressionReason({ ...closed, closed_at: '2026-09-01T09:10:00Z' }, false)).toBe('too_fast');
    expect(suppressionReason(closed, true)).toBe('daily_cap');
  });
});

describe('surveyTimings and tokens', () => {
  it('reminds after three days and expires after ten', () => {
    const sent = new Date('2026-09-01T12:00:00Z');
    expect(surveyTimings(sent)).toEqual({
      remindAt: new Date('2026-09-04T12:00:00Z'),
      expiresAt: new Date('2026-09-11T12:00:00Z'),
    });
  });

  it('stores only the hash of a fresh token', () => {
    const { token, hash } = newToken();
    expect(token.length).toBeGreaterThanOrEqual(30);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
    expect(newToken().token).not.toBe(token);
  });
});

describe('summarise', () => {
  it('averages, distributes and counts the low scores', () => {
    expect(summarise([5, 4, 2, 5])).toEqual({
      responses: 4,
      average: 4,
      distribution: { '1': 0, '2': 1, '3': 0, '4': 1, '5': 2 },
      low: 1,
    });
    expect(summarise([])).toEqual({
      responses: 0,
      average: null,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      low: 0,
    });
    expect(isLowScore(2)).toBe(true);
    expect(isLowScore(3)).toBe(false);
  });
});
