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
import { PeriodJobs } from '../src/worker/period-jobs.js';
import { RosterJobs } from '../src/worker/roster-jobs.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The housekeeping jobs (functional 5.7 auto-lock; Capacity technical
 * section 3 certification expiry): an approved period locks itself once
 * its instant has passed, with the summary, audit row and outbox event a
 * finance user's lock would leave; a certification inside the sixty-day
 * window notifies the person and the capacity managers exactly once.
 */
const ADMIN_EMAIL = 'admin@example.test';
const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 8)}01`;
const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);

let app: INestApplication;
let worker: INestApplication;
let adminToken: string;
let accountId: string;
let periodId: string;
let personId: string;
let caraId: string;
let periods: PeriodJobs;
let roster: RosterJobs;

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
  const { WorkerModule } = await import('../src/worker/worker.module.js');
  const apiRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = apiRef.createNestApplication({ bufferLogs: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  const workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  worker = workerRef.createNestApplication({ bufferLogs: true });
  await worker.init();
  periods = worker.get(PeriodJobs);
  roster = worker.get(RosterJobs);

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
    .send({ name: 'Retainer', model: 'retainer', period_starts_on: monthStart, period_ends_on: monthEnd })
    .expect(201);
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
  caraId = user.body.id;
  const person = await api()
    .post('/v1/roster/people')
    .set(bearer(adminToken))
    .send({ display_name: 'Cara Lee', email: 'cara@example.test', role: 'consultant', user_id: caraId })
    .expect(201);
  personId = person.body.id;
  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: accountId, type: 'incident', short_description: 'Jobs', impact: 'high', urgency: 'high' })
    .expect(201);
  await api()
    .post(`/v1/tickets/${ticket.body.key}/transitions`)
    .set(bearer(adminToken))
    .send({ version: 1, to: 'in_progress' })
    .expect(201);
  await api()
    .post(`/v1/tickets/${ticket.body.key}/time`)
    .set(bearer(adminToken))
    .send({ performed_on: today, minutes: 60, activity_type: 'analysis' })
    .expect(201);
  const period = await api()
    .post(`/v1/accounts/${accountId}/billing-periods`)
    .set(bearer(adminToken))
    .send({ starts_on: monthStart, ends_on: monthEnd })
    .expect(201);
  periodId = period.body.id;
  const submitted = await api()
    .post(`/v1/accounts/${accountId}/billing-periods/${periodId}/submit`)
    .set(bearer(adminToken))
    .send({ version: period.body.version })
    .expect(201);
  await api()
    .post(`/v1/accounts/${accountId}/billing-periods/${periodId}/approve`)
    .set(bearer(adminToken))
    .send({ version: submitted.body.version })
    .expect(201);
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('billing auto-lock', () => {
  it('leaves an approved period alone until its instant, then locks it once with the summary and the outbox event', async () => {
    expect(await periods.lockDue()).toBe('locked 0');
    await withSuperuser((client) =>
      client.query(`update acct.billing_periods set auto_lock_at = now() - interval '1 minute' where id = $1`, [
        periodId,
      ]),
    );
    expect(await periods.lockDue()).toBe('locked 1');
    expect(await periods.lockDue()).toBe('locked 0');
    const listed = await api().get(`/v1/accounts/${accountId}/billing-periods`).set(bearer(adminToken)).expect(200);
    expect(listed.body[0]).toMatchObject({ status: 'locked', locked_by: 'system' });
    expect(listed.body[0].summary.minutes).toBe(60);
    const outbox = await withSuperuser((client) =>
      client.query(`select payload from sys.outbox where aggregate_id = $1 and event_type = 'billing_period.locked'`, [
        periodId,
      ]),
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload.auto).toBe(true);
    const audit = await withSuperuser((client) =>
      client.query(
        `select actor_name from acct.audit_events where entity_id = $1 and field = 'status' and new_value = '"locked"'::jsonb`,
        [periodId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    const exported = await api()
      .get(`/v1/accounts/${accountId}/billing-periods/${periodId}/export?format=csv`)
      .set(bearer(adminToken))
      .expect(200);
    expect(exported.headers['x-row-count']).toBe('1');
  });
});

describe('worker binding', () => {
  it('a sweep sees one account per transaction and never another account rows', async () => {
    const second = await api()
      .post('/v1/admin/accounts')
      .set(bearer(adminToken))
      .send({ key: 'AUS', name: 'Austral Mining' })
      .expect(201);
    const otherId: string = second.body.id;
    await api().post(`/v1/admin/accounts/${otherId}/activate`).set(bearer(adminToken)).expect(201);
    await api()
      .post(`/v1/accounts/${otherId}/contracts`)
      .set(bearer(adminToken))
      .send({ name: 'Retainer', model: 'retainer' })
      .expect(201);
    for (const id of [accountId, otherId]) {
      await api()
        .post('/v1/tickets')
        .set(bearer(adminToken))
        .send({ account_id: id, type: 'incident', short_description: `Ticket for ${id}` })
        .expect(201);
    }

    const uow = worker.get(UnitOfWork);
    const seen = await uow.perAccount([accountId, otherId], async (tx, bound) => {
      const setting = await tx.query<{ ids: string }>('select sys.account_ids()::text as ids');
      const tickets = await tx.query<{ account_id: string }>('select distinct account_id from acct.tickets');
      return { bound, setting: setting.rows[0].ids, accounts: tickets.rows.map((row) => row.account_id) };
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ bound: accountId, setting: `{${accountId}}`, accounts: [accountId] });
    expect(seen[1]).toMatchObject({ bound: otherId, setting: `{${otherId}}`, accounts: [otherId] });
  });
});

describe('certification expiry', () => {
  it('notifies the person and the capacity managers once for a certification inside the window', async () => {
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
    await api()
      .post(`/v1/roster/people/${personId}/certifications`)
      .set(bearer(adminToken))
      .send({ name: 'OneStream Certified', issuer: 'OneStream', obtained_on: '2025-01-01', expires_on: soon })
      .expect(201);
    await api()
      .post(`/v1/roster/people/${personId}/certifications`)
      .set(bearer(adminToken))
      .send({ name: 'PMP', obtained_on: '2025-01-01', expires_on: far })
      .expect(201);
    expect(await roster.notifyExpiring()).toBe('notified 1');
    expect(await roster.notifyExpiring()).toBe('notified 0');
    const notes = await withSuperuser((client) =>
      client.query(
        `select recipient_id, title from acct.notifications where type = 'roster.certification_expiring' order by recipient_id`,
      ),
    );
    expect(notes.rows.map((row) => row.recipient_id)).toContain(caraId);
    expect(notes.rows.length).toBeGreaterThanOrEqual(2);
    expect(notes.rows[0].title).toContain('OneStream Certified expires in');
    const rows = await withSuperuser((client) =>
      client.query(`select name, expiry_notified_at from op.certifications where person_id = $1 order by name`, [
        personId,
      ]),
    );
    expect(rows.rows.map((row) => `${row.name}:${row.expiry_notified_at === null ? 'pending' : 'done'}`)).toEqual([
      'OneStream Certified:done',
      'PMP:pending',
    ]);
  });
});
