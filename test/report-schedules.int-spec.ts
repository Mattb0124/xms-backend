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
 *
 * Review before send (functional 5.8): a schedule with the flag holds its
 * run instead of delivering it, the reviewers are notified, approve sends
 * exactly what was held, cancel records the reason, and the deadline moves
 * an unreviewed run to `awaiting_review` without ever sending it.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let worker: INestApplication;
let adminToken: string;
let adminId: string;
let accountId: string;
let scheduleId: string;
let scheduleVersion: number;
let ownerId: string;
let consultantToken: string;
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
  // An account owner holds reports:manage on this account and so reviews its
  // packs; a consultant holds none of it and so cannot approve one.
  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const roleId = (name: string) => roles.body.find((role: { name: string }) => role.name === name).id;
  const owner = await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'owen@example.test',
      first_name: 'Owen',
      last_name: 'Reed',
      role_ids: [roleId('Account Owner')],
      account_ids: [accountId],
    })
    .expect(201);
  ownerId = owner.body.id;
  // A reviewer is an active user: the owner signs in once, which binds the
  // invited row to the subject and activates it.
  const ownerToken = await devToken({ sub: 'dev_owen', email: 'owen@example.test', sid: 'sess_owen' });
  await api().get('/v1/reporting/schedules').set(bearer(ownerToken)).expect(200);
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'cara@example.test',
      first_name: 'Cara',
      last_name: 'Lee',
      role_ids: [roleId('Consultant')],
      account_ids: [accountId],
    })
    .expect(201);
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
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

