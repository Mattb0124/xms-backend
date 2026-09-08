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
 * Non-ticket time (TB-12; Time, Contracts & Budget functional 5.3 and 5.8).
 * Governance, QBR preparation, account management and escalation handling
 * are work that belongs to an account but to no ticket. Without it
 * utilisation reads artificially low and budget burn reads artificially
 * favourable, so the entries count towards the personal timesheet and the
 * capacity actuals; whether they burn the contract follows the billable
 * class, exactly as a ticket entry does, and they can never satisfy a rule
 * the ticket owns.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let caraToken: string;
let caraId: string;
let accountId: string;
let otherAccountId: string;
let contractId: string;
let governanceId: string;
let today: string;

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
  today = new Date().toISOString().slice(0, 10);

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
    .send({ name: 'Support retainer', model: 'retainer', period_hours: 40 })
    .expect(201);
  contractId = contract.body.id;

  const other = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'ACM', name: 'Acme' })
    .expect(201);
  otherAccountId = other.body.id;
  await api().post(`/v1/admin/accounts/${otherAccountId}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${otherAccountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Acme retainer', model: 'retainer', period_hours: 40 })
    .expect(201);

  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  caraId = (
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'cara@example.test',
        first_name: 'Cara',
        last_name: 'Lee',
        role_ids: [consultant.id],
        account_ids: [accountId, otherAccountId],
      })
      .expect(201)
  ).body.id;
  caraToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });

  await api()
    .post('/v1/roster/people')
    .set(bearer(adminToken))
    .send({ display_name: 'Cara Lee', email: 'cara@example.test', role: 'consultant', user_id: caraId })
    .expect(201);

  governanceId = (
    await api()
      .post(`/v1/accounts/${accountId}/buckets`)
      .set(bearer(adminToken))
      .send({ key: 'governance', label: 'Governance', code: 'governance' })
      .expect(201)
  ).body.id;
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The burn the server computes, which is what the Budget screen shows. */
const consumed = async (): Promise<{ consumed: number; nonConsuming: number }> => {
  const position = await api()
    .get(`/v1/accounts/${accountId}/contracts/${contractId}/position`)
    .set(bearer(adminToken))
    .expect(200);
  return {
    consumed: position.body.consumed_minutes,
    nonConsuming: position.body.non_consuming_minutes,
  };
};

function logOnBucket(bucketId: string, body: Record<string, unknown>, account = accountId, token = caraToken) {
  return api()
    .post(`/v1/accounts/${account}/buckets/${bucketId}/time-entries`)
    .set(bearer(token))
    .send({ performed_on: today, activity_type: 'governance', ...body });
}

describe('the bucket catalog', () => {
  it('takes a code from the closed vocabulary and defaults the class to one that does not burn the contract', async () => {
    const buckets = await api().get(`/v1/accounts/${accountId}/buckets`).set(bearer(caraToken)).expect(200);
    const governance = buckets.body.find((row: { id: string }) => row.id === governanceId);
    // Functional 5.9: non-ticket work is internal unless the account says otherwise.
    expect(governance).toMatchObject({ code: 'governance', billable_class: 'non_billable', contract_id: null });

    const custom = await api()
      .post(`/v1/accounts/${accountId}/buckets`)
      .set(bearer(adminToken))
      .send({ key: 'qbr_prep', label: 'QBR preparation', code: 'qbr_prep', contract_id: contractId })
      .expect(201);
    expect(custom.body).toMatchObject({ code: 'qbr_prep', contract_id: contractId });

    // Anything an account invents is `custom`, and a code outside the
    // vocabulary is refused before the service.
    const invented = await api()
      .post(`/v1/accounts/${accountId}/buckets`)
      .set(bearer(adminToken))
      .send({ key: 'steering', label: 'Steering committee' })
      .expect(201);
    expect(invented.body.code).toBe('custom');
    await api()
      .post(`/v1/accounts/${accountId}/buckets`)
      .set(bearer(adminToken))
      .send({ key: 'invented', label: 'Invented', code: 'whatever' })
      .expect(400);

    // A contract of another account is not this account's to name.
    const foreign = await api()
      .post(`/v1/accounts/${otherAccountId}/buckets`)
      .set(bearer(adminToken))
      .send({ key: 'governance', label: 'Governance', contract_id: contractId })
      .expect(404);
    expect(foreign.body.code).toBe('not_found');
  });

  it('retires a bucket and refuses time on it, behind contracts:manage', async () => {
    const bucket = await api()
      .post(`/v1/accounts/${accountId}/buckets`)
      .set(bearer(adminToken))
      .send({ key: 'old_practice', label: 'Old practice' })
      .expect(201);
    await api()
      .patch(`/v1/accounts/${accountId}/buckets/${bucket.body.id}`)
      .set(bearer(caraToken))
      .send({ version: bucket.body.version, status: 'retired' })
      .expect(403);
    await api()
      .patch(`/v1/accounts/${accountId}/buckets/${bucket.body.id}`)
      .set(bearer(adminToken))
      .send({ version: bucket.body.version, status: 'retired' })
      .expect(200);
    const refused = await logOnBucket(bucket.body.id, { minutes: 30 }).expect(409);
    expect(refused.body.code).toBe('bucket_retired');
  });
});

describe('logging time with no ticket', () => {
  it('records the entry, shows it on my timesheet and leaves the contract unburned', async () => {
    const before = await consumed();
    const entry = await logOnBucket(governanceId, { minutes: 90, description: 'Monthly service review' }).expect(201);
    expect(entry.body).toMatchObject({
      ticket_id: null,
      bucket_id: governanceId,
      billable_class: 'non_billable',
      minutes: 90,
      person_id: caraId,
    });

    const week = await api().get('/v1/timesheets/me').set(bearer(caraToken)).expect(200);
    const logged = week.body.days
      .flatMap((day: { entries: { bucket_label: string | null; minutes: number }[] }) => day.entries)
      .filter((row: { bucket_label: string | null }) => row.bucket_label === 'Governance');
    expect(logged.map((row: { minutes: number }) => row.minutes)).toContain(90);
    expect(week.body.total_minutes).toBeGreaterThanOrEqual(90);

    // Non-billable does not consume the period, so the burn is unmoved
    // (functional 5.9: onboarding weeks are logged, not billed).
    const after = await consumed();
    expect(after.consumed).toBe(before.consumed);
    // It is not invisible: it is counted as work that does not consume the contract.
    expect(after.nonConsuming).toBe(before.nonConsuming + 90);
  });

  it('burns the contract when the account says the bucket is billable', async () => {
    const billable = await api()
      .post(`/v1/accounts/${accountId}/buckets`)
      .set(bearer(adminToken))
      .send({
        key: 'escalation',
        label: 'Escalation handling',
        code: 'escalation',
        billable_class: 'billable',
        contract_id: contractId,
      })
      .expect(201);
    const before = await consumed();
    await logOnBucket(billable.body.id, { minutes: 60 }).expect(201);
    expect((await consumed()).consumed).toBe(before.consumed + 60);
  });

  it('counts towards the capacity actuals of the person and the account (CAP-05)', async () => {
    const month = today.slice(0, 7);
    const variance = await api()
      .get(`/v1/capacity/variance?month=${month}&account=${accountId}`)
      .set(bearer(adminToken))
      .expect(200);
    const line = variance.body.lines.find(
      (row: { display_name: string; account_id: string }) =>
        row.display_name === 'Cara Lee' && row.account_id === accountId,
    );
    // Utilisation is only honest if non-ticket work is in it: 90 minutes of
    // governance plus 60 of escalation handling, neither on a ticket.
    expect(line, 'the actuals carry the bucket time').toBeDefined();
    expect(line.actual_minutes).toBe(150);
  });

  it('never satisfies a rule the ticket owns, and refuses a bucket of another account', async () => {
    // TB-02: a ticket cannot be resolved without time on the ticket. Time on
    // a bucket is the account's work, not this ticket's, so it does not count.
    const ticket = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'Needs time before resolution' })
      .expect(201);
    let current = (
      await api()
        .post(`/v1/tickets/${ticket.body.key}/transitions`)
        .set(bearer(adminToken))
        .send({ version: ticket.body.version, to: 'in_progress' })
        .expect(201)
    ).body;
    const refused = await api()
      .post(`/v1/tickets/${ticket.body.key}/transitions`)
      .set(bearer(adminToken))
      .send({
        version: current.version,
        to: 'resolved',
        resolution: { code: 'fixed', notes: 'Done', solution_candidate: true },
      })
      .expect(409);
    expect(refused.body.code).toBe('missing_requirements');
    expect(refused.body.items).toContain('time_logged');

    // The same minutes logged on the ticket do satisfy it.
    await api()
      .post(`/v1/tickets/${ticket.body.key}/time`)
      .set(bearer(adminToken))
      .send({ performed_on: today, minutes: 30, activity_type: 'analysis' })
      .expect(201);
    current = (await api().get(`/v1/tickets/${ticket.body.key}`).set(bearer(adminToken)).expect(200)).body;
    await api()
      .post(`/v1/tickets/${ticket.body.key}/transitions`)
      .set(bearer(adminToken))
      .send({
        version: current.version,
        to: 'resolved',
        resolution: { code: 'fixed', notes: 'Done', solution_candidate: true },
      })
      .expect(201);

    // A bucket reached through another account's path is not found.
    const foreign = await logOnBucket(governanceId, { minutes: 15 }, otherAccountId).expect(404);
    expect(foreign.body.code).toBe('not_found');
  });
});
