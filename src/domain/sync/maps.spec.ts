import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  resolveInboundState,
  translateInbound,
  validateFieldMap,
  validateStateMap,
  type FieldMap,
  type StateMap,
} from './maps.js';
import {
  classifyHttpStatus,
  decideInbound,
  hasJournalMarker,
  isReflection,
  journalMarker,
  outboundHash,
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
