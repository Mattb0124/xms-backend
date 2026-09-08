import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  resolveInboundState,
  resolveOutboundState,
  reverseTransform,
  translateInbound,
  translateOutbound,
  validateFieldMap,
  validateStateMap,
  type FieldMap,
  type StateMap,
  type StateMapForType,
} from './maps.js';
import {
  classifyHttpStatus,
  decideEnqueue,
  decideInbound,
  decideOutbound,
  externalChangedSince,
  hasJournalMarker,
  isReflection,
  journalMarker,
  MAX_OUTBOUND_ATTEMPTS,
  OUTBOUND_EVENTS,
  outboundHash,
  outboundNextAttempt,
  syncOrigin,
  stripJournalMarker,
} from './rules.js';

const CSM_MAP: FieldMap = {
  entries: [
    { external: 'short_description', xms: 'short_description', direction: 'both' },
    { external: 'description', xms: 'description', direction: 'both', transform: { kind: 'truncate', length: 20 } },
    { external: 'contact.email', xms: 'requester_email', direction: 'in' },
    { external: 'contact', xms: 'requester_name', direction: 'in' },
    { external: 'number', xms: 'client_reference', direction: 'in' },
    {
      external: 'impact',
      xms: 'impact',
      direction: 'in',
      transform: { kind: 'lookup', values: { '1': 'high', '2': 'medium', '3': 'low' } },
    },
    {
      external: 'category',
      xms: 'category',
      direction: 'both',
      transform: { kind: 'template', template: '{{category}} / {{subcategory}}' },
    },
  ],
};

const RECORD = {
  sys_id: 'abc',
  sys_updated_on: '2026-09-07 10:00:00',
  number: 'CS0001234',
  short_description: 'VPN drops',
  description: 'A long description that goes on and on',
  'contact.email': 'pat@client.test',
  contact: { value: 'u1', display_value: 'Pat Client' },
  impact: '2',
  category: 'network',
  subcategory: 'vpn',
  u_ignored: 'x',
};

describe('transforms and inbound translation', () => {
  it('applies none, lookup with fallback, template and truncate', () => {
    expect(applyTransform('a', undefined, {})).toBe('a');
    expect(applyTransform('2', { kind: 'lookup', values: { '2': 'medium' } }, {})).toBe('medium');
    expect(applyTransform('9', { kind: 'lookup', values: { '2': 'medium' }, fallback: 'low' }, {})).toBe('low');
    expect(applyTransform('9', { kind: 'lookup', values: { '2': 'medium' } }, {})).toBeUndefined();
    expect(applyTransform(null, { kind: 'template', template: '{{a}}-{{ b }}' }, { a: 1, b: null })).toBe('1-');
    expect(applyTransform('abcdef', { kind: 'truncate', length: 3 }, {})).toBe('abc');
  });

  it('translates a CSM record into a ticket patch, reading references by display value', () => {
    const result = translateInbound(CSM_MAP, RECORD);
    expect(result.patch).toEqual({
      short_description: 'VPN drops',
      description: 'A long description t',
      requester_email: 'pat@client.test',
      requester_name: 'Pat Client',
      client_reference: 'CS0001234',
      impact: 'medium',
      category: 'network / vpn',
    });
    expect(result.unmapped).toEqual(['subcategory', 'u_ignored']);
    expect(result.missing).toEqual([]);
  });

  it('drops an impact outside the vocabulary and reports missing external fields', () => {
    const result = translateInbound(CSM_MAP, { short_description: 'x', impact: '7' });
    expect(result.patch).toEqual({ short_description: 'x' });
    expect(result.missing).toEqual(['description', 'contact.email', 'contact', 'number', 'category']);
  });
});

describe('field map validation', () => {
  const dictionary = [
    { name: 'short_description', mandatory: true },
    { name: 'description' },
    { name: 'contact.email' },
    { name: 'contact' },
    { name: 'number' },
    { name: 'impact' },
    { name: 'category' },
  ];

  it('accepts the CSM map against its dictionary and samples', () => {
    const report = validateFieldMap(CSM_MAP, dictionary, [RECORD]);
    expect(report).toMatchObject({ ok: true, problems: [], checked_samples: 1 });
  });

  it('names every problem at once: missing required field, unknown field, duplicate target, lookup gap', () => {
    const report = validateFieldMap(
      {
        entries: [
          { external: 'short_description', xms: 'short_description', direction: 'in' },
          { external: 'title2', xms: 'short_description', direction: 'in' },
          {
            external: 'impact',
            xms: 'impact',
            direction: 'in',
            transform: { kind: 'lookup', values: { '1': 'high' } },
          },
        ],
      },
      dictionary,
      [RECORD],
    );
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      'entry 1: title2 is not in the dictionary',
      'entry 2: lookup has no value for 2 seen in the samples and no fallback',
      'required field requester_email has no inbound entry',
      'short_description is mapped inbound more than once',
    ]);
  });

  it('warns about mandatory external fields without an outbound entry', () => {
    const report = validateFieldMap(
      {
        entries: [
          { external: 'short_description', xms: 'short_description', direction: 'in' },
          { external: 'contact.email', xms: 'requester_email', direction: 'in' },
        ],
      },
      dictionary,
    );
    expect(report.ok).toBe(true);
    expect(report.warnings).toContain(
      'mandatory external field short_description has no outbound entry (creation outbound will fail)',
    );
  });
});

