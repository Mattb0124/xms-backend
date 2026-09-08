import { describe, expect, it } from 'vitest';
import { translateEvents, type EventQuery } from './audit-search.js';

/**
 * The audit condition grammar (Audit & Analytics 7.1, XA-03). The null
 * tests are the Portfolio-wide filter: `account_id is_null` is the operator
 * audit stream and the portfolio-wide security events, `is_not_null` is
 * everything that belongs to one client.
 */
const problemsOf = (query: EventQuery): string[] => {
  try {
    translateEvents(query);
    return [];
  } catch (error) {
    return (error as { getResponse(): { problems: string[] } }).getResponse().problems;
  }
};

describe('the audit condition grammar', () => {
  it('compiles a null test on a nullable field to a bare SQL predicate with no bind parameter', () => {
    expect(translateEvents({ conditions: [{ field: 'account_id', op: 'is_null' }] })).toEqual({
      sql: '("account_id" is null)',
      values: [],
    });
    expect(translateEvents({ conditions: [{ field: 'account_id', op: 'is_not_null' }] })).toEqual({
      sql: '("account_id" is not null)',
      values: [],
    });
  });

  it('numbers the binds of the other conditions from the offset it was given, null tests taking none', () => {
    expect(
      translateEvents(
        {
          conditions: [
            { field: 'account_id', op: 'is_null' },
            { field: 'stream', op: 'eq', value: 'audit' },
          ],
        },
        3,
      ),
    ).toEqual({ sql: '("account_id" is null and "stream" = $4)', values: ['audit'] });
  });

  it('refuses a null test on a column every branch of the view writes', () => {
    for (const field of ['stream', 'event_type', 'occurred_at', 'actor_kind', 'outcome'] as const)
      expect(problemsOf({ conditions: [{ field, op: 'is_null' }] })).toEqual([
        'condition 0: is_null needs a nullable field',
      ]);
  });

  it('refuses a null test that carries a value, rather than ignoring it', () => {
    expect(problemsOf({ conditions: [{ field: 'account_id', op: 'is_null', value: null }] })).toEqual([
      'condition 0: is_null takes no value',
    ]);
    expect(problemsOf({ conditions: [{ field: 'entity_id', op: 'is_not_null', value: 'x' }] })).toEqual([
      'condition 0: is_not_null takes no value',
    ]);
  });

  it('still refuses an unknown field and an unknown operator', () => {
    expect(problemsOf({ conditions: [{ field: 'attrs', op: 'is_null' }] as never })).toEqual([
      'condition 0: unknown field attrs',
    ]);
    expect(problemsOf({ conditions: [{ field: 'account_id', op: 'isnull' }] as never })).toEqual([
      'condition 0: unknown operator isnull',
    ]);
  });
});
