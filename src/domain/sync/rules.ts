import { createHash } from 'node:crypto';
import type { SystemOfRecord } from './maps.js';

/**
 * The loop and conflict rules (Integration Patterns section 3; ServiceNow
 * Sync technical 2.7, 2.8). Pure: the caller supplies the link watermarks
 * and the values, the rule answers apply or skip with a reason that becomes
 * the sync run outcome.
 */

/** Canonical hash over the fields we sent, so an echo compares equal whatever the key order. */
export function outboundHash(fields: Record<string, unknown>): string {
  const canonical = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key] === null || fields[key] === undefined ? '' : String(fields[key])}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export interface ReflectionInput {
  /** The link's last outbound write, if any. */
  readonly lastOutboundAt: Date | null;
  readonly lastOutboundHash: string | null;
  /** The inbound record's update time and the hash of its values for the fields we sent. */
  readonly sysUpdatedOn: Date;
  readonly inboundHash: string;
  readonly toleranceSeconds?: number;
}

/**
 * An inbound update is a reflection of our own write when it is not later
 * than that write plus the clock tolerance and carries the same values.
 */
export function isReflection(input: ReflectionInput): boolean {
  if (!input.lastOutboundAt || !input.lastOutboundHash) return false;
  const tolerance = (input.toleranceSeconds ?? 5) * 1000;
  if (input.sysUpdatedOn.getTime() > input.lastOutboundAt.getTime() + tolerance) return false;
  return input.inboundHash === input.lastOutboundHash;
}

/** The correlation marker XMS writes into every outbound journal entry. */
export function journalMarker(commentId: string): string {
  return `[XMS:${commentId.replace(/-/g, '').slice(0, 8)}]`;
}

export function hasJournalMarker(text: string): boolean {
  return /\[XMS:[0-9a-f]{8}\]/i.test(text);
}

export function stripJournalMarker(text: string): string {
  return text.replace(/^\s*\[XMS:[0-9a-f]{8}\]\s*/i, '').trim();
}

export interface ConflictInput {
  readonly policy: SystemOfRecord;
  readonly isCreate: boolean;
  readonly xmsValue: unknown;
  readonly externalValue: unknown;
  /** When the XMS field last changed (its last audit event), for `newest`. */
  readonly xmsUpdatedAt?: Date | null;
  readonly externalUpdatedAt?: Date | null;
}

export type ConflictDecision =
  | { readonly apply: true; readonly reason: 'create' | 'external' | 'newest' | 'merge' | 'unchanged' }
  | { readonly apply: false; readonly reason: 'xms_owned' | 'older' | 'none' | 'same' };

/** Per-field decision on an inbound value; never last-write-wins without an explicit `newest`. */
export function decideInbound(input: ConflictInput): ConflictDecision {
  const same = normalise(input.xmsValue) === normalise(input.externalValue);
  switch (input.policy) {
    case 'none':
      return { apply: false, reason: 'none' };
    case 'external':
      return same ? { apply: false, reason: 'same' } : { apply: true, reason: 'external' };
    case 'merge':
      return { apply: true, reason: 'merge' };
    case 'external_at_create_then_xms':
      if (input.isCreate) return { apply: true, reason: 'create' };
      return same ? { apply: false, reason: 'same' } : { apply: false, reason: 'xms_owned' };
    case 'xms':
      if (input.isCreate) return { apply: true, reason: 'create' };
      return same ? { apply: false, reason: 'same' } : { apply: false, reason: 'xms_owned' };
    case 'newest': {
      if (input.isCreate) return { apply: true, reason: 'create' };
      if (same) return { apply: false, reason: 'same' };
      const external = input.externalUpdatedAt?.getTime() ?? 0;
      const xms = input.xmsUpdatedAt?.getTime() ?? 0;
      return external > xms ? { apply: true, reason: 'newest' } : { apply: false, reason: 'older' };
    }
    default:
      return { apply: false, reason: 'none' };
  }
}

function normalise(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Errors a connector call may raise, classified for retry (5xx, 429, timeouts) or the dead letter (4xx, mapping). */
export type ErrorClass = 'retryable' | 'terminal';

export function classifyHttpStatus(status: number): ErrorClass {
  if (status === 429 || status >= 500 || status === 0) return 'retryable';
  return 'terminal';
}
