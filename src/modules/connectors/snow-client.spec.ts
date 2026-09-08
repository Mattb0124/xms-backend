import { describe, expect, it } from 'vitest';
import { assertSysId, SnowError, tablePath } from './snow-client.js';

/**
 * What the client will let out of the process (review 2026-09-09 finding
 * 20). A record id is chosen by the instance and reaches ServiceNow's
 * encoded-query grammar by concatenation, where `^` and `=` are the
 * grammar's own separators and survive percent-encoding as structure, so a
 * hostile instance returning `...^ORDERBYsys_created_on^OR...` could rewrite
 * the query XMS sends back to it.
 */
describe('the record id a polled payload names', () => {
  it('takes 32 lowercase hex characters and nothing else', () => {
    const real = 'a'.repeat(32);
    expect(assertSysId(real)).toBe(real);
    expect(assertSysId('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
  });

  it('refuses an id carrying the encoded-query grammar', () => {
    for (const hostile of [
      `${'a'.repeat(32)}^ORactive=true`,
      `${'a'.repeat(31)}^`,
      'a'.repeat(31),
      'a'.repeat(33),
      'A'.repeat(32),
      '',
      'element_id=x^ORDERBYsys_created_on',
    ]) {
      expect(() => assertSysId(hostile)).toThrow(SnowError);
    }
  });

  it('still encodes the path segments it builds', () => {
    expect(tablePath('incident', 'a/b')).toBe('/api/now/table/incident/a%2Fb');
  });
});
