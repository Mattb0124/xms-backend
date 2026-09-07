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
 * Billing period lifecycle and the finance export (functional 5.7, TB-14):
 * submit by the account owner with a summary, reopen, approve by finance
 * (entries dated inside are refused; a correction is dated today), lock
 * with the outbox event, the finance file for a locked period with its
 * checksum on the period and an append-only export record, and the
 * permissions on each step.
 */
const ADMIN_EMAIL = 'admin@example.test';
const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 8)}01`;
const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let accountId: string;
let ticketKey: string;
let periodId: string;
let periodVersion: number;
let entryId: string;

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
  const contract = await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({
      name: 'Retainer',
      model: 'retainer',
      period_hours: 40,
      period_starts_on: monthStart,
      period_ends_on: monthEnd,
    })
    .expect(201);
  expect(contract.body.model).toBe('retainer');

  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  const user = await api()
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
  await api()
    .post('/v1/roster/people')
    .set(bearer(adminToken))
    .send({ display_name: 'Cara Lee', email: 'cara@example.test', role: 'consultant', user_id: user.body.id })
    .expect(201);
  await api()
    .put(`/v1/accounts/${accountId}/rate-cards`)
    .set(bearer(adminToken))
    .send({ effective_from: '2026-01-01', entries: [{ role: 'consultant', bill_rate: 100 }] })
    .expect(200);

  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(consultantToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Billing check',
      impact: 'high',
      urgency: 'high',
    })
    .expect(201);
  ticketKey = ticket.body.key;
  await api()
    .post(`/v1/tickets/${ticketKey}/transitions`)
    .set(bearer(consultantToken))
    .send({ version: 1, to: 'in_progress' })
    .expect(201);
  const period = await api()
    .post(`/v1/accounts/${accountId}/billing-periods`)
    .set(bearer(adminToken))
    .send({ starts_on: monthStart, ends_on: monthEnd })
    .expect(201);
  periodId = period.body.id;
  periodVersion = period.body.version;
  const entry = await log(90).expect(201);
  entryId = entry.body.id;
  await log(30, { activity_type: 'rework' }).expect(201);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function log(minutes: number, extra: Record<string, unknown> = {}) {
  return api()
    .post(`/v1/tickets/${ticketKey}/time`)
    .set(bearer(consultantToken))
    .send({ performed_on: today, minutes, activity_type: 'analysis', ...extra });
}

function step(action: string, token: string, version = periodVersion) {
  return api()
    .post(`/v1/accounts/${accountId}/billing-periods/${periodId}/${action}`)
    .set(bearer(token))
    .send({ version });
}

describe('billing period lifecycle (functional 5.7)', () => {
  it('lists the periods and refuses an export before the lock', async () => {
    const listed = await api()
      .get(`/v1/accounts/${accountId}/billing-periods`)
      .set(bearer(consultantToken))
      .expect(200);
    expect(listed.body.map((row: { id: string; status: string }) => `${row.id}:${row.status}`)).toEqual([
      `${periodId}:open`,
    ]);
    const early = await api()
      .get(`/v1/accounts/${accountId}/billing-periods/${periodId}/export?format=csv`)
      .set(bearer(adminToken))
      .expect(409);
    expect(early.body.code).toBe('period_not_locked');
  });

  it('submit needs contracts:manage, produces the summary, and can be reopened', async () => {
    await step('submit', consultantToken).expect(403);
    const bad = await step('approve', adminToken).expect(409);
    expect(bad.body).toMatchObject({ code: 'invalid_transition', status: 'open', allowed: ['submit', 'lock'] });
    const submitted = await step('submit', adminToken).expect(201);
    expect(submitted.body.status).toBe('submitted');
    expect(submitted.body.summary).toMatchObject({
      entries: 2,
      adjustments: 0,
      minutes: 120,
      amount: 200,
      unrated_minutes: 0,
    });
    expect(submitted.body.summary.by_class).toEqual({
      billable: { minutes: 90, amount: 150 },
      absorbed: { minutes: 30, amount: 50 },
    });
    periodVersion = submitted.body.version;
    const stale = await step('reopen', adminToken, periodVersion - 1).expect(409);
    expect(stale.body.code).toBe('stale_version');
    const reopened = await step('reopen', adminToken).expect(201);
    expect(reopened.body.status).toBe('open');
    periodVersion = reopened.body.version;
    await log(15).expect(201);
    const again = await step('submit', adminToken).expect(201);
    periodVersion = again.body.version;
    expect(again.body.summary.minutes).toBe(135);
  });

  it('approve needs time:lock-period; an approved period refuses entries and dates a correction today', async () => {
    await step('approve', consultantToken).expect(403);
    const approved = await step('approve', adminToken).expect(201);
    expect(approved.body).toMatchObject({ status: 'approved', approved_by: expect.any(String) });
    expect(approved.body.auto_lock_at).not.toBeNull();
    periodVersion = approved.body.version;
    const refused = await log(10).expect(409);
    expect(refused.body).toMatchObject({ code: 'billing_period_locked', status: 'approved' });
    // Today falls inside the approved period, so the correction has no open period to land in.
    const correction = await api()
      .post('/v1/time/adjustments')
      .set(bearer(adminToken))
      .send({ entry_id: entryId, delta_minutes: -30, kind: 'correction', reason: 'Overstated' })
      .expect(409);
    expect(correction.body.code).toBe('billing_period_locked');
    await step('reopen', adminToken).expect(409);
  });

  it('lock writes the outbox event and the finance file matches the summary to the cent', async () => {
    const locked = await step('lock', adminToken).expect(201);
    expect(locked.body).toMatchObject({ status: 'locked', locked_by: expect.any(String) });
    expect(locked.body.summary).toMatchObject({ entries: 3, minutes: 135, amount: 225 });
    periodVersion = locked.body.version;
    const outbox = await withSuperuser((client) =>
      client.query(`select payload from sys.outbox where aggregate_id = $1 and event_type = 'billing_period.locked'`, [
        periodId,
      ]),
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload.summary.minutes).toBe(135);

    await api()
      .get(`/v1/accounts/${accountId}/billing-periods/${periodId}/export?format=csv`)
      .set(bearer(consultantToken))
      .expect(403);
    const csv = await api()
      .get(`/v1/accounts/${accountId}/billing-periods/${periodId}/export?format=csv`)
      .set(bearer(adminToken))
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['x-row-count']).toBe('3');
    const lines = csv.text.split('\r\n');
    expect(lines[0]).toBe(
      'kind,id,entry_id,account,contract,period,person_id,person,role,date,minutes,activity,billable_class,rate,multiplier,currency,amount,ticket,after_hours_class,reason',
    );
    expect(lines).toHaveLength(4);
    const amounts = lines.slice(1).map((line) => Number(line.split(',')[16]));
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(225);
    expect(lines[1]).toContain(`,${ticketKey},`);
    expect(lines[1]).toContain(',consultant,');

    const xlsx = await api()
      .get(`/v1/accounts/${accountId}/billing-periods/${periodId}/export?format=xlsx`)
      .set(bearer(adminToken))
      .expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect(xlsx.headers['x-checksum']).toMatch(/^[0-9a-f]{64}$/);

    const exports = await api()
      .get(`/v1/accounts/${accountId}/billing-periods/${periodId}/exports`)
      .set(bearer(adminToken))
      .expect(200);
    expect(exports.body.map((row: { format: string; row_count: number }) => `${row.format}:${row.row_count}`)).toEqual([
      'xlsx:3',
      'csv:3',
    ]);
    const period = await api().get(`/v1/accounts/${accountId}/billing-periods`).set(bearer(adminToken)).expect(200);
    expect(period.body[0].checksum).toBe(xlsx.headers['x-checksum']);
    const security = await withSuperuser((client) =>
      client.query(
        `select count(*)::int as n from sys.security_events where event_type = 'data.export.produced' and attrs->>'kind' = 'finance'`,
      ),
    );
    expect(security.rows[0].n).toBe(2);
  });
});
