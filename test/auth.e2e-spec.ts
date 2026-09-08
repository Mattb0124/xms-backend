import { Controller, Get, INestApplication, VersioningType } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_GUARD_OPTIONS, AuthGuard } from '../src/common/auth/auth.guard.js';
import {
  Authenticated,
  AxelRoute,
  CurrentPrincipal,
  RealmOf,
  RequirePermission,
} from '../src/common/auth/decorators.js';
import type { Principal } from '../src/common/auth/principal.js';
import { PrincipalRepository } from '../src/common/auth/principal.repository.js';
import { Public } from '../src/common/auth/public.decorator.js';
import { TokenVerifiers } from '../src/common/auth/token-verifier.js';
import { SecurityEventsService } from '../src/common/events/security-events.service.js';
import { ApiClientRateLimitInterceptor } from '../src/common/rate-limit/api-client-rate-limit.interceptor.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import {
  AGENTS_AUDIENCE,
  AUTHORIZED_PARTY,
  CLERK_ISSUER,
  DEV_SECRET,
  HARNESS_SECRET,
  INTERNAL_ORG,
  InMemoryPrincipals,
  RecordingSink,
  aUser,
  clerkKeys,
  clerkToken,
  devToken,
  harnessToken,
} from './kit/auth.js';

/**
 * The auth rejection suite (P1.3.4 done-when, P1.3.8 done-when): every
 * rejection is a typed status and exactly one security event.
 */
@Controller('probe')
class ProbeController {
  @Get('open')
  @Public('test')
  open(): { ok: true } {
    return { ok: true };
  }

  @Get('internal')
  @RequirePermission('tickets:view')
  internal(@CurrentPrincipal() principal: Principal): {
    userId: string;
    kind: string;
    accounts: readonly string[];
  } {
    return {
      userId: principal.userId,
      kind: principal.kind,
      accounts: principal.accountIds,
    };
  }

  @Get('admin')
  @RequirePermission('admin:accounts')
  admin(): { ok: true } {
    return { ok: true };
  }

  @Get('me')
  @Authenticated()
  me(@CurrentPrincipal() principal: Principal): {
    kind: string;
    permissions: string[];
  } {
    return {
      kind: principal.kind,
      permissions: [...principal.permissions].sort(),
    };
  }

  @Get('axel')
  @AxelRoute()
  @Authenticated()
  axel(@CurrentPrincipal() principal: Principal): { tokenType: string } {
    return { tokenType: principal.tokenType };
  }
}

@Controller('portal/probe')
@RealmOf('portal')
class PortalProbeController {
  @Get('mine')
  @RequirePermission('portal:submit')
  mine(@CurrentPrincipal() principal: Principal): {
    kind: string;
    accounts: readonly string[];
  } {
    return { kind: principal.kind, accounts: principal.accountIds };
  }
}

let app: INestApplication;
let principals: InMemoryPrincipals;
let sink: RecordingSink;
let keys: Awaited<ReturnType<typeof clerkKeys>>;

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  keys = await clerkKeys();
  principals = new InMemoryPrincipals();
  // A portal organisation slug is `acct-<account key>`; the guard resolves
  // the key from the user's own account and compares the two.
  principals.accountKeys.set(ACCOUNT, 'BRK');
  principals.accountKeys.set(OTHER, 'OTH');
  sink = new RecordingSink();
  const verifiers = new TokenVerifiers({
    clerk: {
      issuer: CLERK_ISSUER,
      authorizedParties: [AUTHORIZED_PARTY],
      agentsAudience: AGENTS_AUDIENCE,
      keys: keys.resolver,
    },
    harnessSessionSecret: HARNESS_SECRET,
    devSecret: DEV_SECRET,
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController, PortalProbeController],
    providers: [
      { provide: TokenVerifiers, useValue: verifiers },
      { provide: PrincipalRepository, useValue: principals },
      { provide: SecurityEventsService, useValue: sink },
      {
        provide: AUTH_GUARD_OPTIONS,
        useValue: { internalOrgSlug: INTERNAL_ORG },
      },
      AuthGuard,
      { provide: APP_GUARD, useExisting: AuthGuard },
      // The per-client rate limit runs after the guard, so it keys on the
      // resolved client rather than on a string from the request.
      ApiClientRateLimitInterceptor,
      { provide: APP_INTERCEPTOR, useExisting: ApiClientRateLimitInterceptor },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  sink.events.length = 0;
});