describe('review before send (DR-05, functional 5.8)', () => {
  /** Turns review on and takes an off-cycle run, which is then held rather than delivered. */
  async function hold(period: { period_start: string; period_end: string }, graceHours = 24) {
    const current = (
      await api().get(`/v1/reporting/schedules?account=${accountId}`).set(bearer(adminToken)).expect(200)
    ).body[0];
    await api()
      .patch(`/v1/reporting/schedules/${scheduleId}`)
      .set(bearer(adminToken))
      .send({ version: current.version, review_required: true, review_grace_hours: graceHours })
      .expect(200);
    const run = await api()
      .post(`/v1/reporting/schedules/${scheduleId}/run-now`)
      .set(bearer(adminToken))
      .send(period)
      .expect(201);
    expect(run.body.status).toBe('ready_for_review');
    expect(run.body.delivery).toEqual([]);
    return run.body as { run_id: string; pack_id: string; review_due_at: string };
  }

  const auditOf = async (runId: string) =>
    (
      await withSuperuser((client) =>
        client.query<{ event_type: string }>(
          `select event_type from acct.audit_events where entity_kind = 'report_run' and entity_id = $1 order by created_at`,
          [runId],
        ),
      )
    ).rows.map((row) => row.event_type);

  const outboxOf = async (runId: string) =>
    (
      await withSuperuser((client) =>
        client.query<{ event_type: string }>(
          `select event_type from sys.outbox where aggregate = 'report_run' and aggregate_id = $1 order by id`,
          [runId],
        ),
      )
    ).rows.map((row) => row.event_type);

  it('holds the run, notifies the reviewers, and approve delivers exactly what was held', async () => {
    const held = await hold({ period_start: '2026-09-01', period_end: '2026-09-07' });
    expect(new Date(held.review_due_at).getTime()).toBeGreaterThan(Date.now());
    // Nothing was delivered, and the held run reads with a link to each rendition.
    const detail = await api().get(`/v1/reporting/runs/${held.run_id}`).set(bearer(adminToken)).expect(200);
    expect(detail.body).toMatchObject({ status: 'ready_for_review', delivery: null, reviewer_id: null });
    expect(detail.body.pack.id).toBe(held.pack_id);
    expect(detail.body.files.pptx).toContain('/v1/storage/download?');
    expect(detail.body.files.pdf).toContain('/v1/storage/download?');
    // The reviewers are the account's reports:manage holders: the owner and the administrator.
    const asked = await withSuperuser((client) =>
      client.query<{ recipient_id: string; link: string }>(
        `select recipient_id, link from acct.notifications where type = 'report.review.requested' and target_id = $1`,
        [held.run_id],
      ),
    );
    expect(asked.rows.map((row) => row.recipient_id).sort()).toEqual([adminId, ownerId].sort());
    expect(asked.rows[0].link).toBe(`/reports/runs/${held.run_id}`);
    expect(await auditOf(held.run_id)).toEqual(['report.run.held_for_review']);

    const approved = await api().post(`/v1/reporting/runs/${held.run_id}/approve`).set(bearer(adminToken)).expect(201);
    expect(approved.body.status).toBe('sent');
    expect(approved.body.delivery.map((row: { outcome: string }) => row.outcome)).toEqual([
      'notified',
      'emailed',
      'skipped',
    ]);
    const after = await withSuperuser((client) =>
      client.query('select status, reviewer_id, reviewed_at, review_due_at from acct.report_runs where id = $1', [
        held.run_id,
      ]),
    );
    expect(after.rows[0]).toMatchObject({ status: 'sent', reviewer_id: adminId, review_due_at: null });
    expect(after.rows[0].reviewed_at).not.toBeNull();
    expect(await auditOf(held.run_id)).toEqual(['report.run.held_for_review', 'report.run.approved']);
    expect(await outboxOf(held.run_id)).toEqual(['report.run.held_for_review', 'report.run.approved']);
    // A sent run is no longer under review.
    const again = await api().post(`/v1/reporting/runs/${held.run_id}/approve`).set(bearer(adminToken)).expect(409);
    expect(again.body).toMatchObject({ code: 'not_under_review', status: 'sent' });
  });

  it('cancel records the reason and delivers nothing', async () => {
    const held = await hold({ period_start: '2026-09-08', period_end: '2026-09-14' });
    const reason = 'The narrative names the wrong programme.';
    const cancelled = await api()
      .post(`/v1/reporting/runs/${held.run_id}/cancel`)
      .set(bearer(adminToken))
      .send({ reason })
      .expect(201);
    expect(cancelled.body).toMatchObject({ status: 'skipped', reason });
    const row = await withSuperuser((client) =>
      client.query('select status, review_note, delivery, reviewer_id from acct.report_runs where id = $1', [
        held.run_id,
      ]),
    );
    expect(row.rows[0]).toMatchObject({
      status: 'skipped',
      review_note: reason,
      delivery: null,
      reviewer_id: adminId,
    });
    expect(await auditOf(held.run_id)).toEqual(['report.run.held_for_review', 'report.run.cancelled']);
    expect(await outboxOf(held.run_id)).toEqual(['report.run.held_for_review', 'report.run.cancelled']);
    // A reason is required.
    const second = await hold({ period_start: '2026-09-15', period_end: '2026-09-21' });
    await api().post(`/v1/reporting/runs/${second.run_id}/cancel`).set(bearer(adminToken)).send({}).expect(400);
    await api()
      .post(`/v1/reporting/runs/${second.run_id}/cancel`)
      .set(bearer(adminToken))
      .send({ reason: 'Superseded.' })
      .expect(201);
  });

  it('the deadline expires the hold to awaiting review, reminds the reviewers and never sends', async () => {
    const held = await hold({ period_start: '2026-09-22', period_end: '2026-09-28' }, 1);
    expect(await schedules.expireReviews()).toBe('expired 0');
    await withSuperuser((client) =>
      client.query(`update acct.report_runs set review_due_at = now() - interval '1 minute' where id = $1`, [
        held.run_id,
      ]),
    );
    expect(await schedules.expireReviews()).toBe('expired 1');
    expect(await schedules.expireReviews()).toBe('expired 0');
    const row = await withSuperuser((client) =>
      client.query('select status, delivery from acct.report_runs where id = $1', [held.run_id]),
    );
    expect(row.rows[0]).toMatchObject({ status: 'awaiting_review', delivery: null });
    const reminded = await withSuperuser((client) =>
      client.query<{ recipient_id: string }>(
        `select recipient_id from acct.notifications where type = 'report.review.overdue' and target_id = $1`,
        [held.run_id],
      ),
    );
    expect(reminded.rows.map((row) => row.recipient_id).sort()).toEqual([adminId, ownerId].sort());
    expect(await auditOf(held.run_id)).toEqual(['report.run.held_for_review', 'report.run.review_expired']);
    // Expired is not dead: the pack is still approvable, which is the only way it ever ships.
    const approved = await api().post(`/v1/reporting/runs/${held.run_id}/approve`).set(bearer(adminToken)).expect(201);
    expect(approved.body.status).toBe('sent');
  });

  it('a user without reports:manage cannot read, approve or cancel a held run', async () => {
    const held = await hold({ period_start: '2026-09-29', period_end: '2026-10-05' });
    await api().get(`/v1/reporting/runs/${held.run_id}`).set(bearer(consultantToken)).expect(403);
    await api().post(`/v1/reporting/runs/${held.run_id}/approve`).set(bearer(consultantToken)).expect(403);
    await api()
      .post(`/v1/reporting/runs/${held.run_id}/cancel`)
      .set(bearer(consultantToken))
      .send({ reason: 'Not mine to judge.' })
      .expect(403);
    const row = await withSuperuser((client) =>
      client.query('select status from acct.report_runs where id = $1', [held.run_id]),
    );
    expect(row.rows[0].status).toBe('ready_for_review');
  });
});
