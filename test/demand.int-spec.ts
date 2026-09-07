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
 * Forward demand over the real database (CAP-08): pipeline and project
 * demand entered per account or prospect and month, the weighted totals,
 * the spreadsheet import that refuses a file with any problem and needs
 * granted accounts, removal, and the overlay on the capacity view.
 */
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
    STORAGE_KIND: 'local',
    STORAGE_LOCAL_ROOT: mkdtempSync(join(tmpdir(), 'xms-store-')),
    MAIL_TRANSPORT: 'file',
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
  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'cara@example.test',
      first_name: 'Cara',
      last_name: 'Lee',
      role_ids: [consultant.id],
      account_ids: [accountId],
    })
    .expect(201);
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('forward demand (CAP-08)', () => {
  it('records pipeline and project demand and weights the totals', async () => {
    const pipeline = await api()
      .post('/v1/demand')
      .set(bearer(adminToken))
      .send({ source: 'pipeline', prospect_name: 'Acme Corp', month: '2026-12', hours: 200, probability: 0.5 })
      .expect(201);
    expect(pipeline.body).toMatchObject({
      source: 'pipeline',
      prospect_name: 'Acme Corp',
      account_id: null,
      period_month: '2026-12-01',
      hours: 200,
      probability: 0.5,
    });
    const project = await api()
      .post('/v1/demand')
      .set(bearer(adminToken))
      .send({ source: 'project', account_id: accountId, month: '2026-12-01', hours: 40, probability: 0.1 })
      .expect(201);
    expect(project.body).toMatchObject({ source: 'project', account_id: accountId, probability: 1 });
    const missing = await api()
      .post('/v1/demand')
      .set(bearer(adminToken))
      .send({ source: 'pipeline', month: '2026-12', hours: 1 })
      .expect(400);
    expect(missing.body.code).toBe('subject_required');
    await api()
      .post('/v1/demand')
      .set(bearer(consultantToken))
      .send({ source: 'pipeline', prospect_name: 'X', month: '2026-12', hours: 1 })
      .expect(403);
    const listed = await api().get('/v1/demand?from=2026-12&to=2026-12').set(bearer(adminToken)).expect(200);
    expect(listed.body.rows).toHaveLength(2);
    expect(listed.body.totals).toEqual({ pipeline_minutes_weighted: 6000, project_minutes: 2400, total_minutes: 8400 });
    const view = await api().get('/v1/capacity?month=2026-12').set(bearer(adminToken)).expect(200);
    expect(view.body.demand).toMatchObject({ pipeline_minutes_weighted: 6000, project_minutes: 2400 });
    expect(
      view.body.demand.by_subject.map(
        (row: { prospect_name: string | null; account_key: string | null }) => row.prospect_name ?? row.account_key,
      ),
    ).toEqual(['BRK', 'Acme Corp']);
    await api().delete(`/v1/demand/${project.body.id}`).set(bearer(adminToken)).expect(200);
    await api().delete(`/v1/demand/${project.body.id}`).set(bearer(adminToken)).expect(404);
  });

  it('imports the template only when every line is clean and every account is granted', async () => {
    const bad = await api()
      .post('/v1/demand/import')
      .set(bearer(adminToken))
      .send({ content: 'source,month,hours\npipeline,2026-13,10\n' })
      .expect(400);
    expect(bad.body.code).toBe('invalid_import');
    expect(bad.body.problems.map((row: { line: number }) => row.line)).toEqual([2, 2]);
    const unknown = await api()
      .post('/v1/demand/import')
      .set(bearer(adminToken))
      .send({ content: 'source,account,month,hours\nproject,zzz,2027-01,10\n' })
      .expect(400);
    expect(unknown.body).toMatchObject({ code: 'unknown_account', keys: ['ZZZ'] });
    const ok = await api()
      .post('/v1/demand/import')
      .set(bearer(adminToken))
      .send({
        content: [
          'source,account,prospect,month,hours,probability,role',
          'project,brk,,2027-01,40,,',
          'pipeline,,Globex,2027-01,100,25%,architect',
        ].join('\n'),
      })
      .expect(201);
    expect(ok.body.imported).toBe(2);
    expect(
      ok.body.rows.map((row: { source: string; probability: number }) => `${row.source}:${row.probability}`),
    ).toEqual(['project:1', 'pipeline:0.25']);
    const listed = await api().get('/v1/demand?from=2027-01&to=2027-01').set(bearer(adminToken)).expect(200);
    expect(listed.body.totals).toEqual({ pipeline_minutes_weighted: 1500, project_minutes: 2400, total_minutes: 3900 });
  });
});