describe('state map validation and inbound state resolution', () => {
  const machines = {
    incident: ['new', 'assigned', 'in_progress', 'awaiting_client', 'resolved', 'closed', 'cancelled'],
  };
  const map: StateMap = {
    incident: {
      inbound: {
        '1': 'new',
        '10': 'in_progress',
        '18': 'awaiting_client',
        '6': 'resolved',
        '3': 'closed',
        '7': 'cancelled',
      },
      outbound: {
        new: '1',
        assigned: '1',
        in_progress: '10',
        awaiting_client: '18',
        resolved: '6',
        closed: '3',
        cancelled: '7',
      },
      accept_inbound: ['cancelled', 'in_progress'],
      fallback: { '1': 'new', in_progress: 'assigned' },
    },
  };

  it('accepts a complete map and names gaps and ambiguities otherwise', () => {
    expect(validateStateMap(map, ['1', '10', '18', '6', '3', '7'], machines).ok).toBe(true);
    const report = validateStateMap(
      {
        incident: { inbound: { '1': 'nowhere' }, outbound: { new: '1', assigned: '1' } },
        change: { inbound: {}, outbound: {} },
      },
      ['1', '2'],
      machines,
    );
    expect(report.problems).toEqual([
      'incident: external state 2 has no inbound mapping',
      'incident: inbound 1 maps to unknown state nowhere',
      'incident: states new, assigned all map outbound to 1 without a tie-break in fallback',
      'unknown ticket type change',
    ]);
  });

  it('resolves an inbound state directly, through the fallback, or refuses with a reason', () => {
    const entry = map.incident;
    expect(resolveInboundState(entry, '7', 'new', ['assigned', 'in_progress', 'cancelled'])).toEqual({
      target: 'cancelled',
      via: 'direct',
    });
    expect(resolveInboundState(entry, '10', 'new', ['assigned', 'cancelled'])).toEqual({
      target: 'assigned',
      via: 'fallback',
    });
    expect(resolveInboundState(entry, '10', 'closed', [])).toEqual({ reason: 'unreachable' });
    expect(resolveInboundState(entry, '6', 'in_progress', ['resolved'])).toEqual({ reason: 'not_accepted' });
    expect(resolveInboundState(entry, '99', 'new', ['assigned'])).toEqual({ reason: 'unmapped' });
    expect(resolveInboundState(entry, '1', 'new', ['assigned'])).toEqual({ reason: 'same' });
  });
});

