import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { translate, validate, type ConditionSet } from './conditions.js';

const me = { userId: 'user-1' };

describe('condition translation', () => {
  it('translates a three-condition set to a parameterised AND fragment', () => {
    const set: ConditionSet = {
      conditions: [
        { field: 'state', op: 'in', value: ['new', 'in_progress'] },
        { field: 'priority', op: 'eq', value: 'p1' },
        { field: 'assignee_id', op: 'is_me' },
      ],
    };
    const result = translate(set, me, 2);
    expect(result.sql).toBe('("state" = any ($3::text[]) and "priority" = $4 and "assignee_id" = $5)');
    expect(result.values).toEqual([['new', 'in_progress'], 'p1', 'user-1']);
  });

  it('supports OR sets, null checks, contains with escaped wildcards and timestamps', () => {
    const set: ConditionSet = {
      match: 'any',
      conditions: [
        { field: 'assignee_id', op: 'is_null' },
        { field: 'short_description', op: 'contains', value: '100% sure_' },
        { field: 'created_at', op: 'after', value: '2026-09-01T00:00:00Z' },
      ],
    };
    const result = translate(set, me);
    expect(result.sql).toBe(
      '("assignee_id" is null or "short_description" ilike $1 or "created_at" > $2::timestamptz)',
    );
    expect(result.values).toEqual(['%100\\% sure\\_%', '2026-09-01T00:00:00.000Z']);
  });

  it('yields true for an empty set', () => {
    expect(translate({ conditions: [] }, me)).toEqual({ sql: 'true', values: [] });
  });

  it('rejects unknown fields, disallowed operators, bad enums and bad uuids with every problem named', () => {
    const problems = validate({
      conditions: [
        { field: 'password', op: 'eq', value: 'x' },
        { field: 'created_at', op: 'contains', value: 'x' },
        { field: 'priority', op: 'eq', value: 'p9' },
        { field: 'account_id', op: 'in', value: ['not-a-uuid'] },
        { field: 'state', op: 'in', value: [] },
        { field: 'category', op: 'eq' },
      ],
    });
    expect(problems).toEqual([
      'condition 0: unknown field password',
      'condition 1: operator contains not allowed on created_at',
      'condition 2: p9 is not a priority',
      'condition 3: not-a-uuid is not a uuid',
      'condition 4: list of 1 to 50 values required',
      'condition 5: value required',
    ]);
    expect(() => translate({ conditions: [{ field: 'x', op: 'eq', value: 1 }] }, me)).toThrow(BadRequestException);
  });

  it('never interpolates a value into the SQL text', () => {
    const result = translate(
      { conditions: [{ field: 'category', op: 'eq', value: "'; drop table acct.tickets; --" }] },
      me,
    );
    expect(result.sql).toBe('("category" = $1)');
    expect(result.values[0]).toBe("'; drop table acct.tickets; --");
  });
});
