import { describe, expect, it } from 'vitest';
import { validate as validateConditions } from '../../modules/tickets/conditions.js';
import { translateEvents } from '../../modules/reporting/audit-search.js';
import { stripReply, MAX_STRIP_CHARS } from '../../domain/email/stripper.js';
import { isStrongSealingKey } from '../../domain/integrations/webhooks.js';
import { csvCell, neutraliseCell, neutraliseFormula, toCsvRows } from '../../domain/reporting/csv.js';

/**
 * The contained hardening of the 2026-09-08 security review: prototype-safe
 * allowlist lookups (12), a linear reply stripper (13), the sealing key rule
 * (23) and one formula neutraliser for every export (40).
 */
describe('allowlist lookups are prototype safe', () => {
  it('treats an Object.prototype key as an unknown ticket condition field, not a 500', () => {
    for (const field of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const problems = validateConditions({
        match: 'all',
        conditions: [{ field, op: 'eq', value: 'x' }],
      } as never);
      expect(problems).toEqual([`condition 0: unknown field ${field}`]);
    }
  });

  it('treats an Object.prototype key as an unknown audit field, so it never reaches a column name', () => {
    // Unguarded this emitted `"constructor" = $1`, which Postgres rejects
    // with "column does not exist": a 500 where a 400 belongs.
    let thrown: unknown;
    try {
      translateEvents({ conditions: [{ field: 'constructor', op: 'eq', value: 'x' }] } as never);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { getResponse(): { code: string; problems: string[] } }).getResponse()).toEqual({
      code: 'invalid_conditions',
      problems: ['condition 0: unknown field constructor'],
    });
  });
});

describe('the reply stripper is linear in its input', () => {
  it('cuts at a quote marker that starts its own line and not across lines', () => {
    expect(stripReply('Thanks for the update.\n\n> the original\n> message').text.trim()).toBe(
      'Thanks for the update.',
    );
    // A ">" mid-line is prose, not a quote marker.
    expect(stripReply('a > b is the rule').text).toContain('a > b is the rule');
  });

  it('caps the body it examines, so a large whitespace run cannot pin the worker', () => {
    const body = `${' '.repeat(MAX_STRIP_CHARS + 5000)}tail`;
    const started = Date.now();
    const result = stripReply(body);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.text.length).toBeLessThanOrEqual(MAX_STRIP_CHARS);
  });
});

describe('the webhook sealing key rule', () => {
  it('accepts 32 raw bytes or their base64, and nothing weaker', () => {
    expect(isStrongSealingKey('a'.repeat(32))).toBe(true);
    expect(isStrongSealingKey(Buffer.alloc(32, 7).toString('base64'))).toBe(true);
    expect(isStrongSealingKey('a'.repeat(16))).toBe(false);
    expect(isStrongSealingKey('correct horse battery')).toBe(false);
    expect(isStrongSealingKey(Buffer.alloc(16, 7).toString('base64'))).toBe(false);
  });
});

describe('one formula neutraliser for every export', () => {
  it('covers the full leading set in both output formats', () => {
    for (const text of ['=cmd', '+1', '-1', '@SUM', '\tx', '\rx']) {
      expect(neutraliseFormula(text)).toBe(`'${text}`);
      expect(neutraliseCell(text)).toBe(`'${text}`);
    }
    expect(neutraliseFormula('hello')).toBe('hello');
    expect(neutraliseCell(5)).toBe(5);
  });

  it('quotes and doubles what CSV requires, after neutralising', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(toCsvRows(['a', 'b'], [['=x', 'plain']])).toBe("a,b\r\n'=x,plain");
  });
});
