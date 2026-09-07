import { describe, expect, it } from 'vitest';
import {
  BusinessCalendar,
  CalendarError,
  instantOf,
  localParts,
  offsetMinutes,
  validateHours,
} from './business-calendar.js';
import { pause, resume, startClocks } from '../sla/engine.js';

const OFFICE = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

const uk = new BusinessCalendar({ id: 'uk', timeZone: 'Europe/London', hours: OFFICE, holidays: ['2026-04-06'] });
const sydney = new BusinessCalendar({ id: 'au', timeZone: 'Australia/Sydney', hours: OFFICE });
const saoPaulo = new BusinessCalendar({ id: 'br', timeZone: 'America/Sao_Paulo', hours: OFFICE });
const split = new BusinessCalendar({
  id: 'split',
  timeZone: 'Europe/London',
  hours: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMinute: 9 * 60, endMinute: 12 * 60 },
    { weekday, startMinute: 13 * 60, endMinute: 17 * 60 },
  ]),
});
const always = new BusinessCalendar({
  id: 'all',
  timeZone: 'UTC',
  hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
});

const at = (iso: string): Date => new Date(iso);

describe('zone helpers', () => {
  it('reads local parts and offsets across DST in London and Sydney', () => {
    expect(localParts(at('2026-03-27T12:00:00Z'), 'Europe/London')).toMatchObject({
      weekday: 5,
      minute: 720,
      date: '2026-03-27',
    });
    expect(offsetMinutes(at('2026-03-27T12:00:00Z'), 'Europe/London')).toBe(0);
    expect(offsetMinutes(at('2026-03-30T12:00:00Z'), 'Europe/London')).toBe(60);
    expect(offsetMinutes(at('2026-04-01T12:00:00Z'), 'Australia/Sydney')).toBe(660);
    expect(offsetMinutes(at('2026-04-10T12:00:00Z'), 'Australia/Sydney')).toBe(600);
    expect(instantOf(2026, 3, 30, 9 * 60, 'Europe/London').toISOString()).toBe('2026-03-30T08:00:00.000Z');
    expect(instantOf(2026, 3, 27, 9 * 60, 'Europe/London').toISOString()).toBe('2026-03-27T09:00:00.000Z');
  });
});