const get = (path: string, token?: string) => {
  const req = request(app.getHttpServer()).get(path);
  return token ? req.set('authorization', `Bearer ${token}`) : req;
};

describe('public routes', () => {
  it('serves a public route without a token and writes no event', async () => {
    await get('/v1/probe/open').expect(200, { ok: true });
    expect(sink.events).toEqual([]);
  });
});

describe('token rejection', () => {
  it('anonymous is 401 with one auth.token.rejected event', async () => {
    const response = await get('/v1/probe/internal').expect(401);
    expect(response.body.code).toBe('unauthenticated');
    expect(response.headers['x-request-id']).toBeDefined();
    expect(sink.ofType('auth.token.rejected')).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      outcome: 'denied',
      attrs: { reason: 'missing' },
    });
    expect(sink.events[0].requestId).toBe(response.headers['x-request-id']);
  });

  it('garbage is 401', async () => {
    await get('/v1/probe/internal', 'not.a.jwt').expect(401);
    expect(sink.ofType('auth.token.rejected')[0].attrs).toMatchObject({
      reason: 'garbage',
    });
  });

  it('an expired token is 401 with reason expired', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'dev_expired' }));
    const token = await devToken({
      sub: user.clerk_user_id!,
      expiresIn: '-2h',
    });
    await get('/v1/probe/internal', token).expect(401);
    expect(sink.ofType('auth.token.rejected')[0].attrs).toMatchObject({
      reason: 'expired',
    });
  });

  it('a token signed with the wrong secret is 401 with reason bad_signature', async () => {
    const token = await devToken({ sub: 'x' }, 'another-secret-that-is-long-enough');
    await get('/v1/probe/internal', token).expect(401);
    expect(sink.ofType('auth.token.rejected')[0].attrs).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('a Clerk token from an unauthorised party is 401', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'user_party' }));
    const token = await clerkToken(keys, {
      sub: user.clerk_user_id!,
      azp: 'https://evil.test',
    });
    await get('/v1/probe/internal', token).expect(401);
    expect(sink.ofType('auth.token.rejected')[0].attrs).toMatchObject({
      reason: 'bad_party',
    });
  });

  it('a Clerk token from another issuer is 401', async () => {
    const token = await clerkToken(keys, {
      sub: 'user_x',
      issuer: 'https://other.clerk.test',
    });
    await get('/v1/probe/internal', token).expect(401);
    expect(sink.ofType('auth.token.rejected')[0].attrs).toMatchObject({
      reason: 'bad_issuer',
    });
  });

  it('a subject the operator tables do not know is 401 with auth.signin.failed', async () => {
    const token = await devToken({
      sub: 'dev_stranger',
      email: 'stranger@nowhere.test',
    });
    await get('/v1/probe/internal', token).expect(401);
    expect(sink.ofType('auth.signin.failed')[0].attrs).toMatchObject({
      reason: 'unknown_user',
    });
  });

  it('a deactivated user is 401', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'dev_gone', status: 'deactivated' }));
    await get('/v1/probe/internal', await devToken({ sub: user.clerk_user_id! })).expect(401);
    expect(sink.ofType('auth.signin.failed')[0].attrs).toMatchObject({
      reason: 'deactivated',
    });
  });

  it('an internal user presenting a portal organisation is 401', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'user_org' }));
    const token = await clerkToken(keys, {
      sub: user.clerk_user_id!,
      org: 'acct-brk',
    });
    await get('/v1/probe/internal', token).expect(401);
    expect(sink.ofType('auth.signin.failed')[0].attrs).toMatchObject({
      reason: 'wrong_organisation',
    });
  });
});

