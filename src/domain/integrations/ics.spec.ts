import { describe, expect, it } from 'vitest';
import { escapeText, foldLine, icsStamp, writeCalendar, type IcsEvent } from './ics.js';

/**
 * The ICS writer over constructed change windows (INT-05). What matters to
 * a subscribed calendar is that every stamp is UTC with no zone block, that
 * a window keeps its UID across re-reads, and that an edit raises the
 * sequence so the client knows which version wins.
 */
const stamp = new Date('2026-09-08T09:00:00.000Z');

const window = (over: Partial<IcsEvent> = {}): IcsEvent => ({
  uid: 'change-window-2f0d0b0a@xms',
  start: new Date('2026-10-03T22:00:00.000Z'),
  end: new Date('2026-10-04T06:30:00.000Z'),
  summary: 'BRK: Azure Files cutover',
  status: 'CONFIRMED',
  sequence: 0,
  ...over,
});

const lines = (document: string): string[] => document.split('\r\n');

describe('the ICS writer', () => {
  it('writes UTC stamps with no VTIMEZONE block', () => {
    const document = writeCalendar([window()], { name: 'XMS change calendar', stamp });
    expect(document).not.toContain('VTIMEZONE');
    expect(document).not.toContain('TZID');
    expect(lines(document)).toEqual(
      expect.arrayContaining([
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'CALSCALE:GREGORIAN',
        'X-WR-CALNAME:XMS change calendar',
        'DTSTAMP:20260908T090000Z',
        'DTSTART:20261003T220000Z',
        'DTEND:20261004T063000Z',
        'STATUS:CONFIRMED',
        'SEQUENCE:0',
        'TRANSP:OPAQUE',
        'END:VCALENDAR',
      ]),
    );
    // Every line ends CRLF, including the last one.
    expect(document.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('keeps the UID stable and raises the sequence when the window is edited', () => {
    const first = writeCalendar([window()], { name: 'XMS', stamp });
    const edited = writeCalendar(
      [
        window({
          start: new Date('2026-10-10T22:00:00.000Z'),
          end: new Date('2026-10-11T06:30:00.000Z'),
          sequence: 3,
          lastModified: new Date('2026-09-08T08:00:00.000Z'),
        }),
      ],
      { name: 'XMS', stamp },
    );
    expect(lines(first)).toContain('UID:change-window-2f0d0b0a@xms');
    expect(lines(edited)).toContain('UID:change-window-2f0d0b0a@xms');
    expect(lines(first)).toContain('SEQUENCE:0');
    expect(lines(edited)).toContain('SEQUENCE:3');
    expect(lines(edited)).toContain('DTSTART:20261010T220000Z');
    expect(lines(edited)).toContain('LAST-MODIFIED:20260908T080000Z');
  });

  it('writes a cancelled window as CANCELLED and a freeze as free time', () => {
    const document = writeCalendar(
      [
        window({ status: 'CANCELLED' }),
        window({
          uid: 'change-freeze-2f0d0b0a-0@xms',
          summary: 'Freeze: Year end close',
          status: 'CONFIRMED',
          transparent: true,
        }),
      ],
      { name: 'XMS', stamp },
    );
    expect(lines(document).filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(lines(document)).toContain('STATUS:CANCELLED');
    expect(lines(document)).toContain('TRANSP:TRANSPARENT');
    expect(lines(document)).toContain('UID:change-freeze-2f0d0b0a-0@xms');
  });

  it('escapes the characters a TEXT value may not carry raw', () => {
    expect(escapeText('Cutover; phase 1, 2 \\ 3\nwith a note')).toBe('Cutover\\; phase 1\\, 2 \\\\ 3\\nwith a note');
    const document = writeCalendar(
      [window({ summary: 'BRK: cutover; phase 1, 2', description: 'CS0001234\nCS0001235' })],
      { name: 'XMS', stamp },
    );
    expect(lines(document)).toContain('SUMMARY:BRK: cutover\\; phase 1\\, 2');
    expect(lines(document)).toContain('DESCRIPTION:CS0001234\\nCS0001235');
  });

  it('folds a long line at 75 octets without cutting a character in half', () => {
    const short = foldLine('SUMMARY:short enough');
    expect(short).toBe('SUMMARY:short enough');

    const long = `SUMMARY:${'a'.repeat(200)}`;
    const folded = foldLine(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.from(parts[0], 'utf8').length).toBe(75);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true);
      expect(Buffer.from(part, 'utf8').length).toBeLessThanOrEqual(75);
    }
    // Unfolding (drop CRLF plus the one continuation space) gives the line back.
    expect(folded.replace(/\r\n /g, '')).toBe(long);

    // A multi-byte name is never split down the middle of its encoding.
    const wide = `SUMMARY:${'é'.repeat(80)}`;
    const foldedWide = foldLine(wide);
    for (const part of foldedWide.split('\r\n')) expect(part).not.toContain('\ufffd');
    expect(foldedWide.replace(/\r\n /g, '')).toBe(wide);
  });

  it('stamps an instant as UTC whatever the host zone', () => {
    expect(icsStamp(new Date('2026-01-01T00:00:00.000Z'))).toBe('20260101T000000Z');
    expect(icsStamp(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe('20261231T235959Z');
  });
});