describe('reflection and conflict rules', () => {
  const sent = { short_description: 'VPN drops', description: 'x' };

  it('hashes canonically and recognises an echo within the clock tolerance', () => {
    const hash = outboundHash(sent);
    expect(outboundHash({ description: 'x', short_description: 'VPN drops' })).toBe(hash);
    const at = new Date('2026-09-07T10:00:00Z');
    const base = { lastOutboundAt: at, lastOutboundHash: hash, inboundHash: hash };
    expect(isReflection({ ...base, sysUpdatedOn: new Date('2026-09-07T10:00:04Z') })).toBe(true);
    expect(isReflection({ ...base, sysUpdatedOn: new Date('2026-09-07T10:00:06Z') })).toBe(false);
    expect(isReflection({ ...base, sysUpdatedOn: at, inboundHash: 'other' })).toBe(false);
    expect(isReflection({ lastOutboundAt: null, lastOutboundHash: null, sysUpdatedOn: at, inboundHash: hash })).toBe(
      false,
    );
  });

  it('marks, detects and strips the journal correlation marker', () => {
    const marker = journalMarker('0f1e2d3c-4b5a-4677-8899-aabbccddeeff');
    expect(marker).toBe('[XMS:0f1e2d3c]');
    expect(hasJournalMarker(`${marker} We are on it`)).toBe(true);
    expect(stripJournalMarker(`${marker} We are on it`)).toBe('We are on it');
    expect(hasJournalMarker('Plain reply')).toBe(false);
  });

  it('decides per field: external at create then XMS-owned, external wins, newest by timestamp, merge always, none never', () => {
    expect(
      decideInbound({ policy: 'external_at_create_then_xms', isCreate: true, xmsValue: null, externalValue: 'a' }),
    ).toEqual({ apply: true, reason: 'create' });
    expect(
      decideInbound({ policy: 'external_at_create_then_xms', isCreate: false, xmsValue: 'a', externalValue: 'b' }),
    ).toEqual({ apply: false, reason: 'xms_owned' });
    expect(decideInbound({ policy: 'xms', isCreate: false, xmsValue: 'a', externalValue: 'a ' })).toEqual({
      apply: false,
      reason: 'same',
    });
    expect(decideInbound({ policy: 'external', isCreate: false, xmsValue: 'a', externalValue: 'b' })).toEqual({
      apply: true,
      reason: 'external',
    });
    const older = new Date('2026-09-01T00:00:00Z');
    const newer = new Date('2026-09-02T00:00:00Z');
    expect(
      decideInbound({
        policy: 'newest',
        isCreate: false,
        xmsValue: 'a',
        externalValue: 'b',
        xmsUpdatedAt: older,
        externalUpdatedAt: newer,
      }),
    ).toEqual({ apply: true, reason: 'newest' });
    expect(
      decideInbound({
        policy: 'newest',
        isCreate: false,
        xmsValue: 'a',
        externalValue: 'b',
        xmsUpdatedAt: newer,
        externalUpdatedAt: older,
      }),
    ).toEqual({ apply: false, reason: 'older' });
    expect(decideInbound({ policy: 'merge', isCreate: false, xmsValue: 'a', externalValue: 'b' })).toEqual({
      apply: true,
      reason: 'merge',
    });
    expect(decideInbound({ policy: 'none', isCreate: true, xmsValue: null, externalValue: 'b' })).toEqual({
      apply: false,
      reason: 'none',
    });
  });

  it('classifies HTTP failures for retry or the dead letter', () => {
    expect([429, 500, 503, 0].map(classifyHttpStatus)).toEqual(['retryable', 'retryable', 'retryable', 'retryable']);
    expect([400, 401, 403, 404, 422].map(classifyHttpStatus)).toEqual([
      'terminal',
      'terminal',
      'terminal',
      'terminal',
      'terminal',
    ]);
  });
});

describe('outbound translation and the outbound state', () => {
  it('reverses lookups deterministically, truncates, and reports a template as unmapped', () => {
    expect(reverseTransform('medium', { kind: 'lookup', values: { '1': 'high', '2': 'medium' } })).toBe('2');
    // Two external values produce one XMS value: the lowest key always leaves.
    expect(reverseTransform('high', { kind: 'lookup', values: { '4': 'high', '1': 'high' } })).toBe('1');
    expect(reverseTransform('unknown', { kind: 'lookup', values: { '1': 'high' } })).toBeUndefined();
    expect(reverseTransform('a long value', { kind: 'truncate', length: 6 })).toBe('a long');
    expect(reverseTransform('x', { kind: 'template', template: '{{a}}' })).toBeUndefined();
  });

  it('writes only outbound entries, narrows to the changed fields, and names what it could not represent', () => {
    const all = translateOutbound(CSM_MAP, {
      short_description: 'VPN drops',
      description: 'A long description that goes on and on',
      requester_email: 'pat@client.test',
      category: 'network',
    });
    expect(all.body).toEqual({ short_description: 'VPN drops', description: 'A long description t' });
    expect(all.sent).toEqual({ short_description: 'VPN drops', description: 'A long description that goes on and on' });
    // `contact.email` is inbound only and the templated category cannot be reversed.
    expect(all.unmapped).toEqual(['category']);
    const narrowed = translateOutbound(CSM_MAP, { short_description: 'VPN drops', description: 'x' }, [
      'short_description',
    ]);
    expect(narrowed.body).toEqual({ short_description: 'VPN drops' });
  });

  it('resolves the outbound state and names the states that share one external value', () => {
    const entry: StateMapForType = {
      inbound: { '1': 'new', '10': 'in_progress' },
      outbound: { new: '1', assigned: '1', in_progress: '10' },
      fallback: { '1': 'new' },
    };
    expect(resolveOutboundState(entry, 'in_progress')).toEqual({ value: '10' });
    expect(resolveOutboundState(entry, 'assigned')).toEqual({ value: '1', shared: ['new'], canonical: 'new' });
    expect(resolveOutboundState(entry, 'resolved')).toEqual({ reason: 'no_outbound' });
  });
});