describe('accepted tokens', () => {
  it('a dev token for a known internal user reaches the route with its principal', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'dev_ok', accountIds: [ACCOUNT] }));
    const response = await get('/v1/probe/internal', await devToken({ sub: user.clerk_user_id! })).expect(200);
    expect(response.body).toEqual({
      userId: user.id,
      kind: 'internal',
      accounts: [ACCOUNT],
    });
    expect(sink.ofType('auth.signin.success')).toHaveLength(1);
  });

  it('writes auth.signin.success once per session, not per request', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'dev_twice' }));
    const token = await devToken({
      sub: user.clerk_user_id!,
      sid: 'sess_fixed',
    });
    await get('/v1/probe/internal', token).expect(200);
    await get('/v1/probe/internal', token).expect(200);
    expect(sink.ofType('auth.signin.success')).toHaveLength(1);
  });

  it('a Clerk RS256 token with the right party and organisation is accepted', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'user_clerk' }));
    await get('/v1/probe/internal', await clerkToken(keys, { sub: user.clerk_user_id! })).expect(200);
  });

  it('refuses to bind a pre-invited portal user through another account organisation', async () => {
    // Each account asserts its own emails through its own enterprise
    // connection. Account OTH must not be able to claim a contact of BRK
    // by asserting their email and taking over the account binding.
    const victim = principals.add(
      aUser({
        email: 'victim@brookfield.test',
        kind: 'portal',
        account_id: ACCOUNT,
        accountIds: [ACCOUNT],
        status: 'invited',
        permissions: ['portal:submit'],
      }),
    );
    const attacker = await clerkToken(keys, { sub: 'user_attacker', email: victim.email, org: 'acct-oth' });
    await get('/v1/portal/probe/mine', attacker).expect(401);
    expect(sink.ofType('auth.signin.failed')[0].attrs).toMatchObject({ reason: 'wrong_organisation' });
    // And the refusal left no binding behind for the attacker to reuse.
    expect(principals.users.get(victim.id)).toMatchObject({ clerk_user_id: null, status: 'invited' });
    // The account's own organisation still signs the contact in.
    const own = await clerkToken(keys, { sub: 'user_victim', email: victim.email, org: 'acct-brk' });
    const response = await get('/v1/portal/probe/mine', own).expect(200);
    expect(response.body).toEqual({ kind: 'portal', accounts: [ACCOUNT] });
    expect(principals.users.get(victim.id)).toMatchObject({ clerk_user_id: 'user_victim', status: 'active' });
  });

  it('binds a pre-invited user to the Clerk subject on first sign-in by email', async () => {
    const user = principals.add(aUser({ email: 'invited@example.test', status: 'invited' }));
    await get(
      '/v1/probe/internal',
      await clerkToken(keys, {
        sub: 'user_new',
        email: 'invited@example.test',
      }),
    ).expect(200);
    expect(principals.users.get(user.id)).toMatchObject({
      clerk_user_id: 'user_new',
      status: 'active',
    });
  });

  it('a harness session token maps to the user by email as a harness principal', async () => {
    const user = principals.add(aUser({ email: 'consultant@example.test' }));
    const response = await get('/v1/probe/me', await harnessToken({ sub: 'harness-1', email: user.email })).expect(200);
    expect(response.body.kind).toBe('harness');
  });

  it('a harness token bearing a portal user email stays in the portal realm', async () => {
    // The harness secret is symmetric and XMS mints with it as well, so a
    // token naming any email can be produced. The realm must follow the
    // user record, not the transport: otherwise a portal contact's email
    // yields an internal principal on the app role, and the portal role's
    // REVOKE on work notes, time entries and rate cards stops applying.
    const portal = principals.add(
      aUser({
        email: 'client@brookfield.test',
        kind: 'portal',
        account_id: ACCOUNT,
        accountIds: [ACCOUNT],
        permissions: ['portal:submit'],
      }),
    );
    const token = await harnessToken({ sub: 'harness-portal', email: portal.email });
    const refused = await get('/v1/probe/internal', token).expect(403);
    expect(refused.body.code).toBe('wrong_realm');
    expect(sink.ofType('authz.realm.denied')).toHaveLength(1);
    const allowed = await get('/v1/portal/probe/mine', token).expect(200);
    expect(allowed.body).toEqual({ kind: 'portal', accounts: [ACCOUNT] });
  });

  it('a harness token whose type is not session is rejected', async () => {
    const user = principals.add(aUser({ email: 'harness2@example.test' }));
    await get('/v1/probe/me', await harnessToken({ sub: 'h', email: user.email, type: 'refresh' })).expect(401);
  });

  it('expands permissions transitively for the principal', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'dev_perms', permissions: ['tickets:resolve'] }));
    const response = await get('/v1/probe/me', await devToken({ sub: user.clerk_user_id! })).expect(200);
    expect(response.body.permissions).toEqual(['tickets:create', 'tickets:resolve', 'tickets:view', 'tickets:work']);
  });
});

