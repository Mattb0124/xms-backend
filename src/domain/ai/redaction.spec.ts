import { describe, expect, it } from 'vitest';
import { redact, restoreRoles } from './redaction.js';

describe('redaction before egress', () => {
  it('masks credential-shaped strings in key=value and URL forms', () => {
    const result = redact(
      'Use api_key=sk_live_1234567890abcdef and password: "hunter22" at https://svc:s3cret@db.example.com/x',
    );
    expect(result.text).toContain('api_key=[redacted:credential]');
    expect(result.text).toContain('password: [redacted:credential]');
    expect(result.text).toContain('https://[redacted:credential]@db.example.com/x');
    expect(result.text).not.toContain('hunter22');
    expect(result.counts.credential).toBe(3);
    expect(result.refused).toBe(false);
  });

  it('masks bearer tokens, JWTs and AWS access keys', () => {
    const jwt = `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(20)}`;
    const result = redact(`Authorization: Bearer abcdefghijklmnop123456 then ${jwt} and AKIAIOSFODNN7EXAMPLE`);
    expect(result.text).toBe('Authorization: Bearer [redacted:token] then [redacted:token] and [redacted:aws_key]');
    expect(result.counts.token).toBe(2);
    expect(result.counts.aws_key).toBe(1);
  });

  it('masks card numbers that pass Luhn and leaves other digit runs alone', () => {
    const result = redact('Card 4111 1111 1111 1111 but ticket 1234567890123 is fine');
    expect(result.text).toBe('Card [redacted:card] but ticket 1234567890123 is fine');
    expect(result.counts.card).toBe(1);
  });

  it('masks a valid IBAN and leaves a look-alike with a bad check', () => {
    const result = redact('Pay GB82 WEST 1234 5698 7654 32 not GB00 WEST 1234 5698 7654 32');
    expect(result.text).toBe('Pay [redacted:iban] not GB00 WEST 1234 5698 7654 32');
  });

  it('refuses a payload carrying a private key block', () => {
    const result = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----');
    expect(result.refused).toBe(true);
  });

  it('replaces named people by role labels under the strict profile, reversibly', () => {
    const result = redact('Pat Client <pat@client.test> asked; pat@client.test again', 'strict', [
      { email: 'pat@client.test', name: 'Pat Client', role: 'requester' },
    ]);
    expect(result.text).toBe('[requester] <[requester]> asked; [requester] again');
    expect(result.roleMap).toEqual({ '[requester]': 'Pat Client <pat@client.test>' });
    expect(restoreRoles('Hello [requester], done.', result.roleMap)).toBe('Hello Pat Client, done.');
  });

  it('does not touch ordinary text', () => {
    const text = 'The VPN drops every 20 minutes since the 2.4.1 update on floor 3.';
    expect(redact(text)).toMatchObject({ text, counts: {}, refused: false });
  });
});
