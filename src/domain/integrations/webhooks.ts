import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Outbound webhooks (Integrations technical 2.3 and section 5; INT-05):
 * the public event catalog, the canonical body and its signature, the
 * endpoint guard against private destinations, the retry schedule, and the
 * envelope for the signing secret at rest.
 */
export const PUBLIC_EVENT_TYPES = [
  'ticket.created',
  'ticket.updated',
  'ticket.transitioned',
  'comment.created',
  'time_entry.created',
  'billing_period.locked',
] as const;
export type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

/** Outbox event types that surface publicly, and the public name each takes. */
export const OUTBOX_TO_PUBLIC: Readonly<Record<string, PublicEventType>> = {
  'ticket.created': 'ticket.created',
  'ticket.updated': 'ticket.updated',
  'ticket.transitioned': 'ticket.transitioned',
  'comment.created': 'comment.created',
  'time.logged': 'time_entry.created',
  'billing_period.locked': 'billing_period.locked',
};

export function isPublicEventType(value: string): value is PublicEventType {
  return (PUBLIC_EVENT_TYPES as readonly string[]).includes(value);
}

export interface WebhookEnvelope {
  readonly id: string;
  readonly type: PublicEventType;
  readonly occurred_at: string;
  readonly account_id: string;
  readonly data: Record<string, unknown>;
}

/** Canonical JSON: the five envelope keys in a fixed order, data as given. */
export function canonicalBody(envelope: WebhookEnvelope): string {
  return JSON.stringify({
    id: envelope.id,
    type: envelope.type,
    occurred_at: envelope.occurred_at,
    account_id: envelope.account_id,
    data: envelope.data,
  });
}

/** `v1=<hex hmac-sha256(secret, timestamp + "." + body)>` */
export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(kid: string, secret: string, timestamp: string, body: string): string {
  return `kid=${kid}, v1=${sign(secret, timestamp, body)}`;
}

/** Verifies a signature header the way a receiver would; tolerates five minutes of skew. */
export function verifySignature(
  header: string,
  secret: string,
  timestamp: string,
  body: string,
  now = Date.now(),
  skewSeconds = 300,
): boolean {
  const match = /v1=([0-9a-f]{64})/.exec(header);
  if (!match) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > skewSeconds) return false;
  const expected = Buffer.from(sign(secret, timestamp, body), 'hex');
  const given = Buffer.from(match[1], 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type EndpointProblem = 'not_https' | 'private_host' | 'invalid_host' | 'invalid_url';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** True for loopback, link-local, private and unspecified addresses (v4 and v6). */
export function isPrivateAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal'))
    return true;
  const version = isIP(bare);
  if (version === 4) return PRIVATE_V4.some((pattern) => pattern.test(bare));
  if (version === 6) {
    if (bare === '::1' || bare === '::') return true;
    // Unique local fc00::/7 and the whole of link local fe80::/10 (fe80 to febf).
    if (bare.startsWith('fc') || bare.startsWith('fd') || /^fe[89ab]/.test(bare)) return true;
    if (bare.startsWith('::ffff:')) return isPrivateAddress(bare.slice(7));
    return false;
  }
  return false;
}

/**
 * A destination is addressed either by a registered domain name or by a
 * literal address. `2130706433`, `0x7f000001`, `127.1` and `0177.0.0.1` are
 * none of those: `isIP` returns 0 for every one of them, so the private
 * ranges are never consulted, while `getaddrinfo` resolves all four to
 * loopback. Requiring a real name or a real literal closes that door.
 */
const DOMAIN_NAME = /^(?=.{1,253}\.?$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}\.?$/i;

export function isAddressableHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) return true;
  return DOMAIN_NAME.test(bare);
}

/** The registration-time guard: HTTPS only, no private host names or addresses (unless the deployment allows it for tests). */
export function endpointProblem(url: string, allowPrivate = false): EndpointProblem | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid_url';
  }
  if (parsed.protocol !== 'https:' && !(allowPrivate && parsed.protocol === 'http:')) return 'not_https';
  if (!allowPrivate && isPrivateAddress(parsed.hostname)) return 'private_host';
  if (!allowPrivate && !isAddressableHost(parsed.hostname)) return 'invalid_host';
  if (parsed.username || parsed.password) return 'invalid_url';
  return null;
}

export const MAX_ATTEMPTS = 5;
/** Minutes to wait before attempt n + 1 (after attempts 1, 2, 3, 4). */
export const BACKOFF_MINUTES = [1, 5, 30, 120] as const;

export function nextAttemptAt(attempt: number, from: Date): Date | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  const minutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length) - 1];
  return new Date(from.getTime() + minutes * 60_000);
}

/** Consecutive dead-lettered events after which a subscription pauses itself. */
export const PAUSE_AFTER_FAILURES = 3;

// The signing secret at rest: AES-256-GCM under the application key.

export function newSecret(): { secret: string; kid: string } {
  return { secret: `whsec_${randomBytes(24).toString('base64url')}`, kid: randomBytes(6).toString('hex') };
}

/**
 * A sealing key must carry 32 bytes of entropy: either 32 raw bytes or the
 * 44-character base64 of them. Anything else is stretched by a single
 * HMAC with a fixed public salt, which is brute-forceable offline against a
 * stolen ciphertext, so production refuses it at boot (finding 23).
 */
export function isStrongSealingKey(key: string): boolean {
  if (key.length === 44 && /^[A-Za-z0-9+/=]+$/.test(key)) return Buffer.from(key, 'base64').length === 32;
  return Buffer.byteLength(key, 'utf8') === 32;
}

function keyBytes(key: string): Buffer {
  const raw = Buffer.from(key, key.length === 44 && /^[A-Za-z0-9+/=]+$/.test(key) ? 'base64' : 'utf8');
  if (raw.length === 32) return raw;
  return createHmac('sha256', 'xms-webhooks').update(key).digest();
}

export function sealSecret(secret: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function openSecret(sealed: string, key: string): string {
  const [version, iv, body, tag] = sealed.split('.');
  if (version !== 'v1' || !iv || !body || !tag) throw new Error('sealed secret has an unknown shape');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