describe('the outbound loop guard and conflict policy', () => {
  const base = {
    event: 'ticket.updated',
    origin: 'user',
    instanceId: 'i1',
    mode: 'bidirectional' as const,
    subscribedEvents: [...OUTBOUND_EVENTS],
    hasLink: true,
    syncWorkNotes: false,
  };

  it('never sends a change back to the instance that made it, whatever else holds', () => {
    expect(decideEnqueue({ ...base, origin: syncOrigin('i1') })).toEqual({ enqueue: false, reason: 'own_origin' });
    // Another instance's write is not an echo of ours.
    expect(decideEnqueue({ ...base, origin: syncOrigin('i2') })).toEqual({ enqueue: true });
    expect(decideEnqueue({ ...base, origin: 'portal' })).toEqual({ enqueue: true });
  });

  it('queues only a subscribed event on a bidirectional instance with a link', () => {
    expect(decideEnqueue(base)).toEqual({ enqueue: true });
    expect(decideEnqueue({ ...base, mode: 'ingest_only' })).toEqual({ enqueue: false, reason: 'mode' });
    expect(decideEnqueue({ ...base, mode: 'off' })).toEqual({ enqueue: false, reason: 'mode' });
    expect(decideEnqueue({ ...base, event: 'ticket.created' })).toEqual({ enqueue: false, reason: 'unsubscribed' });
    expect(decideEnqueue({ ...base, hasLink: false })).toEqual({ enqueue: false, reason: 'no_link' });
  });

  it('keeps a work note internal unless the instance is configured to receive one', () => {
    expect(decideEnqueue({ ...base, event: 'work_note.created' })).toEqual({
      enqueue: false,
      reason: 'work_notes_off',
    });
    expect(decideEnqueue({ ...base, event: 'work_note.created', syncWorkNotes: true })).toEqual({ enqueue: true });
  });

  it('sends a public file to the client record and keeps an internal one internal', () => {
    expect(decideEnqueue({ ...base, event: 'attachment.scanned', attachmentVisibility: 'public' })).toEqual({
      enqueue: true,
    });
    expect(decideEnqueue({ ...base, event: 'attachment.scanned', attachmentVisibility: 'internal' })).toEqual({
      enqueue: false,
      reason: 'internal_attachment',
    });
    expect(decideEnqueue({ ...base, event: 'attachment.scanned' })).toEqual({
      enqueue: false,
      reason: 'internal_attachment',
    });
  });

  it('reads a stamp inside the clock tolerance as our own write rather than a change', () => {
    const known = new Date('2026-09-08T10:00:00Z');
    expect(externalChangedSince(known, new Date('2026-09-08T10:00:03Z'), 5)).toBe(false);
    expect(externalChangedSince(known, new Date('2026-09-08T10:00:30Z'), 5)).toBe(true);
    expect(externalChangedSince(null, new Date('2026-09-08T10:00:30Z'), 5)).toBe(false);
  });

  it('decides per field: XMS keeps what it owns, the instance keeps what it owns, newest needs both timestamps', () => {
    const contested = { externalChanged: true, xmsValue: 'a', externalValue: 'b' };
    expect(decideOutbound({ ...contested, policy: 'xms' })).toEqual({ send: true, reason: 'xms_owned' });
    expect(decideOutbound({ ...contested, policy: 'external_at_create_then_xms' })).toEqual({
      send: true,
      reason: 'xms_owned',
    });
    expect(decideOutbound({ ...contested, policy: 'external' })).toEqual({ send: false, reason: 'external_owned' });
    expect(decideOutbound({ ...contested, policy: 'merge' })).toEqual({ send: true, reason: 'merge' });
    expect(decideOutbound({ ...contested, policy: 'none' })).toEqual({ send: false, reason: 'none' });
    expect(decideOutbound({ ...contested, policy: 'xms', xmsValue: 'a', externalValue: 'a ' })).toEqual({
      send: false,
      reason: 'same',
    });
    expect(decideOutbound({ ...contested, policy: 'xms', externalChanged: false })).toEqual({
      send: true,
      reason: 'uncontested',
    });
    const older = new Date('2026-09-01T00:00:00Z');
    const newer = new Date('2026-09-02T00:00:00Z');
    expect(decideOutbound({ ...contested, policy: 'newest', xmsUpdatedAt: newer, externalUpdatedAt: older })).toEqual({
      send: true,
      reason: 'newest',
    });
    expect(decideOutbound({ ...contested, policy: 'newest', xmsUpdatedAt: older, externalUpdatedAt: newer })).toEqual({
      send: false,
      reason: 'older',
    });
    expect(decideOutbound({ ...contested, policy: 'newest', externalChanged: false })).toEqual({
      send: true,
      reason: 'newest',
    });
  });

  it('backs off between attempts and stops at the last one', () => {
    const from = new Date('2026-09-08T10:00:00Z');
    expect(outboundNextAttempt(1, from)?.toISOString()).toBe('2026-09-08T10:00:05.000Z');
    expect(outboundNextAttempt(2, from)?.toISOString()).toBe('2026-09-08T10:00:30.000Z');
    expect(outboundNextAttempt(4, from)?.toISOString()).toBe('2026-09-08T10:10:00.000Z');
    expect(outboundNextAttempt(MAX_OUTBOUND_ATTEMPTS, from)).toBeNull();
  });
});
