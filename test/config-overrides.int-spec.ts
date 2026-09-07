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
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Account configuration overrides (P2.9.2): an account overrides the SLA
 * policy, the ticket service resolves the override for that account and
 * the default elsewhere, removing it restores the default, every change is
 * audited on the account, and an invalid body is refused before anything
 * is written.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let otherAccountId: string;

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
  for (const [key, name] of [
    ['BRK', 'Brookfield'],
    ['AUS', 'Austral Mining'],
  ]) {
    const account = await api().post('/v1/admin/accounts').set(bearer(adminToken)).send({ key, name }).expect(201);
    await api().post(`/v1/admin/accounts/${account.body.id}/activate`).set(bearer(adminToken)).expect(201);
    await api()
      .post(`/v1/accounts/${account.body.id}/contracts`)
      .set(bearer(adminToken))
      .send({ name: 'Retainer', model: 'retainer' })
      .expect(201);
    if (key === 'BRK') accountId = account.body.id;
    else otherAccountId = account.body.id;
  }
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

function api() {
  return request(app.getHttpServer());
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function responseTarget(token: string, account: string): Promise<number> {
  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(token))
    .send({
      account_id: account,
      type: 'incident',
      short_description: 'Target check',
      impact: 'high',
      urgency: 'high',
      requester_email: 'pat@client.test',
    })
    .expect(201);
  return ticket.body.sla.response.targetMinutes;
}

describe('account configuration overrides', () => {
  it('reads the effective catalog as the default before any override', async () => {
    const view = await api().get(`/v1/accounts/${accountId}/config/sla_policy`).set(bearer(adminToken)).expect(200);
    expect(view.body.effective.source).toBe('default');
    expect(view.body.overrides).toEqual([]);
    expect(view.body.default.body.targets.incident.p1.response_minutes).toBe(30);
  });

  it('activates an override for one account only and audits it', async () => {
    const view = await api().get(`/v1/accounts/${accountId}/config/sla_policy`).set(bearer(adminToken)).expect(200);
    const body = JSON.parse(JSON.stringify(view.body.default.body));
    body.targets.incident.p1.response_minutes = 15;
    const set = await api()
      .put(`/v1/accounts/${accountId}/config/sla_policy/override`)
      .set(bearer(adminToken))
      .send({ body })
      .expect(200);
    expect(set.body).toMatchObject({ version: 1, status: 'active', account_id: accountId });
    expect(await responseTarget(adminToken, accountId)).toBe(15);
    expect(await responseTarget(adminToken, otherAccountId)).toBe(30);
    const after = await api().get(`/v1/accounts/${accountId}/config/sla_policy`).set(bearer(adminToken)).expect(200);
    expect(after.body.effective.source).toBe('override');
    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type, entity_kind from acct.audit_events where account_id = $1 and entity_kind = 'config.sla_policy' order by created_at`,
        [accountId],
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(['admin.config.activated']);
    const security = await withSuperuser((client) =>
      client.query(
        `select attrs from sys.security_events where event_type = 'admin.config.changed' and account_id = $1`,
        [accountId],
      ),
    );
    expect(security.rows[0].attrs).toMatchObject({ scope: 'override', version: 1 });
  });

  it('refuses an invalid body before writing, and a second override retires the first', async () => {
    const bad = await api()
      .put(`/v1/accounts/${accountId}/config/state_machine/override?scope=incident`)
      .set(bearer(adminToken))
      .send({ body: { states: [] } })
      .expect(400);
    expect(bad.body.code).toBe('invalid_config');
    const view = await api().get(`/v1/accounts/${accountId}/config/sla_policy`).set(bearer(adminToken)).expect(200);
    const body = JSON.parse(JSON.stringify(view.body.effective.body));
    body.targets.incident.p1.response_minutes = 10;
    await api()
      .put(`/v1/accounts/${accountId}/config/sla_policy/override`)
      .set(bearer(adminToken))
      .send({ body })
      .expect(200);
    const versions = await api().get(`/v1/accounts/${accountId}/config/sla_policy`).set(bearer(adminToken)).expect(200);
    expect(
      versions.body.overrides.map((row: { version: number; status: string }) => `${row.version}:${row.status}`),
    ).toEqual(['2:active', '1:retired']);
    expect(await responseTarget(adminToken, accountId)).toBe(10);
  });

  it('removing the override restores the default and is audited; a second removal is a 404', async () => {
    await api().delete(`/v1/accounts/${accountId}/config/sla_policy/override`).set(bearer(adminToken)).expect(200);
    expect(await responseTarget(adminToken, accountId)).toBe(30);
    await api().delete(`/v1/accounts/${accountId}/config/sla_policy/override`).set(bearer(adminToken)).expect(404);
    const audit = await withSuperuser((client) =>
      client.query(
        `select count(*)::int as n from acct.audit_events where account_id = $1 and event_type = 'admin.config.override_removed'`,
        [accountId],
      ),
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('needs admin:config', async () => {
    const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
    const consultant = roles.body.find((row: { name: string }) => row.name === 'Consultant');
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'consultant@example.test',
        first_name: 'Chris',
        last_name: 'Consultant',
        role_ids: [consultant.id],
        account_ids: [accountId],
      })
      .expect(201);
    const token = await devToken({ sub: 'dev_consultant', email: 'consultant@example.test' });
    await api().get(`/v1/accounts/${accountId}/config/sla_policy`).set(bearer(token)).expect(403);
  });
});
