import { describe, expect, it } from 'vitest';
import {
  canonicalBody,
  endpointProblem,
  isPrivateAddress,
  newSecret,
  nextAttemptAt,
  openSecret,
  sealSecret,
  signatureHeader,
  verifySignature,
} from './webhooks.js';

describe('canonical body and signature', () => {
  const envelope = {
    id: 'evt-1',
    type: 'ticket.created' as const,
    occurred_at: '2026-09-08T10:00:00.000Z',
    account_id: 'acct-1',
    data: { key: 'CS0000001', state: 'new' },
  };

  it('orders the envelope keys and signs timestamp.body with the key id', () => {
    const body = canonicalBody(envelope);
    expect(body).toBe(
      '{"id":"evt-1","type":"ticket.created","occurred_at":"2026-09-08T10:00:00.000Z","account_id":"acct-1","data":{"key":"CS0000001","state":"new"}}',
    );
    const timestamp = String(Math.floor(Date.now() / 1000));
    const header = signatureHeader('abc123', 'whsec_x', timestamp, body);
    expect(header).toMatch(/^kid=abc123, v1=[0-9a-f]{64}$/);
    expect(verifySignature(header, 'whsec_x', timestamp, body)).toBe(true);
    expect(verifySignature(header, 'whsec_y', timestamp, body)).toBe(false);
    expect(verifySignature(header, 'whsec_x', timestamp, body + ' ')).toBe(false);
    expect(verifySignature(header, 'whsec_x', String(Number(timestamp) - 600), body)).toBe(false);
  });
});

describe('endpoint guard', () => {
  it('accepts public HTTPS and refuses the rest', () => {
    expect(endpointProblem('https://hooks.example.com/xms')).toBeNull();
    expect(endpointProblem('http://hooks.example.com/xms')).toBe('not_https');
    expect(endpointProblem('https://localhost/xms')).toBe('private_host');
    expect(endpointProblem('https://10.0.0.5/xms')).toBe('private_host');
    expect(endpointProblem('https://169.254.169.254/latest')).toBe('private_host');
    expect(endpointProblem('https://[::1]/xms')).toBe('private_host');
    expect(endpointProblem('https://user:pw@hooks.example.com/xms')).toBe('invalid_url');
    expect(endpointProblem('not a url')).toBe('invalid_url');
    expect(endpointProblem('http://127.0.0.1:9/xms', true)).toBeNull();
  });

  it('knows the private ranges', () => {
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.1')).toBe(true);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('2001:db8::1')).toBe(false);
    expect(isPrivateAddress('api.internal')).toBe(true);
  });
});

describe('retries and the secret envelope', () => {
  it('backs off one, five, thirty and a hundred and twenty minutes, then stops', () => {
    const from = new Date('2026-09-08T10:00:00Z');
    expect(nextAttemptAt(1, from)?.toISOString()).toBe('2026-09-08T10:01:00.000Z');
    expect(nextAttemptAt(2, from)?.toISOString()).toBe('2026-09-08T10:05:00.000Z');
    expect(nextAttemptAt(3, from)?.toISOString()).toBe('2026-09-08T10:30:00.000Z');
    expect(nextAttemptAt(4, from)?.toISOString()).toBe('2026-09-08T12:00:00.000Z');
    expect(nextAttemptAt(5, from)).toBeNull();
  });

  it('seals and opens a secret under the application key and refuses another key', () => {
    const { secret, kid } = newSecret();
    expect(secret).toMatch(/^whsec_/);
    expect(kid).toMatch(/^[0-9a-f]{12}$/);
    const sealed = sealSecret(secret, 'application-key-for-tests');
    expect(sealed).not.toContain(secret.slice(6));
    expect(openSecret(sealed, 'application-key-for-tests')).toBe(secret);
    expect(() => openSecret(sealed, 'another-key')).toThrow();
  });
});
