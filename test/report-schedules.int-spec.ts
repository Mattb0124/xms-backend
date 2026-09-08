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
import { SchedulesService } from '../src/modules/reporting/schedules.module.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Report schedules and distribution (DR-05): a schedule per account with
 * its next run in the account's zone, an off-cycle run now that builds the
 * pack and delivers it (a notification for an internal recipient, an email
 * from the account's sender identity for a contact, a skip with its reason
 * otherwise), the run history with the outcome, and the worker runner
 * that claims due schedules and advances them.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let worker: INestApplication;
let adminToken: string;
let adminId: string;
let accountId: string;
let scheduleId: string;
let scheduleVersion: number;
let schedules: SchedulesService;

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
  schedules = worker.get(SchedulesService);

  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  adminId = (
    await withSuperuser((client) =>
      client.query<{ id: string }>('select id from op.users where email = $1', [ADMIN_EMAIL]),
    )
  ).rows[0].id;
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
  await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: accountId, type: 'incident', short_description: 'Weekly report material' })
    .expect(201);
});

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('report schedules (DR-05)', () => {
  it('creates a weekly schedule with its next run and refuses a weekday beyond seven', async () => {
    const bad = await api()
      .post('/v1/reporting/schedules')
      .set(bearer(adminToken))
      .send({ account_id: accountId, name: 'Weekly', cadence: 'weekly', run_day: 9 })
      .expect(400);
    expect(bad.body.code).toBe('run_day_weekly');
    const created = await api()
      .post('/v1/reporting/schedules')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        name: 'Weekly status report',
        cadence: 'weekly',
        run_day: 1,
        run_time: '06:00',
        distribution: [
          { kind: 'internal', id: adminId },
          { kind: 'contact', email: 'pat@client.test', name: 'Pat' },
          { kind: 'portal_user', name: 'No address' },
        ],
      })
      .expect(201);
    scheduleId = created.body.id;
    scheduleVersion = created.body.version;
    // Every route speaks the HH:MM the PATCH accepts, create and list included.
    expect(created.body).toMatchObject({ period_kind: 'previous_week', enabled: true, run_time: '06:00' });
    expect(new Date(created.body.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(created.body.next_run_at).getUTCDay()).toBe(1);
    const listed = await api().get(`/v1/reporting/schedules?account=${accountId}`).set(bearer(adminToken)).expect(200);
    expect(listed.body.map((row: { id: string }) => row.id)).toEqual([scheduleId]);
    expect(listed.body[0].run_time).toBe('06:00');
  });

  it('run now builds the pack and delivers it: a notification, a skip without a sender, then an email once the identity exists', async () => {
    const first = await api()
      .post(`/v1/reporting/schedules/${scheduleId}/run-now`)
      .set(bearer(adminToken))
      .send({})
      .expect(201);
    expect(first.body.status).toBe('sent');
    // An internal recipient is named, so the run detail reads as a person.
    expect(first.body.delivery).toEqual([
      { kind: 'internal', to: adminId, name: 'Administrator', outcome: 'notified' },
      { kind: 'contact', to: 'pat@client.test', outcome: 'skipped', reason: 'no_sender_identity' },
      { kind: 'portal_user', to: '', outcome: 'skipped', reason: 'no_email' },
    ]);
    const notes = await withSuperuser((client) =>
      client.query(`select link from acct.notifications where type = 'report.pack.ready' and recipient_id = $1`, [
        adminId,
      ]),
    );
    expect(notes.rows[0].link).toBe(`/reports/packs/${first.body.pack_id}`);
    await withSuperuser((client) =>
      client.query(
        `insert into acct.sender_identities (account_id, address, display_name, is_default) values ($1, 'brk@xms.test', 'BRK support', true)`,
        [accountId],
      ),
    );
    const second = await api()
      .post(`/v1/reporting/schedules/${scheduleId}/run-now`)
      .set(bearer(adminToken))
      .send({ period_start: '2026-08-24', period_end: '2026-08-30' })
      .expect(201);
    expect(second.body.period).toEqual({ start: '2026-08-24', end: '2026-08-30' });
    expect(second.body.delivery[1]).toEqual({
      kind: 'contact',
      to: 'pat@client.test',
      name: 'Pat',
      outcome: 'emailed',
    });
    const runs = await api()
      .get(`/v1/reporting/runs?account=${accountId}&schedule=${scheduleId}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(runs.body).toHaveLength(2);
    expect(
      runs.body.every(
        (row: { status: string; delivery: unknown[] }) => row.status === 'sent' && row.delivery.length === 3,
      ),
    ).toBe(true);
    const schedule = await withSuperuser((client) =>
      client.query('select last_run_id from acct.report_schedules where id = $1', [scheduleId]),
    );
    expect(schedule.rows[0].last_run_id).toBe(second.body.run_id);
    const bad = await api()
      .post(`/v1/reporting/schedules/${scheduleId}/run-now`)
      .set(bearer(adminToken))
      .send({ period_start: '2026-08-30', period_end: '2026-08-24' })
      .expect(400);
    expect(bad.body.code).toBe('invalid_range');
  });

  it('the worker claims a due schedule, runs it once and advances the next run', async () => {
    expect(await schedules.runDue()).toBe('ran 0');
    await withSuperuser((client) =>
      client.query(`update acct.report_schedules set next_run_at = now() - interval '1 minute' where id = $1`, [
        scheduleId,
      ]),
    );
    expect(await schedules.runDue()).toBe('ran 1');
    expect(await schedules.runDue()).toBe('ran 0');
    const row = await withSuperuser((client) =>
      client.query('select next_run_at, last_run_id from acct.report_schedules where id = $1', [scheduleId]),
    );
    expect(new Date(row.rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now());
    const runs = await withSuperuser((client) =>
      client.query(`select requested_by, status from acct.report_runs where schedule_id = $1 order by created_at`, [
        scheduleId,
      ]),
    );
    expect(runs.rows).toHaveLength(3);
    expect(runs.rows[2]).toEqual({ requested_by: 'system', status: 'sent' });
  });

  it('patch changes the cadence with the version and disabling clears the next run', async () => {
    const stale = await api()
      .patch(`/v1/reporting/schedules/${scheduleId}`)
      .set(bearer(adminToken))
      .send({ version: scheduleVersion - 1 || 99, cadence: 'monthly', run_day: 1 })
      .expect(409);
    expect(stale.body.code).toBe('stale_version');
    const current = (
      await api().get(`/v1/reporting/schedules?account=${accountId}`).set(bearer(adminToken)).expect(200)
    ).body[0];
    const monthly = await api()
      .patch(`/v1/reporting/schedules/${scheduleId}`)
      .set(bearer(adminToken))
      .send({ version: current.version, cadence: 'monthly', run_day: 1 })
      .expect(200);
    expect(monthly.body).toMatchObject({ cadence: 'monthly', period_kind: 'previous_month' });
    expect(new Date(monthly.body.next_run_at).getUTCDate()).toBe(1);
    const disabled = await api()
      .patch(`/v1/reporting/schedules/${scheduleId}`)
      .set(bearer(adminToken))
      .send({ version: monthly.body.version, enabled: false })
      .expect(200);
    expect(disabled.body).toMatchObject({ enabled: false, next_run_at: null });
    await api().get('/v1/reporting/schedules').expect(401);
  });
});