describe('authorisation', () => {
  it('a missing permission is 403 with one authz.permission.denied event naming the permission', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'dev_noadmin' }));
    const response = await get('/v1/probe/admin', await devToken({ sub: user.clerk_user_id! })).expect(403);
    expect(response.body).toMatchObject({
      code: 'forbidden',
      permission: 'admin:accounts',
    });
    const denied = sink.ofType('authz.permission.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      actorId: user.id,
      principalKind: 'internal',
      attrs: { permission: 'admin:accounts' },
    });
  });

  it('a portal token on an internal route is 403 with authz.realm.denied before any permission check', async () => {
    const portal = principals.add(
      aUser({
        clerk_user_id: 'user_portal',
        kind: 'portal',
        account_id: ACCOUNT,
        accountIds: [ACCOUNT],
        permissions: ['portal:submit', 'tickets:view'],
      }),
    );
    const response = await get(
      '/v1/probe/internal',
      await clerkToken(keys, { sub: portal.clerk_user_id!, org: 'acct-brk' }),
    ).expect(403);
    expect(response.body.code).toBe('wrong_realm');
    expect(sink.ofType('authz.realm.denied')).toHaveLength(1);
    expect(sink.ofType('authz.permission.denied')).toHaveLength(0);
  });

  it('an internal token on a portal route is 403', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'dev_internal2', permissions: ['portal:submit'] }));
    await get('/v1/portal/probe/mine', await devToken({ sub: user.clerk_user_id! })).expect(403);
    expect(sink.ofType('authz.realm.denied')).toHaveLength(1);
  });

  it('a portal token on a portal route is bound to exactly its account', async () => {
    const portal = principals.add(
      aUser({
        clerk_user_id: 'dev_portal_ok',
        kind: 'portal',
        account_id: OTHER,
        accountIds: [OTHER],
        permissions: ['portal:submit'],
      }),
    );
    const response = await get(
      '/v1/portal/probe/mine',
      await devToken({ sub: portal.clerk_user_id!, org: 'acct-oth' }),
    ).expect(200);
    expect(response.body).toEqual({ kind: 'portal', accounts: [OTHER] });
  });
});

describe('long-lived agents token', () => {
  it('is 401 on a route that is not an Axel route', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'user_agents' }));
    const token = await clerkToken(keys, {
      sub: user.clerk_user_id!,
      aud: AGENTS_AUDIENCE,
    });
    await get('/v1/probe/internal', token).expect(401);
    expect(sink.ofType('auth.token.rejected')[0].attrs).toMatchObject({
      reason: 'bad_audience',
    });
  });

  it('is accepted on an Axel route', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'user_agents2' }));
    const token = await clerkToken(keys, {
      sub: user.clerk_user_id!,
      aud: AGENTS_AUDIENCE,
    });
    const response = await get('/v1/probe/axel', token).expect(200);
    expect(response.body.tokenType).toBe('clerk_agents');
  });

  it('any other audience on a Clerk token is 401', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'user_aud' }));
    await get(
      '/v1/probe/internal',
      await clerkToken(keys, {
        sub: user.clerk_user_id!,
        aud: 'something-else',
      }),
    ).expect(401);
  });
});

