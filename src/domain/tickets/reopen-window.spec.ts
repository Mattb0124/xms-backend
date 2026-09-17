import { describe, expect, it } from 'vitest';
import { BusinessCalendar } from '../calendar/business-calendar.js';
import {
  fromBusinessCalendar,
  mayReopen,
  reopenSentence,
  resolveWindowDays,
  spawnFollowUpComment,
  weekdayCalendar,
} from './reopen-window.js';

/**
 * BRK-shaped calendar: London weekdays 09:00-17:00. Resolve Monday
 * 2026-09-14 so day 3 is Thursday 17th and calendar day 8 is Tuesday 22nd.
 */
const OFFICE = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
const ZONE = 'Europe/London';
const RESOLVED = new Date('2026-09-14T15:00:00Z');

const brk = fromBusinessCalendar(
  new BusinessCalendar({ id: 'brk', timeZone: ZONE, hours: OFFICE }),
);

function decide(
  now: string,
  extras: Partial<Parameters<typeof mayReopen>[0]> = {},
): ReturnType<typeof mayReopen> {
  return mayReopen({
    windowDays: 5,
    resolvedAt: RESOLVED,
    closedAt: null,
    now: new Date(now),
    calendar: brk,
    ...extras,
  });
}

describe('resolveWindowDays', () => {
  it('uses the account default until a type override is present, including zero', () => {
    expect(resolveWindowDays(5, undefined)).toEqual({ days: 5, source: 'account' });
    expect(resolveWindowDays(5, null)).toEqual({ days: 5, source: 'account' });
    expect(resolveWindowDays(5, 0)).toEqual({ days: 0, source: 'type_override' });
    expect(resolveWindowDays(5, 10)).toEqual({ days: 10, source: 'type_override' });
  });
});

describe('mayReopen', () => {
  it('allows a reply on business day 3 and refuses calendar day 8', () => {
    expect(decide('2026-09-17T12:00:00Z')).toMatchObject({
      allowed: true,
      startedOn: '2026-09-14',
      deadline: '2026-09-21',
    });
    expect(decide('2026-09-22T12:00:00Z')).toMatchObject({
      allowed: false,
      startedOn: '2026-09-14',
      deadline: '2026-09-21',
    });
  });

  it('extends the deadline by a working day when a holiday sits inside the window', () => {
    const withHoliday = fromBusinessCalendar(
      new BusinessCalendar({ id: 'brk', timeZone: ZONE, hours: OFFICE, holidays: ['2026-09-16'] }),
    );
    expect(decide('2026-09-22T12:00:00Z', { calendar: withHoliday })).toMatchObject({
      allowed: true,
      deadline: '2026-09-22',
    });
    expect(decide('2026-09-23T12:00:00Z', { calendar: withHoliday }).allowed).toBe(false);
  });

  it('never reopens when the window is zero, including on the resolve day', () => {
    expect(decide('2026-09-14T16:00:00Z', { windowDays: 0 })).toMatchObject({
      allowed: false,
      startedOn: '2026-09-14',
      deadline: null,
    });
  });

  it('starts from closed_at when resolved_at is missing, and refuses with neither', () => {
    expect(
      decide('2026-09-17T12:00:00Z', { resolvedAt: null, closedAt: new Date('2026-09-14T18:00:00Z') }),
    ).toMatchObject({ allowed: true, startedOn: '2026-09-14' });
    expect(decide('2026-09-17T12:00:00Z', { resolvedAt: null, closedAt: null })).toEqual({
      allowed: false,
      startedOn: null,
      deadline: null,
    });
  });

  it('counts Monday to Friday when the account has no calendar', () => {
    expect(
      decide('2026-09-17T12:00:00Z', { calendar: weekdayCalendar(ZONE) }),
    ).toMatchObject({ allowed: true, deadline: '2026-09-21' });
    expect(decide('2026-09-22T12:00:00Z', { calendar: weekdayCalendar(ZONE) }).allowed).toBe(false);
  });
});

const OPEN_WINDOW = {
  days: 5,
  source: 'account' as const,
  started_on: '2026-09-14',
  deadline: '2026-09-21',
  allowed: true,
};

describe('reopenSentence', () => {
  it('names the deadline when the window is open, elapsed, never, or missing a start', () => {
    expect(reopenSentence(OPEN_WINDOW)).toBe(
      'Reopened inside the 5 working-day window (deadline 2026-09-21).',
    );
    expect(reopenSentence(OPEN_WINDOW, 'reply')).toBe(
      'reply inside reopen window (5 working days, deadline 2026-09-21).',
    );
    expect(reopenSentence({ ...OPEN_WINDOW, allowed: false })).toBe(
      'The 5 working-day reopen window ended on 2026-09-21.',
    );
    expect(
      reopenSentence({
        days: 0,
        source: 'type_override',
        started_on: '2026-09-14',
        deadline: null,
        allowed: false,
      }),
    ).toBe('The reopen window is set to never.');
    expect(
      reopenSentence({
        days: 5,
        source: 'account',
        started_on: null,
        deadline: null,
        allowed: false,
      }),
    ).toBe('The ticket has no resolved or closed time.');
  });
});

describe('spawnFollowUpComment', () => {
  it('names the matched key and why it was not reopened', () => {
    expect(
      spawnFollowUpComment('CS1000017', { ...OPEN_WINDOW, allowed: false }, 'Still broken.'),
    ).toBe(
      'Follow-up to CS1000017. The 5 working-day reopen window ended on 2026-09-21.\n\nStill broken.',
    );
  });
});
