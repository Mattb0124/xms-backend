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

/**
 * Anchored, exactly as `stripJournalMarker` is. Matching the marker
 * anywhere in the body meant a client who typed `[XMS:deadbeef]` into a
 * ServiceNow comment had it silently dropped as one of our own.
 */
export function hasJournalMarker(text: string): boolean {
  return /^\s*\[XMS:[0-9a-f]{8}\]/i.test(text);
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

// Outbound ---------------------------------------------------------------------

/** The XMS changes a connector type may subscribe to (`op.connector_types.outbound_events`). */
export const OUTBOUND_EVENTS = [
  'ticket.updated',
  'ticket.transitioned',
  'comment.created',
  'work_note.created',
  'attachment.scanned',
] as const;

export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

export function isOutboundEvent(value: string): value is OutboundEvent {
  return (OUTBOUND_EVENTS as readonly string[]).includes(value);
}

/** The origin the apply handler stamps on everything it writes for an instance. */
export function syncOrigin(instanceId: string): string {
  return `sync:${instanceId}`;
}

export interface EnqueueInput {
  readonly event: string;
  /** The origin of the XMS change (`user`, `portal`, `sync:<instance>`, ...). */
  readonly origin: string | null | undefined;
  readonly instanceId: string;
  readonly mode: 'off' | 'ingest_only' | 'bidirectional';
  /** What the connector type subscribes to. */
  readonly subscribedEvents: readonly string[];
  /** Whether the ticket is linked to a record on this instance. */
  readonly hasLink: boolean;
  readonly syncWorkNotes: boolean;
  /** For `attachment.scanned`: an internal file never reaches a client's record. */
  readonly attachmentVisibility?: string;
}

export type EnqueueDecision =
  | { readonly enqueue: true }
  | {
      readonly enqueue: false;
      readonly reason: 'own_origin' | 'mode' | 'unsubscribed' | 'work_notes_off' | 'internal_attachment' | 'no_link';
    };

/**
 * Whether one XMS change becomes an outbound row for one instance
 * (ServiceNow Sync technical 3.5; SN-03). The first rule is the loop guard:
 * a change this instance's own apply handler wrote carries its origin and
 * is never sent back to it, whatever else holds. Another instance's origin
 * is not an echo and does cross.
 *
 * The kill switch is deliberately not a condition here. Tripping stops
 * delivery, not queueing: "a comment written in XMS while the instance is
 * tripped is sent when the switch is re-armed, in order" (functional 5.7),
 * and the dispatcher hands each outbox row over once, so a change dropped
 * at queue time is lost rather than delayed. The deliver job is where the
 * switch is honoured, on every claim and again mid-flight.
 */
export function decideEnqueue(input: EnqueueInput): EnqueueDecision {
  if (input.origin === syncOrigin(input.instanceId)) return { enqueue: false, reason: 'own_origin' };
  if (input.mode !== 'bidirectional') return { enqueue: false, reason: 'mode' };
  if (!input.subscribedEvents.includes(input.event)) return { enqueue: false, reason: 'unsubscribed' };
  if (input.event === 'work_note.created' && !input.syncWorkNotes) return { enqueue: false, reason: 'work_notes_off' };
  if (input.event === 'attachment.scanned' && input.attachmentVisibility !== 'public')
    return { enqueue: false, reason: 'internal_attachment' };
  if (!input.hasLink) return { enqueue: false, reason: 'no_link' };
  return { enqueue: true };
}

/**
 * Whether the record moved on the ServiceNow side since the update we last
 * knew about. The clock tolerance is the one the reflection rule uses:
 * `sys_updated_on` has second granularity and the instance's clock is not
 * ours, so a stamp inside the tolerance is our own write coming back.
 */
export function externalChangedSince(
  lastKnown: Date | null | undefined,
  sysUpdatedOn: Date,
  toleranceSeconds = 5,
): boolean {
  if (!lastKnown) return false;
  return sysUpdatedOn.getTime() > lastKnown.getTime() + toleranceSeconds * 1000;
}

export interface OutboundConflictInput {
  readonly policy: SystemOfRecord;
  /** Whether the case changed on the ServiceNow side since the link's last known update. */
  readonly externalChanged: boolean;
  readonly xmsValue: unknown;
  readonly externalValue: unknown;
  readonly xmsUpdatedAt?: Date | null;
  readonly externalUpdatedAt?: Date | null;
}

export type OutboundDecision =
  | { readonly send: true; readonly reason: 'uncontested' | 'xms_owned' | 'merge' | 'newest' }
  | { readonly send: false; readonly reason: 'external_owned' | 'older' | 'none' | 'same' };

/**
 * The per-field decision on an outbound value: the mirror of
 * `decideInbound` with the same policy vocabulary (ServiceNow Sync
 * technical 2.8). A field the instance owns is never overwritten by XMS
 * even when XMS changed it; `newest` is the only policy where timestamps
 * decide, and only when both sides moved.
 */
export function decideOutbound(input: OutboundConflictInput): OutboundDecision {
  if (input.policy === 'none') return { send: false, reason: 'none' };
  if (normalise(input.xmsValue) === normalise(input.externalValue)) return { send: false, reason: 'same' };
  if (input.policy === 'external') return { send: false, reason: 'external_owned' };
  if (input.policy === 'merge') return { send: true, reason: 'merge' };
  if (input.policy === 'newest') {
    if (!input.externalChanged) return { send: true, reason: 'newest' };
    const xms = input.xmsUpdatedAt?.getTime() ?? 0;
    const external = input.externalUpdatedAt?.getTime() ?? 0;
    return xms > external ? { send: true, reason: 'newest' } : { send: false, reason: 'older' };
  }
  // `xms` and `external_at_create_then_xms`: after creation XMS owns the field.
  return { send: true, reason: input.externalChanged ? 'xms_owned' : 'uncontested' };
}

/** Attempts an outbound row gets before the dead letters. */
export const MAX_OUTBOUND_ATTEMPTS = 5;

/** Seconds between outbound attempts; the last value serves the remaining attempts. */
export const OUTBOUND_BACKOFF_SECONDS = [5, 30, 120, 600] as const;

/** When an outbound row that has made `attempt` attempts is due again, or null when that was the last. */
export function outboundNextAttempt(attempt: number, from: Date): Date | null {
  if (attempt >= MAX_OUTBOUND_ATTEMPTS) return null;
  const seconds = OUTBOUND_BACKOFF_SECONDS[Math.min(attempt, OUTBOUND_BACKOFF_SECONDS.length) - 1];
  return new Date(from.getTime() + seconds * 1000);
}

/** Errors a connector call may raise, classified for retry (5xx, 429, timeouts) or the dead letter (4xx, mapping). */
export type ErrorClass = 'retryable' | 'terminal';

export function classifyHttpStatus(status: number): ErrorClass {
  if (status === 429 || status >= 500 || status === 0) return 'retryable';
  return 'terminal';
}
