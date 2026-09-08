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
import { RenewalJobs } from '../src/worker/renewal-jobs.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Engagements and renewal alerts (Time, Contracts & Budget technical 2.1,
 * section 3; functional 5.6, INT-03): the engagement record with its
 * version and its account isolation, a contract linked to it, and the daily
 * job that alerts the owner and the account's contract managers once per
 * lead time, records the firing, writes the audit row and the outbox event,
 * and moves the status to expiring inside the window and ended past the
 * date.
 */
const ADMIN_EMAIL = 'admin@example.test';

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

let app: INestApplication;
let worker: INestApplication;
let renewals: RenewalJobs;
let adminToken: string;
let consultantToken: string;
let adminId: string;
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
  const { WorkerModule } = await import('../src/worker/worker.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  const workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  worker = workerRef.createNestApplication({ bufferLogs: true });
  await worker.init();
  renewals = worker.get(RenewalJobs);

  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  const boot = await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  adminId = boot.body.userId;
  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  accountId = account.body.id;
  await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);
  const other = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'AUS', name: 'Austral Mining' })
    .expect(201);
  otherAccountId = other.body.id;
  await api().post(`/v1/admin/accounts/${otherAccountId}/activate`).set(bearer(adminToken)).expect(201);

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
  await worker?.close();
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('the engagement record (technical 2.1, 4)', () => {
  let engagementId: string;
  let version: number;

  it('creates an engagement with its owner, renewal date and notice period', async () => {
    const created = await api()
      .post(`/v1/accounts/${accountId}/engagements`)
      .set(bearer(adminToken))
      .send({ name: 'Managed services 2026', renewal_date: inDays(200), notice_period_days: 45 })
      .expect(201);
    engagementId = created.body.id;
    version = created.body.version;
    expect(created.body).toMatchObject({
      account_id: accountId,
      name: 'Managed services 2026',
      owner_user_id: adminId,
      renewal_date: inDays(200),
      notice_period_days: 45,
      // Two hundred days out is outside the widest lead window.
      status: 'active',
      renewal_alerts_fired: [],
      version: 1,
    });
    const audit = await withSuperuser((client) =>
      client.query(`select event_type from acct.audit_events where entity_kind = 'engagement' and entity_id = $1`, [
        engagementId,
      ]),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(['created']);
  });

  it('refuses a notice period without a renewal date to give it meaning', async () => {
    const refused = await api()
      .post(`/v1/accounts/${accountId}/engagements`)
      .set(bearer(adminToken))
      .send({ name: 'No date', notice_period_days: 30 })
      .expect(400);
    expect(refused.body).toMatchObject({ code: 'renewal_date_required' });
  });

  it('patches with the version and rejects a stale one', async () => {
    const patched = await api()
      .patch(`/v1/accounts/${accountId}/engagements/${engagementId}`)
      .set(bearer(adminToken))
      .send({ version, name: 'Managed services 2026 to 2027' })
      .expect(200);
    expect(patched.body).toMatchObject({ name: 'Managed services 2026 to 2027', version: version + 1 });
    await api()
      .patch(`/v1/accounts/${accountId}/engagements/${engagementId}`)
      .set(bearer(adminToken))
      .send({ version, name: 'Stale' })
      .expect(409);
    version = patched.body.version;
  });

  it('reads under contracts:view and writes under contracts:manage', async () => {
    await api().get(`/v1/accounts/${accountId}/engagements`).set(bearer(consultantToken)).expect(403);
    await api()
      .post(`/v1/accounts/${accountId}/engagements`)
      .set(bearer(consultantToken))
      .send({ name: 'Not mine' })
      .expect(403);
    const listed = await api().get(`/v1/accounts/${accountId}/engagements`).set(bearer(adminToken)).expect(200);
    expect(listed.body).toHaveLength(1);
  });

  it('links a contract to the engagement and refuses another account engagement', async () => {
    const contract = await api()
      .post(`/v1/accounts/${accountId}/contracts`)
      .set(bearer(adminToken))
      .send({ name: 'Retainer', model: 'retainer', period_hours: 40, engagement_id: engagementId })
      .expect(201);
    expect(contract.body.engagement_id).toBe(engagementId);
    await api()
      .post(`/v1/accounts/${otherAccountId}/contracts`)
      .set(bearer(adminToken))
      .send({ name: 'Cross account', model: 'retainer', engagement_id: engagementId })
      .expect(404);
  });

  it('clears the fired ledger when the renewal date moves', async () => {
    await withSuperuser(async (client) => {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(`update acct.engagements set renewal_alerts_fired = '{90}' where id = $1`, [engagementId]);
      await client.query('commit');
    });
    const moved = await api()
      .patch(`/v1/accounts/${accountId}/engagements/${engagementId}`)
      .set(bearer(adminToken))
      .send({ version, renewal_date: inDays(150) })
      .expect(200);
    expect(moved.body).toMatchObject({ renewal_date: inDays(150), renewal_alerts_fired: [] });
    version = moved.body.version;
  });
});

describe('the renewal alert job (functional 5.6, INT-03)', () => {
  it('alerts the owner and the contract managers once per lead time and moves the status to expiring', async () => {
    const created = await api()
      .post(`/v1/accounts/${accountId}/engagements`)
      .set(bearer(adminToken))
      .send({ name: 'Brookfield support', renewal_date: inDays(58), notice_period_days: 20 })
      .expect(201);
    const id: string = created.body.id;
    // Fifty-eight days out: 90 and 60 are reached, 30 and the twenty-day
    // notice boundary are not.
    expect(created.body.status).toBe('expiring');

    expect(await renewals.alertDue()).toBe('alerted 2, moved 0');
    expect(await renewals.alertDue()).toBe('alerted 0, moved 0');

    const row = await withSuperuser((client) =>
      client.query<{ renewal_alerts_fired: number[]; status: string }>(
        'select renewal_alerts_fired, status from acct.engagements where id = $1',
        [id],
      ),
    );
    expect(row.rows[0].renewal_alerts_fired).toEqual([90, 60]);
    expect(row.rows[0].status).toBe('expiring');

    const notes = await withSuperuser((client) =>
      client.query<{ recipient_id: string; title: string; collapse_key: string }>(
        `select recipient_id, title, collapse_key from acct.notifications
          where type = 'engagement.renewal_due' and target_id = $1 order by collapse_key`,
        [id],
      ),
    );
    expect(notes.rows.map((note) => note.recipient_id)).toContain(adminId);
    expect([...new Set(notes.rows.map((note) => note.collapse_key))]).toEqual([
      `engagement-renewal:${id}:60`,
      `engagement-renewal:${id}:90`,
    ]);
    expect(notes.rows[0].title).toBe('Brookfield support: renewal in 58 days');

    const audit = await withSuperuser((client) =>
      client.query<{ new_value: { lead_days: number } }>(
        `select new_value from acct.audit_events
          where entity_id = $1 and event_type = 'engagement.renewal_due' order by (new_value->>'lead_days')::int`,
        [id],
      ),
    );
    expect(audit.rows.map((event) => event.new_value.lead_days)).toEqual([60, 90]);

    const outbox = await withSuperuser((client) =>
      client.query<{ payload: { lead_days: number; days_remaining: number } }>(
        `select payload from sys.outbox where aggregate_id = $1 and event_type = 'engagement.renewal_due'
          order by (payload->>'lead_days')::int`,
        [id],
      ),
    );
    expect(outbox.rows.map((event) => event.payload.lead_days)).toEqual([60, 90]);
    expect(outbox.rows[0].payload.days_remaining).toBe(58);
  });

  it('fires the notice-period boundary as its own alert once', async () => {
    const created = await api()
      .post(`/v1/accounts/${accountId}/engagements`)
      .set(bearer(adminToken))
      .send({ name: 'Austral platform', renewal_date: inDays(25), notice_period_days: 30 })
      .expect(201);
    const id: string = created.body.id;
    // Twenty-five days out, inside a thirty-day notice period: every lead
    // time and the boundary are owed at once.
    expect(await renewals.alertDue()).toBe('alerted 4, moved 0');
    expect(await renewals.alertDue()).toBe('alerted 0, moved 0');
    const row = await withSuperuser((client) =>
      client.query<{ renewal_alerts_fired: number[] }>(
        'select renewal_alerts_fired from acct.engagements where id = $1',
        [id],
      ),
    );
    expect(row.rows[0].renewal_alerts_fired).toEqual([90, 60, 30, 0]);
    const notice = await withSuperuser((client) =>
      client.query<{ title: string; body: string }>(
        `select title, body from acct.notifications where collapse_key = $1 limit 1`,
        [`engagement-renewal:${id}:0`],
      ),
    );
    expect(notice.rows[0].title).toBe('Austral platform: notice period reached, 25 days to renewal');
    expect(notice.rows[0].body).toContain('notice of 30 days');
  });

  it('moves an engagement to ended once the renewal date has passed and alerts no further', async () => {
    const created = await api()
      .post(`/v1/accounts/${accountId}/engagements`)
      .set(bearer(adminToken))
      .send({ name: 'Lapsed retainer', renewal_date: inDays(2) })
      .expect(201);
    const id: string = created.body.id;
    expect(await renewals.alertDue()).toBe('alerted 3, moved 0');
    // The clock moves rather than the data: the renewal date is now past.
    expect(await renewals.alertDue(200, inDays(3))).toBe('alerted 0, moved 1');
    const row = await withSuperuser((client) =>
      client.query<{ status: string }>('select status from acct.engagements where id = $1', [id]),
    );
    expect(row.rows[0].status).toBe('ended');
    const moved = await withSuperuser((client) =>
      client.query<{ old_value: string; new_value: string }>(
        `select old_value::text as old_value, new_value::text as new_value from acct.audit_events
          where entity_id = $1 and event_type = 'engagement.status_changed'`,
        [id],
      ),
    );
    expect(moved.rows).toHaveLength(1);
    expect(moved.rows[0]).toMatchObject({ old_value: '"expiring"', new_value: '"ended"' });
    // Ended is terminal for the sweep: the row is out of the claim.
    expect(await renewals.alertDue(200, inDays(3))).toBe('alerted 0, moved 0');
  });

  it('leaves an engagement outside every lead window alone', async () => {
    const created = await api()
      .post(`/v1/accounts/${accountId}/engagements`)
      .set(bearer(adminToken))
      .send({ name: 'Long horizon', renewal_date: inDays(180) })
      .expect(201);
    expect(created.body.status).toBe('active');
    expect(await renewals.alertDue()).toBe('alerted 0, moved 0');
    const row = await withSuperuser((client) =>
      client.query<{ status: string; renewal_alerts_fired: number[] }>(
        'select status, renewal_alerts_fired from acct.engagements where id = $1',
        [created.body.id],
      ),
    );
    expect(row.rows[0]).toMatchObject({ status: 'active', renewal_alerts_fired: [] });
  });
});
