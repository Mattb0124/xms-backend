import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The local development sign-in (AIBL-331). It mints an authentication token
 * for a named user with no credential, so what is worth testing is mostly the
 * refusals: without the dev secret it is not there at all, and the token it
 * does hand out has to be one the guard actually accepts, including the
 * portal org claim the caller never supplies.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let accountId: string;

const api = (): request.Agent => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function build(devSecret: string | undefined): Promise<INestApplication> {
  const db = urls();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PORTAL: db.portal,
    DATABASE_URL_WORKER: db.worker,
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
  });
  if (devSecret) process.env.AUTH_DEV_SECRET = devSecret;
  else delete process.env.AUTH_DEV_SECRET;
  resetEnvForTests();
  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const built = moduleRef.createNestApplication({ bufferLogs: true });
  built.use(requestContextMiddleware);
  built.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  built.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  built.useGlobalFilters(new HttpExceptionFilter());
  await built.init();
  return built;
}

beforeAll(async () => {
  await resetDatabase();
  app = await build(DEV_SECRET);
  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  accountId = account.body.id;
  await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);
  const portalRoles = await api().get('/v1/admin/roles?catalog=portal').set(bearer(adminToken)).expect(200);
  const requester = portalRoles.body.find((role: { name: string }) => role.name === 'Requester');
  await api()
    .post(`/v1/admin/accounts/${accountId}/portal-users`)
    .set(bearer(adminToken))
    .send({ email: 'pat@client.test', first_name: 'Pat', last_name: 'Client', role_ids: [requester.id] })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

describe('the development sign-in', () => {
  it('offers the seeded users with what signing in as them gets you, and no token', async () => {
    const response = await api().get('/v1/dev/users').expect(200);
    const admin = response.body.find((user: { email: string }) => user.email === ADMIN_EMAIL);
    expect(admin).toMatchObject({ kind: 'internal', account_key: null, roles: ['Administrator'] });
    const pat = response.body.find((user: { email: string }) => user.email === 'pat@client.test');
    expect(pat).toMatchObject({ kind: 'portal', account_key: 'BRK', display_name: 'Pat Client' });
    // The list is a directory, not a handful of credentials.
    expect(JSON.stringify(response.body)).not.toContain('eyJ');
  });

  it('signs in an internal user with a token the guard accepts', async () => {
    const minted = await api().post('/v1/dev/sign-in').send({ email: ADMIN_EMAIL }).expect(201);
    const me = await api().get('/v1/admin/me').set(bearer(minted.body.token)).expect(200);
    expect(me.body.principal).toMatchObject({ kind: 'internal', email: ADMIN_EMAIL });
  });

  it('derives the portal org claim itself, which the caller never supplies', async () => {
    // A portal token is refused unless its org names that user's own account,
    // so getting this wrong is the difference between working and a 401 the
    // caller cannot diagnose.
    const minted = await api().post('/v1/dev/sign-in').send({ email: 'pat@client.test' }).expect(201);
    const me = await api().get('/v1/portal/me').set(bearer(minted.body.token)).expect(200);
    const principal = me.body.principal ?? me.body;
    expect(principal.kind).toBe('portal');
  });

  it('records a sign-in as a security event, the same as any other', async () => {
    await api().post('/v1/dev/sign-in').send({ email: ADMIN_EMAIL }).expect(201);
    const events = await withSuperuser((client) =>
      client.query<{ attrs: { devSignIn?: boolean } }>(
        `select attrs from sys.security_events
          where event_type = 'auth.signin.success' and attrs->>'devSignIn' = 'true'`,
      ),
    );
    expect(events.rows.length).toBeGreaterThan(0);
  });

  it('refuses an email nobody seeded, and a malformed one', async () => {
    const unknown = await api().post('/v1/dev/sign-in').send({ email: 'nobody@example.test' }).expect(400);
    expect(unknown.body.code).toBe('unknown_user');
    await api().post('/v1/dev/sign-in').send({ email: 'not-an-email' }).expect(400);
    await api().post('/v1/dev/sign-in').send({}).expect(400);
  });

  it('is not there at all without the dev secret', async () => {
    // The guard that matters. An environment which has not opted in must not
    // serve a route that hands out authentication.
    const without = await build(undefined);
    try {
      await request(without.getHttpServer()).get('/v1/dev/users').expect(404);
      await request(without.getHttpServer()).post('/v1/dev/sign-in').send({ email: ADMIN_EMAIL }).expect(404);
    } finally {
      await without.close();
      // Put the secret back for anything that runs after this file.
      process.env.AUTH_DEV_SECRET = DEV_SECRET;
      resetEnvForTests();
    }
  });
});