describe('API clients', () => {
  it('a valid key acts as its service user with its scopes and grants', async () => {
    const service = principals.add(aUser({ kind: 'service', email: 'finance-bot@example.test' }));
    const key = await principals.addApiClient(service, ['tickets:view'], [ACCOUNT]);
    const response = await get('/v1/probe/internal', key).expect(200);
    expect(response.body).toEqual({
      userId: service.id,
      kind: 'api_client',
      accounts: [ACCOUNT],
    });
    expect(sink.ofType('auth.apikey.used')).toHaveLength(1);
  });

  it('a key outside its scopes is 403', async () => {
    const service = principals.add(aUser({ kind: 'service', email: 'bot2@example.test' }));
    const key = await principals.addApiClient(service, ['tickets:view'], []);
    await get('/v1/probe/admin', key).expect(403);
  });

  it('an unknown or revoked key is 401 with auth.apikey.rejected', async () => {
    await get('/v1/probe/internal', 'xms_live_deadbeefdeadbeef').expect(401);
    expect(sink.ofType('auth.apikey.rejected')[0].attrs).toMatchObject({
      reason: 'unknown',
    });
    const service = principals.add(aUser({ kind: 'service', email: 'bot3@example.test' }));
    const revoked = await principals.addApiClient(service, ['tickets:view'], [], 'revoked');
    await get('/v1/probe/internal', revoked).expect(401);
    expect(sink.ofType('auth.apikey.rejected')[1].attrs).toMatchObject({
      reason: 'revoked',
    });
  });

  it('a service user cannot sign in with a session token', async () => {
    const service = principals.add(aUser({ kind: 'service', clerk_user_id: 'dev_service' }));
    await get('/v1/probe/internal', await devToken({ sub: service.clerk_user_id! })).expect(401);
    expect(sink.ofType('auth.signin.failed')[0].attrs).toMatchObject({
      reason: 'service_user',
    });
  });
});

/**
 * Per-client rate limiting (Integrations technical 5). The interceptor runs
 * after the guard, so the counter keys on the resolved API client id and
 * the allowance is the one configured on that client, not a policy shared
 * by every integration.
 */
describe('API client rate limits', () => {
  it('counts per client, refuses past the client limit with the three headers and one event per burst', async () => {
    const service = principals.add(aUser({ kind: 'service', email: 'slow-bot@example.test' }));
    const key = await principals.addApiClient(service, ['tickets:view'], [ACCOUNT], 'active', 2);
    const first = await get('/v1/probe/internal', key).expect(200);
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    const second = await get('/v1/probe/internal', key).expect(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');

    const refused = await get('/v1/probe/internal', key).expect(429);
    expect(refused.body).toMatchObject({ code: 'rate_limited', policy: 'api_client' });
    expect(refused.headers['x-ratelimit-limit']).toBe('2');
    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await get('/v1/probe/internal', key).expect(429);

    const events = sink.ofType('abuse.rate_limited');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'denied',
      actorKind: 'api_client',
      actorId: service.id,
      principalKind: 'api_client',
      attrs: { policy: 'api_client', per_minute: 2, route: '/v1/probe/internal' },
    });
  });

  it('gives every client its own window and its own limit', async () => {
    const busy = principals.add(aUser({ kind: 'service', email: 'busy-bot@example.test' }));
    const quiet = principals.add(aUser({ kind: 'service', email: 'quiet-bot@example.test' }));
    const busyKey = await principals.addApiClient(busy, ['tickets:view'], [ACCOUNT], 'active', 1);
    const quietKey = await principals.addApiClient(quiet, ['tickets:view'], [ACCOUNT]);
    await get('/v1/probe/internal', busyKey).expect(200);
    await get('/v1/probe/internal', busyKey).expect(429);
    // The default from the client row, and a window of its own.
    const other = await get('/v1/probe/internal', quietKey).expect(200);
    expect(other.headers['x-ratelimit-limit']).toBe('600');
    expect(other.headers['x-ratelimit-remaining']).toBe('599');
  });

  it('leaves a session principal uncounted: the limit is a contract with an API client', async () => {
    const user = principals.add(aUser({ clerk_user_id: 'dev_unlimited', accountIds: [ACCOUNT] }));
    const token = await devToken({ sub: user.clerk_user_id!, sid: 'sess_unlimited' });
    for (let index = 0; index < 5; index += 1) {
      const response = await get('/v1/probe/internal', token).expect(200);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});
