/**
 * The iCalendar writer (INT-05; Integrations functional 5.6). Pure: it
 * takes events and returns the document, so what a calendar client reads
 * can be asserted without a database.
 *
 * The specification's calendar integration is a Microsoft Graph push per
 * consenting user, which needs an application registration, a consent
 * flow and stored refresh tokens. A subscribed ICS feed reaches the same
 * calendars with none of that: Outlook, Google Calendar and Apple Calendar
 * all subscribe to a URL and re-read it, and moving a window moves the
 * event in every subscriber's calendar without XMS holding anybody's
 * credential. The Graph push stays open; this is the half that can be
 * built and operated today.
 *
 * Two rules keep the document honest:
 *
 * - **Every stamp is UTC**, written with the trailing `Z`, so there is no
 *   `VTIMEZONE` block to get wrong and no client that has to agree with us
 *   about a zone database. The reader renders it in its own zone, which is
 *   what functional 5.6 asks for ("time zones follow each attendee's own
 *   calendar").
 * - **`UID` is stable and `SEQUENCE` counts edits.** A window keeps its
 *   UID for life, so a re-read updates the event a subscriber already has
 *   rather than adding a second one, and the sequence rises whenever the
 *   record changes so a client knows which version wins.
 */
export type IcsStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

export interface IcsEvent {
  /** Stable for the life of the thing the event stands for. */
  readonly uid: string;
  readonly start: Date;
  readonly end: Date;
  readonly summary: string;
  readonly description?: string;
  readonly status: IcsStatus;
  /** Rises on every edit of the underlying record; 0 on a record nobody has changed. */
  readonly sequence: number;
  readonly lastModified?: Date;
  /** A freeze blocks nothing on anybody's own calendar, so it is written as free time. */
  readonly transparent?: boolean;
}

export interface IcsCalendarOptions {
  /** `X-WR-CALNAME`: what the subscription is called in the client's sidebar. */
  readonly name: string;
  /** The instant the document was produced; every event carries it as `DTSTAMP`. */
  readonly stamp: Date;
  readonly productId?: string;
}

const CRLF = '\r\n';
const DEFAULT_PRODUCT_ID = '-//XMS//Change calendar//EN';

/** `YYYYMMDDTHHMMSSZ`, the UTC form every client understands without a zone table. */
export function icsStamp(at: Date): string {
  return `${at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')}`;
}

/** RFC 5545 escaping for TEXT values: backslash, semicolon, comma and newline. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Content lines are folded at 75 octets, not 75 characters, and a
 * continuation line begins with one space. Folding on octets is what keeps
 * a multi-byte name from being split down the middle.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let offset = 0;
  let limit = 75;
  while (offset < bytes.length) {
    let take = Math.min(limit, bytes.length - offset);
    // Never cut inside a UTF-8 sequence: continuation bytes are 10xxxxxx.
    while (take > 1 && (bytes[offset + take] & 0xc0) === 0x80) take -= 1;
    parts.push(bytes.subarray(offset, offset + take).toString('utf8'));
    offset += take;
    limit = 74;
  }
  return parts.join(`${CRLF} `);
}

export function writeCalendar(events: readonly IcsEvent[], options: IcsCalendarOptions): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeText(options.productId ?? DEFAULT_PRODUCT_ID)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.name)}`,
  ];
  const stamp = icsStamp(options.stamp);
  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsStamp(event.start)}`,
      `DTEND:${icsStamp(event.end)}`,
      `SUMMARY:${escapeText(event.summary)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    lines.push(
      `STATUS:${event.status}`,
      `SEQUENCE:${Math.max(0, Math.trunc(event.sequence))}`,
      `TRANSP:${event.transparent ? 'TRANSPARENT' : 'OPAQUE'}`,
    );
    if (event.lastModified) lines.push(`LAST-MODIFIED:${icsStamp(event.lastModified)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
