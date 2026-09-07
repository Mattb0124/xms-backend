import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { closePools, resetDatabase, urls } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/** Saved views and inline conditions on the Queue (P2.11.1 done-when: a condition set round-trips). */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let accountId: string;

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
  await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer' })
    .expect(201);
  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({ email: 'cara@example.test', role_ids: [consultant.id], account_ids: [accountId] })
    .expect(201);
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  for (const [description, priority] of [
    ['P1 outage', ['high', 'high']],
    ['P3 question', ['medium', 'medium']],
    ['P4 nicety', ['low', 'low']],
  ] as const) {
    await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: description,
        impact: priority[0],
        urgency: priority[1],
      })
      .expect(201);
  }
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('conditions on the queue', () => {
  it('applies an inline condition set and rejects an invalid one', async () => {
    const conditions = encode({
      conditions: [
        { field: 'priority', op: 'in', value: ['p1', 'p3'] },
        { field: 'short_description', op: 'contains', value: 'P' },
      ],
    });
    const response = await api().get(`/v1/tickets?conditions=${conditions}`).set(bearer(adminToken)).expect(200);
    expect(response.body.items.map((item: { short_description: string }) => item.short_description).sort()).toEqual([
      'P1 outage',
      'P3 question',
    ]);
    const bad = await api()
      .get(`/v1/tickets?conditions=${encode({ conditions: [{ field: 'password', op: 'eq', value: 'x' }] })}`)
      .set(bearer(adminToken))
      .expect(400);
    expect(bad.body.code).toBe('invalid_conditions');
  });
});

describe('saved views', () => {
  let viewId: string;

  it('creates a private view that round-trips its definition and drives the queue', async () => {
    const definition = {
      conditions: { conditions: [{ field: 'priority', op: 'eq', value: 'p1' }], match: 'all' },
      sort: 'created_desc',
      columns: ['key', 'short_description'],
    };
    const created = await api()
      .post('/v1/views')
      .set(bearer(consultantToken))
      .send({ account_id: accountId, name: 'My P1s', definition })
      .expect(201);
    viewId = created.body.id;
    expect(created.body).toMatchObject({ name: 'My P1s', share: 'private', definition });
    const listed = await api().get(`/v1/tickets?view=${viewId}`).set(bearer(consultantToken)).expect(200);
    expect(listed.body.items.map((item: { short_description: string }) => item.short_description)).toEqual([
      'P1 outage',
    ]);
  });

  it('is invisible to another user until shared with the account', async () => {
    const before = await api().get('/v1/views').set(bearer(adminToken)).expect(200);
    expect(before.body).toEqual([]);
    await api().patch(`/v1/views/${viewId}`).set(bearer(adminToken)).send({ version: 1, share: 'account' }).expect(403);
    await api()
      .patch(`/v1/views/${viewId}`)
      .set(bearer(consultantToken))
      .send({ version: 1, share: 'account' })
      .expect(200);
    const after = await api().get('/v1/views').set(bearer(adminToken)).expect(200);
    expect(after.body.map((view: { name: string }) => view.name)).toEqual(['My P1s']);
  });

  it('rejects an invalid definition and soft-deletes on the owner request', async () => {
    const bad = await api()
      .post('/v1/views')
      .set(bearer(consultantToken))
      .send({
        account_id: accountId,
        name: 'Bad',
        definition: { conditions: { conditions: [{ field: 'state', op: 'before', value: 'x' }] } },
      })
      .expect(400);
    expect(bad.body.problems[0]).toContain('operator before not allowed on state');
    await api().delete(`/v1/views/${viewId}`).set(bearer(consultantToken)).expect(204);
    await api().get(`/v1/views/${viewId}`).set(bearer(consultantToken)).expect(404);
  });
});
