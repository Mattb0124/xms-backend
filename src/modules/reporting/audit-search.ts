import { BadRequestException } from '@nestjs/common';

/**
 * The audit search grammar over rpt.events_v (Audit & Analytics 7.1;
 * P2.11.5 cut): the same shape as the Queue conditions, with the event
 * field allowlist. Every value is a bind parameter; `is_null` and
 * `is_not_null` carry none, and compile to a bare predicate on the column.
 */
export interface EventCondition {
  readonly field:
    | 'stream'
    | 'event_type'
    | 'actor_id'
    | 'actor_kind'
    | 'principal_kind'
    | 'account_id'
    | 'entity_kind'
    | 'entity_id'
    | 'outcome'
    | 'request_id'
    | 'correlation_id'
    | 'occurred_at';
  readonly op: 'eq' | 'neq' | 'in' | 'contains' | 'before' | 'after' | 'is_null' | 'is_not_null';
  /**
   * Absent for `is_null` and `is_not_null`: those two ask about the column
   * itself, so a value sent with them is refused rather than ignored.
   */
  readonly value?: unknown;
}

export interface EventQuery {
  readonly conditions: readonly EventCondition[];
  readonly limit?: number;
  readonly cursor?: string;
}

const FIELDS: Record<EventCondition['field'], 'text' | 'uuid' | 'timestamp'> = {
  stream: 'text',
  event_type: 'text',
  actor_id: 'text',
  actor_kind: 'text',
  principal_kind: 'text',
  account_id: 'uuid',
  entity_kind: 'text',
  entity_id: 'text',
  outcome: 'text',
  request_id: 'text',
  correlation_id: 'text',
  occurred_at: 'timestamp',
};

/**
 * The columns of `rpt.events_v` that can be null, and so the only ones
 * `is_null` and `is_not_null` mean anything on. `account_id` is the reason
 * the pair exists: the operator audit stream and the portfolio-wide
 * security events carry no account, and asking for exactly those rows is
 * the Portfolio-wide filter the Admin audit screen offers. `stream`,
 * `event_type`, `occurred_at`, `actor_kind` and `outcome` are written by
 * every branch of the view, so a null test on them is a mistake worth a
 * 400 rather than a filter that always answers nothing.
 */
const NULLABLE: ReadonlySet<string> = new Set([
  'account_id',
  'actor_id',
  'principal_kind',
  'entity_kind',
  'entity_id',
  'request_id',
  'correlation_id',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function translateEvents(query: EventQuery, offset = 0): { sql: string; values: unknown[] } {
  const problems: string[] = [];
  const values: unknown[] = [];
  const parts: string[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${offset + values.length}`;
  };
  if (!Array.isArray(query.conditions) || query.conditions.length > 20)
    problems.push('conditions must be a list of at most 20');
  for (const [index, condition] of (query.conditions ?? []).entries()) {
    // Own keys only: a prototype key would be emitted as a column name.
    const kind = Object.hasOwn(FIELDS, condition.field) ? FIELDS[condition.field] : undefined;
    if (!kind) {
      problems.push(`condition ${index}: unknown field ${String(condition.field)}`);
      continue;
    }
    const column = `"${condition.field}"`;
    const valid = (scalar: unknown): boolean =>
      kind === 'uuid'
        ? UUID.test(String(scalar))
        : kind === 'timestamp'
          ? !Number.isNaN(new Date(String(scalar)).getTime())
          : typeof scalar === 'string' && scalar.length <= 200;
    switch (condition.op) {
      case 'eq':
      case 'neq':
        if (!valid(condition.value)) problems.push(`condition ${index}: bad value`);
        else
          parts.push(
            `${column} ${condition.op === 'eq' ? '=' : 'is distinct from'} ${bind(String(condition.value))}${kind === 'uuid' ? '::uuid' : kind === 'timestamp' ? '::timestamptz' : ''}`,
          );
        break;
      case 'in':
        if (
          !Array.isArray(condition.value) ||
          condition.value.length === 0 ||
          condition.value.length > 50 ||
          !condition.value.every(valid)
        )
          problems.push(`condition ${index}: bad list`);
        else
          parts.push(`${column} = any (${bind(condition.value.map(String))}::${kind === 'uuid' ? 'uuid' : 'text'}[])`);
        break;
      case 'contains':
        if (kind !== 'text' || !valid(condition.value)) problems.push(`condition ${index}: contains needs text`);
        else parts.push(`${column} ilike ${bind(`%${String(condition.value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
        break;
      case 'before':
      case 'after':
        if (kind !== 'timestamp' || !valid(condition.value)) problems.push(`condition ${index}: needs a date`);
        else
          parts.push(
            `${column} ${condition.op === 'before' ? '<' : '>'} ${bind(new Date(String(condition.value)).toISOString())}::timestamptz`,
          );
        break;
      case 'is_null':
      case 'is_not_null':
        if (!NULLABLE.has(condition.field)) problems.push(`condition ${index}: ${condition.op} needs a nullable field`);
        else if (condition.value !== undefined) problems.push(`condition ${index}: ${condition.op} takes no value`);
        else parts.push(`${column} is ${condition.op === 'is_null' ? 'null' : 'not null'}`);
        break;
      default:
        problems.push(`condition ${index}: unknown operator ${String((condition as { op: string }).op)}`);
    }
  }
  if (problems.length > 0) throw new BadRequestException({ code: 'invalid_conditions', problems });
  return { sql: parts.length > 0 ? `(${parts.join(' and ')})` : 'true', values };
}
