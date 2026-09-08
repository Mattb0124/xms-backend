import { randomBytes } from 'node:crypto';

/**
 * Thread matching (Email Intake & Outbound technical 2.6). Pure over the
 * parsed headers and a lookup interface the service implements inside the
 * account's session, so a token or Message-ID from another account is
 * simply not found (and reported as a probe by the caller).
 */
export interface ThreadHeaders {
  readonly recipients: readonly string[];
  readonly inReplyTo?: string | null;
  readonly references: readonly string[];
  readonly subject: string;
}

export interface ThreadLookup {
  byPlusToken(token: string): Promise<string | undefined>;
  byMessageId(messageId: string): Promise<string | undefined>;
  byTicketKey(key: string): Promise<{ ticketId: string; closedTooLong: boolean } | undefined>;
}

export type MatchedBy = 'plus_token' | 'in_reply_to' | 'references' | 'subject_key';

export interface ThreadMatch {
  readonly ticketId: string;
  readonly matchedBy: MatchedBy;
}

const PLUS_TOKEN = /^[a-z0-9.-]+\+([a-z2-7]{12})@/i;
const SUBJECT_KEY = /\[(CS\d{7,})\]/i;

export function normaliseMessageId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('<') ? trimmed : `<${trimmed.replace(/^<|>$/g, '')}>`;
}

export function plusTokenOf(recipients: readonly string[]): string | undefined {
  for (const recipient of recipients) {
    const match = recipient.match(PLUS_TOKEN);
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

export function subjectKeyOf(subject: string): string | undefined {
  const match = subject.match(SUBJECT_KEY);
  return match ? match[1].toUpperCase() : undefined;
}

export async function matchThread(headers: ThreadHeaders, lookup: ThreadLookup): Promise<ThreadMatch | undefined> {
  const token = plusTokenOf(headers.recipients);
  if (token) {
    const ticketId = await lookup.byPlusToken(token);
    if (ticketId) return { ticketId, matchedBy: 'plus_token' };
  }
  const inReplyTo = normaliseMessageId(headers.inReplyTo);
  if (inReplyTo) {
    const ticketId = await lookup.byMessageId(inReplyTo);
    if (ticketId) return { ticketId, matchedBy: 'in_reply_to' };
  }
  for (const reference of [...headers.references].reverse()) {
    const normalised = normaliseMessageId(reference);
    if (!normalised) continue;
    const ticketId = await lookup.byMessageId(normalised);
    if (ticketId) return { ticketId, matchedBy: 'references' };
  }
  const key = subjectKeyOf(headers.subject);
  if (key) {
    const found = await lookup.byTicketKey(key);
    if (found && !found.closedTooLong) return { ticketId: found.ticketId, matchedBy: 'subject_key' };
  }
  return undefined;
}

/**
 * Twelve characters of base32 (RFC 4648 lower-case alphabet), the token
 * stored on the ticket. It is the strongest control against inbound thread
 * hijacking and every outbound mail publishes one, so it comes from the
 * CSPRNG: V8's Math.random is xorshift128+ and its state is recoverable
 * from a modest number of observed outputs. The alphabet has 32 symbols
 * and 32 divides 256, so masking the low five bits of a random byte is
 * uniform with no rejection needed.
 */
export function newEmailToken(bytes: (size: number) => Uint8Array = randomBytes): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let token = '';
  for (const byte of bytes(12)) token += alphabet[byte & 31];
  return token;
}
