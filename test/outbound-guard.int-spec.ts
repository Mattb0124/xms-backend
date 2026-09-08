import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { closePools, resetDatabase, urls } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The outbound destination guard as the API applies it (security review
 * findings 4, 5 and 18). Unlike the webhook and connector suites this one
 * leaves WEBHOOK_ALLOW_PRIVATE at its default, so the production refusals
 * are the behaviour under test: no plain HTTP, no private or link-local
 * destination, no host that is neither a registered name nor a literal,
 * and a ServiceNow table name that is an identifier rather than a path.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let apiKey: string;

beforeAll(async () => {
  await resetDatabase();
  const db = urls();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PORTAL: db.portal,
    DATABASE_URL_WORKER: db.worker,
    AUTH_DEV_SECRET: DEV_SECRET,
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
    STORAGE_KIND: 'local',
    STORAGE_LOCAL_ROOT: mkdtempSync(join(tmpdir(), 'xms-store-')),
    MAIL_TRANSPORT: 'file',
    WEBHOOK_SECRETS_KEY: 'dGVzdC1zZWFsaW5nLWtleS1mb3Itd2ViaG9va3MtMzJieXQ=',
    WEBHOOK_ALLOW_PRIVATE: 'false',
  });
  resetEnvForTests();
  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  accountId = account.body.id;
  await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);
  const client = await api()
    .post('/v1/admin/api-clients')
    .set(bearer(adminToken))
    .send({ name: 'Integrator', scopes: ['tickets:view', 'webhooks:manage'], account_ids: [accountId] })
    .expect(201);
  apiKey = client.body.key;
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('webhook destinations', () => {
  const register = (endpoint_url: string) =>
    api()
      .post('/v1/webhooks')
      .set(bearer(apiKey))
      .send({ account_id: accountId, endpoint_url, event_types: ['ticket.created'] });

  it('refuses plain HTTP, private and link-local destinations, and hosts that are not names or literals', async () => {
    expect((await register('http://hooks.example.com/x').expect(400)).body).toMatchObject({ problem: 'not_https' });
    for (const url of [
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[fe80::1]/x',
      'https://[febf::1]/x',
      // Every numeric spelling of loopback normalises to 127.0.0.1.
      'https://2130706433/x',
      'https://0x7f000001/x',
      'https://127.1/x',
      'https://localhost/x',
      'https://redis.internal/x',
    ]) {
      expect((await register(url).expect(400)).body).toMatchObject({
        code: 'invalid_endpoint',
        problem: 'private_host',
      });
    }
    // A bare label would be completed by the resolver's search domain.
    expect((await register('https://intranet/x').expect(400)).body).toMatchObject({ problem: 'invalid_host' });
    expect((await register('https://user:pw@hooks.example.com/x').expect(400)).body).toMatchObject({
      problem: 'invalid_url',
    });
    // And the shape that is meant to work still does.
    await register('https://hooks.example.com/xms').expect(201);
  });
});

describe('connector destinations', () => {
  const create = (body: Record<string, unknown>) =>
    api()
      .post(`/v1/accounts/${accountId}/connectors/servicenow`)
      .set(bearer(adminToken))
      .send({
        name: 'Attempt',
        auth_kind: 'basic',
        credential: { username: 'x', password: 'y' },
        ...body,
      });

  it('holds a connector base URL to the same guard as a webhook endpoint', async () => {
    for (const [base_url, problem] of [
      ['http://127.0.0.1:9200', 'not_https'],
      ['http://localhost:6379', 'not_https'],
      ['https://169.254.169.254', 'private_host'],
      ['https://intranet', 'invalid_host'],
      ['not a url', 'invalid_url'],
    ] as const) {
      const response = await create({ base_url }).expect(400);
      expect(response.body).toMatchObject({ code: 'invalid_endpoint', problem });
    }
  });

  it('takes a ServiceNow table name as an identifier, never as a path or a query', async () => {
    for (const table_name of [
      'incident/../../../api/now/attachment',
      'incident?sysparm_fields=sys_id',
      'Incident',
      '../secrets',
      '',
    ]) {
      const response = await create({ base_url: 'https://acme.service-now.com', table_name }).expect(400);
      expect(response.body.code).toBe('validation_failed');
    }
    await create({ base_url: 'https://acme.service-now.com', table_name: 'sn_customerservice_case' }).expect(201);
  });
});
