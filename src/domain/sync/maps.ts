/**
 * Field and state maps as data (Integration Patterns section 4; ServiceNow
 * Sync technical 2.2, 3.2). Pure functions: transforms without scripting,
 * inbound translation of an external record into a ticket patch, and the
 * validation report an administrator sees before a version can be
 * activated. Nothing here touches the database or the network.
 */
export type Direction = 'in' | 'out' | 'both';

export type Transform =
  | { readonly kind: 'none' }
  | { readonly kind: 'lookup'; readonly values: Record<string, string>; readonly fallback?: string }
  | { readonly kind: 'template'; readonly template: string }
  | { readonly kind: 'truncate'; readonly length: number };

/** System of record per field (ServiceNow Sync technical 2.8). */
export type SystemOfRecord = 'xms' | 'external' | 'newest' | 'merge' | 'external_at_create_then_xms' | 'none';

export interface FieldMapEntry {
  readonly external: string;
  readonly xms: XmsField;
  readonly direction: Direction;
  readonly transform?: Transform;
  readonly sor?: SystemOfRecord;
}

export interface FieldMap {
  readonly entries: readonly FieldMapEntry[];
}

/** The ticket fields a map may target; `required` must be mapped inbound. */
export const XMS_FIELDS = {
  short_description: { required: true, sor: 'external_at_create_then_xms' },
  description: { required: false, sor: 'external_at_create_then_xms' },
  requester_email: { required: true, sor: 'external_at_create_then_xms' },
  requester_name: { required: false, sor: 'external_at_create_then_xms' },
  category: { required: false, sor: 'xms' },
  impact: { required: false, sor: 'external_at_create_then_xms' },
  urgency: { required: false, sor: 'external_at_create_then_xms' },
  external_ref: { required: false, sor: 'external' },
  client_reference: { required: false, sor: 'external' },
  client_notes: { required: false, sor: 'newest' },
} as const satisfies Record<string, { required: boolean; sor: SystemOfRecord }>;

export type XmsField = keyof typeof XMS_FIELDS;

export const LEVELS = ['high', 'medium', 'low'] as const;

export function defaultSor(field: XmsField): SystemOfRecord {
  return XMS_FIELDS[field].sor;
}

export function applyTransform(
  value: unknown,
  transform: Transform | undefined,
  record: Record<string, unknown>,
): unknown {
  if (!transform || transform.kind === 'none') return value;
  switch (transform.kind) {
    case 'lookup': {
      const key = value === null || value === undefined ? '' : String(value);
      return key in transform.values ? transform.values[key] : (transform.fallback ?? undefined);
    }
    case 'template':
      return transform.template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, name: string) => {
        const found = record[name];
        return found === null || found === undefined ? '' : String(found);
      });
    case 'truncate': {
      if (value === null || value === undefined) return value;
      const text = String(value);
      return text.length > transform.length ? text.slice(0, transform.length) : text;
    }
    default:
      return value;
  }
}

export interface InboundTranslation {
  readonly patch: Partial<Record<XmsField, unknown>>;
  /** External fields present on the record that no inbound entry maps. */
  readonly unmapped: string[];
  /** Entries whose external field was missing on the record. */
  readonly missing: string[];
}

/** Translates an external record into ticket fields through the inbound entries. */
export function translateInbound(map: FieldMap, record: Record<string, unknown>): InboundTranslation {
  const patch: Partial<Record<XmsField, unknown>> = {};
  const missing: string[] = [];
  const mappedExternal = new Set<string>();
  for (const entry of map.entries) {
    if (entry.direction === 'out') continue;
    mappedExternal.add(entry.external);
    const raw = pick(record, entry.external);
    if (raw === undefined) {
      missing.push(entry.external);
      continue;
    }
    const value = applyTransform(raw, entry.transform, record);
    if (entry.xms === 'impact' || entry.xms === 'urgency') {
      const level = String(value ?? '').toLowerCase();
      if ((LEVELS as readonly string[]).includes(level)) patch[entry.xms] = level;
      continue;
    }
    patch[entry.xms] = value;
  }
  const unmapped = Object.keys(record).filter(
    (key) => !mappedExternal.has(key) && !SYSTEM_FIELDS.has(key) && !key.startsWith('sys_'),
  );
  return { patch, unmapped, missing };
}

/** ServiceNow reference fields arrive as `{ value, display_value }` or as a plain value. */
function pick(record: Record<string, unknown>, field: string): unknown {
  const raw = record[field];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const reference = raw as { display_value?: unknown; value?: unknown };
    return reference.display_value ?? reference.value;
  }
  return raw;
}

const SYSTEM_FIELDS = new Set([
  'sys_id',
  'sys_updated_on',
  'sys_created_on',
  'sys_updated_by',
  'sys_created_by',
  'sys_mod_count',
]);

// Validation ------------------------------------------------------------------

export interface DictionaryField {
  readonly name: string;
  readonly mandatory?: boolean;
  readonly type?: string;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly problems: string[];
  readonly warnings: string[];
  readonly checked_samples: number;
}

/**
 * A field map version is valid when every required XMS field has an inbound
 * entry, every entry names a field the dictionary knows, lookups cover the
 * values seen in the samples, and no XMS field is mapped twice in one
 * direction. Warnings do not block activation.
 */
