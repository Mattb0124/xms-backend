import { describe, expect, it } from 'vitest';
import { WALL_CLOCK } from '../sla/engine.js';
import { classifyPerformed, minuteOfDay, multiplierFor } from './after-hours.js';
import { BusinessCalendar } from './business-calendar.js';

const office = new BusinessCalendar({
  id: 'uk',
  timeZone: 'Europe/London',
  hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
  holidays: ['2026-05-04'],
});

describe('minuteOfDay', () => {
  it('parses HH:MM and refuses anything else', () => {
    expect(minuteOfDay('19:30')).toBe(1170);
    expect(minuteOfDay('00:00')).toBe(0);
    expect(minuteOfDay('24:00')).toBeUndefined();
    expect(minuteOfDay('9:30')).toBeUndefined();
    expect(minuteOfDay(undefined)).toBeUndefined();
  });
});

describe('classifyPerformed', () => {
  it('reads the day class from the calendar: holiday, weekend, working day', () => {
    expect(classifyPerformed(office, '2026-05-04')).toBe('holiday');
    expect(classifyPerformed(office, '2026-05-02')).toBe('weekend');
    expect(classifyPerformed(office, '2026-05-05')).toBe('standard');
  });

  it('judges a stated start against the hours on a working day', () => {
    expect(classifyPerformed(office, '2026-05-05', '10:00')).toBe('standard');
    expect(classifyPerformed(office, '2026-05-05', '19:30')).toBe('after_hours');
    expect(classifyPerformed(office, '2026-05-05', '08:59')).toBe('after_hours');
  });

  it('the day class wins over the start on a holiday or weekend', () => {
    expect(classifyPerformed(office, '2026-05-04', '10:00')).toBe('holiday');
    expect(classifyPerformed(office, '2026-05-02', '10:00')).toBe('weekend');
  });

  it("takes the person's word only when the calendar cannot judge", () => {
    expect(classifyPerformed(office, '2026-05-05', undefined, true)).toBe('after_hours');
    expect(classifyPerformed(office, '2026-05-05', '10:00', true)).toBe('standard');
    expect(classifyPerformed(WALL_CLOCK, '2026-05-02', '10:00', false)).toBe('standard');
    expect(classifyPerformed(WALL_CLOCK, '2026-05-05', undefined, true)).toBe('after_hours');
  });

  it('a non-working weekday inside the week is after hours, not a weekend', () => {
    const fourDay = new BusinessCalendar({
      id: 'four',
      timeZone: 'UTC',
      hours: [1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
    });
    expect(classifyPerformed(fourDay, '2026-05-08')).toBe('after_hours');
    expect(classifyPerformed(fourDay, '2026-05-09')).toBe('weekend');
  });
});

describe('multiplierFor', () => {
  it('applies the premium only for a non-standard class under premium_rate', () => {
    expect(multiplierFor('premium_rate', 1.5, 'after_hours')).toBe(1.5);
    expect(multiplierFor('premium_rate', 1.5, 'holiday')).toBe(1.5);
    expect(multiplierFor('premium_rate', 1.5, 'standard')).toBe(1);
    expect(multiplierFor('comp_time', 1.5, 'weekend')).toBe(1);
    expect(multiplierFor('none', 2, 'weekend')).toBe(1);
    expect(multiplierFor('premium_rate', null, 'weekend')).toBe(1);
    expect(multiplierFor('premium_rate', 0.5, 'weekend')).toBe(1);
  });
});
