import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import type { Permission } from '../../src/contracts/permissions.js';
import { expandPermissions } from '../../src/contracts/permissions.js';
import type { PrincipalRepository, ResolvedAccess, UserRow } from '../../src/common/auth/principal.repository.js';
import { API_KEY_PREFIX, apiKeyLookupHash } from '../../src/common/auth/principal.repository.js';
import type { SecurityEvent, SecurityEventSink } from '../../src/common/events/security-events.service.js';
import { DEV_ISSUER } from '../../src/common/auth/token-verifier.js';
import bcrypt from 'bcryptjs';

/**
 * Constructed identities for the auth suites: an in-memory principal store,
 * an in-memory security event sink, and token minters for every token type
 * (dev HS256, Clerk RS256 with a local key pair, harness HS256, API keys).
 * No live credential anywhere.
 */
export const DEV_SECRET = 'test-development-secret-0123456789';
export const HARNESS_SECRET = 'test-harness-session-secret-0123';
export const CLERK_ISSUER = 'https://clerk.xms.test';
export const AUTHORIZED_PARTY = 'https://xms.test';
export const AGENTS_AUDIENCE = 'xms-axel';
export const INTERNAL_ORG = 'hackett';

export type TestUser = { -readonly [K in keyof UserRow]: UserRow[K] } & {
  clerk_user_id: string | null;
  permissions: Permission[];
  accountIds: string[];
};

export function aUser(overrides: Partial<TestUser> = {}): TestUser {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    kind: 'internal',
    account_id: null,
    email: `${id.slice(0, 8)}@example.test`,
    first_name: 'Test',
    last_name: 'User',
    status: 'active',
    clerk_user_id: null,
    permissions: ['tickets:view'],
    accountIds: [],
    ...overrides,
  };
}

export class InMemoryPrincipals implements Pick<
  PrincipalRepository,
  | 'findUserByClerkId'
  | 'findUserByEmail'
  | 'findUserById'
  | 'accountKey'
  | 'attachClerkId'
  | 'touchSignIn'
  | 'resolveAccess'
  | 'findApiClient'
  | 'touchApiClient'
> {
  readonly users = new Map<string, TestUser>();
  readonly apiClients = new Map<
    string,
    {
      id: string;
      name: string;
      service_user_id: string;
      secret_hash: string;
      scopes: string[];
      expires_at: string | null;
      status: 'active' | 'revoked';
      rate_limit_per_minute: number;
      accountIds: string[];
    }
  >();

  add(user: TestUser): TestUser {
    this.users.set(user.id, user);
    return user;
  }

  async findUserByClerkId(clerkUserId: string): Promise<UserRow | undefined> {
    return [...this.users.values()].find((user) => user.clerk_user_id === clerkUserId);
  }

  async findUserByEmail(email: string): Promise<UserRow | undefined> {
    return [...this.users.values()].find((user) => user.email.toLowerCase() === email.toLowerCase());
  }

  async findUserById(id: string): Promise<UserRow | undefined> {
    return this.users.get(id);
  }

  /** Account id to account key, the shape a portal organisation slug is built from. */
  readonly accountKeys = new Map<string, string>();

  async accountKey(accountId: string): Promise<string | undefined> {
    return this.accountKeys.get(accountId);
  }

  async attachClerkId(userId: string, clerkUserId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user && !user.clerk_user_id) {
      user.clerk_user_id = clerkUserId;
      if (user.status === 'invited') user.status = 'active';
    }
  }

  async touchSignIn(): Promise<void> {}

  async resolveAccess(user: UserRow): Promise<ResolvedAccess> {
    const full = this.users.get(user.id)!;
    return {
      user,
      accountIds: full.accountIds,
      permissions: expandPermissions(full.permissions),
    };
  }

  async findApiClient(key: string) {
    const client = this.apiClients.get(apiKeyLookupHash(key));
    if (!client) return undefined;
    return (await bcrypt.compare(key, client.secret_hash)) ? client : undefined;
  }

  async touchApiClient(): Promise<void> {}

  async addApiClient(
    serviceUser: TestUser,
    scopes: Permission[],
    accountIds: string[],
    status: 'active' | 'revoked' = 'active',
    ratePerMinute = 600,
  ) {
    const key = `${API_KEY_PREFIX}${randomUUID().replace(/-/g, '')}`;
    this.apiClients.set(apiKeyLookupHash(key), {
      id: randomUUID(),
      name: 'Test client',
      service_user_id: serviceUser.id,
      secret_hash: await bcrypt.hash(key, 4),
      scopes,
      expires_at: null,
      status,
      rate_limit_per_minute: ratePerMinute,
      accountIds,
    });
    return key;
  }
}

export class RecordingSink implements SecurityEventSink {
  readonly events: SecurityEvent[] = [];

  async write(event: SecurityEvent): Promise<void> {
    this.events.push(event);
  }

  ofType(type: string): SecurityEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}

export async function devToken(
  claims: {
    sub: string;
    email?: string;
    org?: string;
    sid?: string;
    aud?: string;
    expiresIn?: string;
  },
  secret: string = DEV_SECRET,
): Promise<string> {
  let builder = new SignJWT({
    email: claims.email,
    org_slug: claims.org ?? INTERNAL_ORG,
    sid: claims.sid ?? `sess_${randomUUID()}`,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(DEV_ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '1h');
  if (claims.aud) builder = builder.setAudience(claims.aud);
  return builder.sign(new TextEncoder().encode(secret));
}

export async function harnessToken(
  claims: { sub: string; email: string; type?: string },
  secret: string = HARNESS_SECRET,
): Promise<string> {
  return new SignJWT({
    email: claims.email,
    type: claims.type ?? 'session',
    session_id: `hs_${randomUUID()}`,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}

export interface ClerkKeys {
  readonly privateKey: CryptoKey;
  readonly resolver: JWTVerifyGetKey;
}

export async function clerkKeys(): Promise<ClerkKeys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey, resolver: createLocalJWKSet({ keys: [jwk] }) };
}

export async function clerkToken(
  keys: ClerkKeys,
  claims: {
    sub: string;
    email?: string;
    org?: string;
    azp?: string;
    aud?: string;
    sid?: string;
    issuer?: string;
  },
): Promise<string> {
  let builder = new SignJWT({
    email: claims.email,
    org_slug: claims.org ?? INTERNAL_ORG,
    azp: claims.azp ?? AUTHORIZED_PARTY,
    sid: claims.sid ?? `sess_${randomUUID()}`,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(claims.issuer ?? CLERK_ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('1h');
  if (claims.aud) builder = builder.setAudience(claims.aud);
  return builder.sign(keys.privateKey);
}