export function validateFieldMap(
  map: FieldMap,
  dictionary: readonly DictionaryField[],
  samples: readonly Record<string, unknown>[] = [],
): ValidationReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const known = new Set(dictionary.map((field) => field.name));
  const inboundTargets = new Map<string, number>();
  const outboundTargets = new Map<string, number>();
  for (const [index, entry] of map.entries.entries()) {
    if (!(entry.xms in XMS_FIELDS)) problems.push(`entry ${index}: unknown XMS field ${String(entry.xms)}`);
    if (!['in', 'out', 'both'].includes(entry.direction)) problems.push(`entry ${index}: bad direction`);
    if (known.size > 0 && !known.has(entry.external))
      problems.push(`entry ${index}: ${entry.external} is not in the dictionary`);
    if (entry.direction !== 'out') inboundTargets.set(entry.xms, (inboundTargets.get(entry.xms) ?? 0) + 1);
    if (entry.direction !== 'in') outboundTargets.set(entry.xms, (outboundTargets.get(entry.xms) ?? 0) + 1);
    if (entry.transform?.kind === 'truncate' && !(entry.transform.length > 0))
      problems.push(`entry ${index}: truncate length must be positive`);
    if (entry.transform?.kind === 'lookup') {
      const lookup = entry.transform;
      const seen = new Set<string>();
      for (const sample of samples) {
        const value = pick(sample, entry.external);
        if (value !== undefined && value !== null) seen.add(String(value));
      }
      const gaps = [...seen].filter((value) => !(value in lookup.values));
      if (gaps.length > 0 && lookup.fallback === undefined)
        problems.push(`entry ${index}: lookup has no value for ${gaps.join(', ')} seen in the samples and no fallback`);
    }
  }
  for (const [field, spec] of Object.entries(XMS_FIELDS)) {
    if (spec.required && !inboundTargets.has(field)) problems.push(`required field ${field} has no inbound entry`);
  }
  for (const [field, count] of inboundTargets)
    if (count > 1) problems.push(`${field} is mapped inbound more than once`);
  for (const [field, count] of outboundTargets)
    if (count > 1) problems.push(`${field} is mapped outbound more than once`);
  for (const field of dictionary) {
    if (field.mandatory && !map.entries.some((entry) => entry.external === field.name && entry.direction !== 'in'))
      warnings.push(`mandatory external field ${field.name} has no outbound entry (creation outbound will fail)`);
  }
  for (const sample of samples) {
    const { missing } = translateInbound(map, sample);
    for (const field of missing) warnings.push(`sample without ${field}`);
  }
  return {
    ok: problems.length === 0,
    problems: unique(problems),
    warnings: unique(warnings),
    checked_samples: samples.length,
  };
}

// State maps ------------------------------------------------------------------

export interface StateMapForType {
  readonly inbound: Record<string, string>;
  readonly outbound: Record<string, string>;
  /** XMS states an inbound change may move the ticket into (the client reopening or cancelling). */
  readonly accept_inbound?: readonly string[];
  /** When a mapped target is not reachable from the current state: the state to use instead. */
  readonly fallback?: Record<string, string>;
}

export type StateMap = Record<string, StateMapForType>;

export function validateStateMap(
  map: StateMap,
  externalStates: readonly string[],
  machines: Record<string, readonly string[]>,
): ValidationReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const types = Object.keys(map);
  if (types.length === 0) problems.push('no ticket type mapped');
  for (const [type, entry] of Object.entries(map)) {
    const states = machines[type];
    if (!states) {
      problems.push(`unknown ticket type ${type}`);
      continue;
    }
    for (const external of externalStates) {
      if (!(external in entry.inbound)) problems.push(`${type}: external state ${external} has no inbound mapping`);
    }
    for (const [external, xms] of Object.entries(entry.inbound)) {
      if (!states.includes(xms)) problems.push(`${type}: inbound ${external} maps to unknown state ${xms}`);
    }
    const seen = new Map<string, string[]>();
    for (const [xms, external] of Object.entries(entry.outbound)) {
      if (!states.includes(xms)) problems.push(`${type}: outbound ${xms} is not a state of ${type}`);
      seen.set(external, [...(seen.get(external) ?? []), xms]);
    }
    for (const [external, sources] of seen) {
      if (sources.length > 1 && !(entry.fallback && external in entry.fallback))
        problems.push(
          `${type}: states ${sources.join(', ')} all map outbound to ${external} without a tie-break in fallback`,
        );
    }
    for (const accepted of entry.accept_inbound ?? []) {
      if (!states.includes(accepted)) problems.push(`${type}: accept_inbound names unknown state ${accepted}`);
    }
    for (const state of states) {
      if (!(state in entry.outbound)) warnings.push(`${type}: XMS state ${state} has no outbound mapping`);
    }
  }
  return { ok: problems.length === 0, problems: unique(problems), warnings: unique(warnings), checked_samples: 0 };
}

/**
 * The XMS state an inbound external state should produce, or undefined when
 * the map does not accept inbound moves to it. `allowed` are the targets the
 * state machine permits from the current state; when the mapped target is
 * not among them the map's fallback for that target applies, then nothing.
 */
export function resolveInboundState(
  entry: StateMapForType,
  externalState: string,
  currentState: string,
  allowed: readonly string[],
): { target?: string; via?: 'direct' | 'fallback'; reason?: 'unmapped' | 'not_accepted' | 'unreachable' | 'same' } {
  const mapped = entry.inbound[externalState];
  if (!mapped) return { reason: 'unmapped' };
  if (mapped === currentState) return { reason: 'same' };
  if (entry.accept_inbound && !entry.accept_inbound.includes(mapped)) return { reason: 'not_accepted' };
  if (allowed.includes(mapped)) return { target: mapped, via: 'direct' };
  const fallback = entry.fallback?.[mapped];
  if (fallback && allowed.includes(fallback)) return { target: fallback, via: 'fallback' };
  return { reason: 'unreachable' };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
