import { BadRequestException } from '@nestjs/common';

/**
 * The condition builder grammar (Ticket Management technical 3.3, P2.11.1)
 * translated to SQL with an allowlist of fields and operators. A saved view
 * stores a ConditionSet; the Queue sends one inline. Nothing here is
 * interpolated: every value is a bind parameter, every column name comes
 * from the allowlist.
 */
export type Operator =
  'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'before' | 'after' | 'is_null' | 'is_not_null' | 'is_me';

export interface Condition {
  readonly field: string;
  readonly op: Operator;
  readonly value?: unknown;
}

export interface ConditionSet {
  readonly conditions: readonly Condition[];
  /** all (AND) or any (OR); default all. */
  readonly match?: 'all' | 'any';
}

interface FieldSpec {
  readonly column: string;
  readonly kind: 'text' | 'enum' | 'timestamp' | 'boolean' | 'uuid' | 'actor';
  readonly values?: readonly string[];
}

export const FIELDS: Record<string, FieldSpec> = {
  state: { column: 'state', kind: 'enum' },
  type: { column: 'type', kind: 'enum', values: ['incident', 'service_request', 'change', 'problem', 'project_task'] },
  priority: { column: 'priority', kind: 'enum', values: ['p1', 'p2', 'p3', 'p4'] },
  impact: { column: 'impact', kind: 'enum', values: ['high', 'medium', 'low'] },
  urgency: { column: 'urgency', kind: 'enum', values: ['high', 'medium', 'low'] },
  source: { column: 'source', kind: 'enum', values: ['portal', 'email', 'internal', 'api', 'sync', 'import'] },
  category: { column: 'category', kind: 'text' },
  short_description: { column: 'short_description', kind: 'text' },
  account_id: { column: 'account_id', kind: 'uuid' },
  contract_id: { column: 'contract_id', kind: 'uuid' },
  group_id: { column: 'group_id', kind: 'uuid' },
  assignee_id: { column: 'assignee_id', kind: 'actor' },
  created_by: { column: 'created_by', kind: 'actor' },
  created_at: { column: 'created_at', kind: 'timestamp' },
  updated_at: { column: 'updated_at', kind: 'timestamp' },
  resolved_at: { column: 'resolved_at', kind: 'timestamp' },
  first_response_at: { column: 'first_response_at', kind: 'timestamp' },
  sla_response_breached: { column: 'sla_response_breached', kind: 'boolean' },
  sla_resolution_breached: { column: 'sla_resolution_breached', kind: 'boolean' },
  priority_overridden: { column: 'priority_overridden', kind: 'boolean' },
};

const OPERATORS_BY_KIND: Record<FieldSpec['kind'], readonly Operator[]> = {
  text: ['eq', 'neq', 'contains', 'is_null', 'is_not_null'],
  enum: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
  timestamp: ['before', 'after', 'is_null', 'is_not_null'],
  boolean: ['eq'],
  uuid: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
  actor: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null', 'is_me'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONDITIONS = 20;
const MAX_LIST = 50;

export interface Translated {
  readonly sql: string;
  readonly values: unknown[];
}

/** Validates the set and returns a WHERE fragment with `$n` placeholders starting at `offset + 1`. */
export function translate(set: ConditionSet, context: { userId: string }, offset = 0): Translated {
  const problems = validate(set);
  if (problems.length > 0) throw new BadRequestException({ code: 'invalid_conditions', problems });
  const values: unknown[] = [];
  const parts: string[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${offset + values.length}`;
  };
  for (const condition of set.conditions) {
    // validate() has already refused any field that is not an own key.
    const spec = FIELDS[condition.field];
    const column = `"${spec.column}"`;
    switch (condition.op) {
      case 'eq':
        parts.push(
          spec.kind === 'boolean'
            ? `${column} = ${bind(Boolean(condition.value))}`
            : `${column} = ${bind(String(condition.value))}`,
        );
        break;
      case 'neq':
        parts.push(`${column} is distinct from ${bind(String(condition.value))}`);
        break;
      case 'in':
        parts.push(
          `${column} = any (${bind((condition.value as unknown[]).map(String))}::${spec.kind === 'uuid' ? 'uuid' : 'text'}[])`,
        );
        break;
      case 'not_in':
        parts.push(
          `(${column} is null or ${column} <> all (${bind((condition.value as unknown[]).map(String))}::${spec.kind === 'uuid' ? 'uuid' : 'text'}[]))`,
        );
        break;
      case 'contains':
        parts.push(`${column} ilike ${bind(`%${escapeLike(String(condition.value))}%`)}`);
        break;
      case 'before':
        parts.push(`${column} < ${bind(new Date(String(condition.value)).toISOString())}::timestamptz`);
        break;
      case 'after':
        parts.push(`${column} > ${bind(new Date(String(condition.value)).toISOString())}::timestamptz`);
        break;
      case 'is_null':
        parts.push(`${column} is null`);
        break;
      case 'is_not_null':
        parts.push(`${column} is not null`);
        break;
      case 'is_me':
        parts.push(`${column} = ${bind(context.userId)}`);
        break;
    }
  }
  const joiner = set.match === 'any' ? ' or ' : ' and ';
  return { sql: parts.length > 0 ? `(${parts.join(joiner)})` : 'true', values };
}

export function validate(set: ConditionSet): string[] {
  const problems: string[] = [];
  if (!set || !Array.isArray(set.conditions)) return ['conditions must be an array'];
  if (set.conditions.length > MAX_CONDITIONS) problems.push(`at most ${MAX_CONDITIONS} conditions`);
  if (set.match !== undefined && set.match !== 'all' && set.match !== 'any') problems.push('match must be all or any');
  set.conditions.forEach((condition, index) => {
    // Own keys only: "constructor" and "toString" are not fields, and
    // reaching Object.prototype here turns a bad request into a 500.
    const spec = Object.hasOwn(FIELDS, condition.field) ? FIELDS[condition.field] : undefined;
    if (!spec) {
      problems.push(`condition ${index}: unknown field ${String(condition.field)}`);
      return;
    }
    if (!OPERATORS_BY_KIND[spec.kind].includes(condition.op)) {
      problems.push(`condition ${index}: operator ${String(condition.op)} not allowed on ${condition.field}`);
      return;
    }
    const needsValue = !['is_null', 'is_not_null', 'is_me'].includes(condition.op);
    if (needsValue && (condition.value === undefined || condition.value === null || condition.value === '')) {
      problems.push(`condition ${index}: value required`);
      return;
    }
    if (condition.op === 'in' || condition.op === 'not_in') {
      if (!Array.isArray(condition.value) || condition.value.length === 0 || condition.value.length > MAX_LIST) {
        problems.push(`condition ${index}: list of 1 to ${MAX_LIST} values required`);
        return;
      }
    }
    const scalars =
      condition.op === 'in' || condition.op === 'not_in'
        ? (condition.value as unknown[])
        : needsValue
          ? [condition.value]
          : [];
    for (const scalar of scalars) {
      if (spec.kind === 'uuid' && !UUID.test(String(scalar)))
        problems.push(`condition ${index}: ${String(scalar)} is not a uuid`);
      if (spec.kind === 'enum' && spec.values && !spec.values.includes(String(scalar)))
        problems.push(`condition ${index}: ${String(scalar)} is not a ${condition.field}`);
      if (spec.kind === 'timestamp' && Number.isNaN(new Date(String(scalar)).getTime()))
        problems.push(`condition ${index}: ${String(scalar)} is not a date`);
      if (spec.kind === 'text' && String(scalar).length > 200) problems.push(`condition ${index}: text too long`);
    }
  });
  return problems;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