describe('addMinutes', () => {
  it('rolls over a weekend and a bank holiday', () => {
    // Friday 3 April 2026 16:30 BST, plus 60 working minutes: 30 left on Friday, Monday 6 April is a holiday, so Tuesday 09:30.
    expect(uk.addMinutes(at('2026-04-03T15:30:00Z'), 60).toISOString()).toBe('2026-04-07T08:30:00.000Z');
  });

  it('starts a clock that begins outside working time at the next working instant', () => {
    expect(uk.addMinutes(at('2026-04-12T11:00:00Z'), 30).toISOString()).toBe('2026-04-13T08:30:00.000Z');
    expect(uk.nextWorkingInstant(at('2026-04-12T11:00:00Z')).toISOString()).toBe('2026-04-13T08:00:00.000Z');
    expect(uk.nextWorkingInstant(at('2026-04-13T10:00:00Z')).toISOString()).toBe('2026-04-13T10:00:00.000Z');
    expect(uk.isWorkingTime(at('2026-04-13T10:00:00Z'))).toBe(true);
    expect(uk.isWorkingTime(at('2026-04-13T16:30:00Z'))).toBe(false);
  });

  it('keeps 480 working minutes per office day across the London DST change', () => {
    // Friday 27 March 09:00 GMT plus two office days lands Monday 30 March 17:00 BST (16:00Z).
    expect(uk.addMinutes(at('2026-03-27T09:00:00Z'), 960).toISOString()).toBe('2026-03-30T16:00:00.000Z');
    expect(uk.minutesBetween(at('2026-03-27T09:00:00Z'), at('2026-03-30T16:00:00Z'))).toBe(960);
  });

  it('handles Sydney across the end of daylight saving and Sao Paulo without it', () => {
    // Thursday 2 April 09:00 AEDT is 22:00Z the day before; a full day ends 17:00 AEDT (06:00Z).
    expect(sydney.addMinutes(at('2026-04-01T22:00:00Z'), 480).toISOString()).toBe('2026-04-02T06:00:00.000Z');
    // Monday 6 April 09:00 AEST (23:00Z Sunday) after the change.
    expect(sydney.addMinutes(at('2026-04-03T06:30:00Z'), 30).toISOString()).toBe('2026-04-05T23:30:00.000Z');
    expect(saoPaulo.addMinutes(at('2026-04-03T19:30:00Z'), 60).toISOString()).toBe('2026-04-06T12:30:00.000Z');
  });

  it('respects a split shift', () => {
    expect(split.addMinutes(at('2026-04-13T08:00:00Z'), 200).toISOString()).toBe('2026-04-13T12:20:00.000Z');
    expect(split.minutesBetween(at('2026-04-13T08:00:00Z'), at('2026-04-13T12:20:00Z'))).toBe(200);
  });

  it('behaves as a wall clock when every minute is working time', () => {
    expect(always.addMinutes(at('2026-04-11T23:30:00Z'), 90).toISOString()).toBe('2026-04-12T01:00:00.000Z');
    expect(always.minutesBetween(at('2026-04-11T23:30:00Z'), at('2026-04-12T01:00:00Z'))).toBe(90);
  });

  it('refuses a calendar without hours and reports overlaps in the editor', () => {
    expect(() => new BusinessCalendar({ id: 'x', timeZone: 'UTC', hours: [] })).toThrow(CalendarError);
    expect(validateHours([])).toEqual(['at least one working interval is required']);
    expect(
      validateHours([
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 700, endMinute: 1020 },
      ]),
    ).toEqual(['weekday 1: intervals overlap']);
    expect(validateHours([{ weekday: 7, startMinute: 1020, endMinute: 540 }])).toEqual([
      'entry 0: weekday must be 0 to 6',
      'entry 0: end must be after start',
    ]);
  });
});

describe('minutesBetween', () => {
  it('counts only working minutes across evenings, weekends and holidays', () => {
    expect(uk.minutesBetween(at('2026-04-02T15:00:00Z'), at('2026-04-07T09:00:00Z'))).toBe(60 + 480 + 60);
    expect(uk.minutesBetween(at('2026-04-04T10:00:00Z'), at('2026-04-05T10:00:00Z'))).toBe(0);
    expect(uk.minutesBetween(at('2026-04-13T10:00:00Z'), at('2026-04-13T09:00:00Z'))).toBe(0);
  });
});

describe('with the SLA engine', () => {
  it('a pause over a weekend excludes no working minutes, a pause across a working day shifts the due time by that day', () => {
    const [response] = startClocks(
      { response_minutes: 480, resolution_minutes: null },
      'p',
      uk,
      at('2026-04-10T08:00:00Z'),
    );
    // Friday 10 April 09:00 BST, 480 minutes: due Friday 17:00 BST.
    expect(response.dueAt.toISOString()).toBe('2026-04-10T16:00:00.000Z');
    const weekend = resume(pause(response, at('2026-04-10T16:00:00Z')), uk, at('2026-04-13T08:00:00Z'));
    expect(weekend.excludedMinutes).toBe(0);
    expect(weekend.clock.dueAt.toISOString()).toBe('2026-04-10T16:00:00.000Z');
    const [resolution] = startClocks(
      { response_minutes: null, resolution_minutes: 960 },
      'p',
      uk,
      at('2026-04-13T08:00:00Z'),
    );
    const paused = pause(resolution, at('2026-04-13T12:00:00Z'));
    const resumed = resume(paused, uk, at('2026-04-14T12:00:00Z'));
    expect(resumed.excludedMinutes).toBe(480);
    expect(resumed.clock.dueAt.toISOString()).toBe('2026-04-15T16:00:00.000Z');
  });
});
