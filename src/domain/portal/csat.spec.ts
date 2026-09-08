import { describe, expect, it } from 'vitest';
import {
  firstBusinessDayAfter,
  hashToken,
  isLowScore,
  isWeekday,
  newToken,
  nextRemindAt,
  QUARTERLY_KEYS,
  quarterEndedBefore,
  questionsFor,
  summarise,
  summariseQuarterly,
  suppressionReason,
  surveyTimings,
} from './csat.js';

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

describe('the quarterly cadence', () => {
  it('names the quarter that ended before the day in hand', () => {
    expect(quarterEndedBefore(new Date('2026-10-01T06:00:00Z'))).toEqual({ period: '2026-Q3', endsOn: '2026-09-30' });
    expect(quarterEndedBefore(new Date('2026-11-20T06:00:00Z'))).toEqual({ period: '2026-Q3', endsOn: '2026-09-30' });
    // The first days of January look back into the previous year.
    expect(quarterEndedBefore(new Date('2027-01-01T06:00:00Z'))).toEqual({ period: '2026-Q4', endsOn: '2026-12-31' });
    expect(quarterEndedBefore(new Date('2026-04-02T06:00:00Z'))).toEqual({ period: '2026-Q1', endsOn: '2026-03-31' });
  });

  it('finds the first business day after the quarter end, weekdays or the account calendar', () => {
    // 2026-09-30 is a Wednesday, so the next weekday is the Thursday.
    expect(firstBusinessDayAfter('2026-09-30', isWeekday)).toBe('2026-10-01');
    // 2026-12-31 is a Thursday; a calendar that also closes the Friday
    // pushes the survey to the Monday.
    const closedNewYear = (day: string) => isWeekday(day) && day !== '2027-01-01';
    expect(firstBusinessDayAfter('2026-12-31', closedNewYear)).toBe('2027-01-04');
    // 2026-03-31 is a Tuesday.
    expect(firstBusinessDayAfter('2026-03-31', isWeekday)).toBe('2026-04-01');
  });

  it('reminds twice over three weeks and then stops', () => {
    const sent = new Date('2026-10-01T09:00:00Z');
    expect(surveyTimings(sent, 'quarterly')).toEqual({
      remindAt: new Date('2026-10-08T09:00:00Z'),
      expiresAt: new Date('2026-10-22T09:00:00Z'),
    });
    expect(nextRemindAt('quarterly', sent, sent)).toEqual(new Date('2026-10-08T09:00:00Z'));
    expect(nextRemindAt('quarterly', sent, new Date('2026-10-08T09:00:00Z'))).toEqual(new Date('2026-10-15T09:00:00Z'));
    expect(nextRemindAt('quarterly', sent, new Date('2026-10-15T09:00:00Z'))).toBeNull();
    // The ticket-close survey keeps its single reminder.
    expect(nextRemindAt('ticket_close', sent, sent)).toEqual(new Date('2026-10-04T09:00:00Z'));
    expect(nextRemindAt('ticket_close', sent, new Date('2026-10-04T09:00:00Z'))).toBeNull();
  });

  it('carries five questions for the quarterly survey and one for the ticket close', () => {
    expect(questionsFor('quarterly').map((question) => question.key)).toEqual([
      'responsiveness',
      'quality',
      'communication',
      'value',
      'recommend',
    ]);
    expect(QUARTERLY_KEYS).toHaveLength(5);
    expect(questionsFor('ticket_close').map((question) => question.key)).toEqual(['score']);
    for (const question of [...questionsFor('quarterly'), ...questionsFor('ticket_close')])
      expect(question.text.length).toBeGreaterThan(10);
  });
});

describe('summariseQuarterly', () => {
  const answer = (score: number) => Object.fromEntries(QUARTERLY_KEYS.map((key) => [key, score]));

  it('averages the latest period per question and trends the last four', () => {
    const summary = summariseQuarterly([
      { period: '2025-Q3', answers: answer(2) },
      { period: '2025-Q4', answers: answer(3) },
      { period: '2026-Q1', answers: answer(4) },
      { period: '2026-Q2', answers: answer(4) },
      { period: '2026-Q3', answers: { ...answer(5), recommend: 3 } },
      { period: '2026-Q3', answers: answer(4) },
    ]);
    expect(summary.latest_period).toBe('2026-Q3');
    expect(summary.responses).toBe(2);
    expect(summary.averages).toEqual({
      responsiveness: 4.5,
      quality: 4.5,
      communication: 4.5,
      value: 4.5,
      recommend: 3.5,
    });
    expect(summary.average).toBe(4.3);
    // Four periods, oldest first; 2025-Q3 falls off the left.
    expect(summary.trend.map((point) => point.period)).toEqual(['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3']);
    expect(summary.trend[0]).toEqual({ period: '2025-Q4', responses: 1, average: 3 });
  });

  it('answers an account with no quarterly response at all', () => {
    expect(summariseQuarterly([])).toEqual({
      latest_period: null,
      responses: 0,
      averages: { responsiveness: null, quality: null, communication: null, value: null, recommend: null },
      average: null,
      trend: [],
    });
  });
});
