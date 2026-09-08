import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Time and consumption over the real database (P2.12.2, P2.12.3, P2.13.1
 * cut, P2.13.2 done-when): entries validated against the catalogs, the
 * close discipline accepts logged time, adjustments are new rows, a locked
 * period rejects writes at the database, and the contract position is
 * computed on the server.
 */
const ADMIN_EMAIL = 'admin@example.test';
const today = new Date().toISOString().slice(0, 10);

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let accountId: string;
let contractId: string;

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
  const contract = await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer', period_hours: 40 })
    .expect(201);
  contractId = contract.body.id;
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

describe('time on tickets', () => {
  let key: string;
  let entryId: string;

  it('logs time with the activity taxonomy, defaulting the billable class from the activity', async () => {
    const ticket = await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Cube refresh fails',
        impact: 'high',
        urgency: 'high',
      })
      .expect(201);
    key = ticket.body.key;
    await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 1, to: 'in_progress' })
      .expect(201);
    const entry = await api()
      .post(`/v1/tickets/${key}/time`)
      .set(bearer(consultantToken))
      .send({ performed_on: today, minutes: 45, activity_type: 'analysis', description: 'Traced the failing job' })
      .expect(201);
    entryId = entry.body.id;
    expect(entry.body).toMatchObject({
      minutes: 45,
      activity_type: 'analysis',
      billable_class: 'billable',
      person_name: 'Cara Lee',
      contract_id: contractId,
    });
    const rework = await api()
      .post(`/v1/tickets/${key}/time`)
      .set(bearer(consultantToken))
      .send({ performed_on: today, minutes: 15, activity_type: 'rework' })
      .expect(201);
    expect(rework.body.billable_class).toBe('absorbed');
    const listed = await api().get(`/v1/tickets/${key}/time`).set(bearer(consultantToken)).expect(200);
    expect(listed.body.total_minutes).toBe(60);
  });

  it('rejects an unknown activity, a future date and a zero duration', async () => {
    await api()
      .post(`/v1/tickets/${key}/time`)
      .set(bearer(consultantToken))
      .send({ performed_on: today, minutes: 30, activity_type: 'daydreaming' })
      .expect(400);
    await api()
      .post(`/v1/tickets/${key}/time`)
      .set(bearer(consultantToken))
      .send({ performed_on: '2999-01-01', minutes: 30, activity_type: 'analysis' })
      .expect(400);
    await api()
      .post(`/v1/tickets/${key}/time`)
      .set(bearer(consultantToken))
      .send({ performed_on: today, minutes: 0, activity_type: 'analysis' })
      .expect(400);
  });

  it('lets the ticket resolve without a time exemption once time is logged', async () => {
    const resolved = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({
        version: 2,
        to: 'resolved',
        resolution: { code: 'fixed', notes: 'Rebuilt the cube', solution_candidate: true },
      })
      .expect(201);
    expect(resolved.body.resolved_at).not.toBeNull();
  });

  it('entries are immutable; a correction is an adjustment row that needs time:adjust', async () => {
    await expect(
      withSuperuser((client) => client.query(`update acct.time_entries set minutes = 1 where id = $1`, [entryId])),
    ).rejects.toMatchObject({ code: '23001' });
    await api()
      .post('/v1/time/adjustments')
      .set(bearer(consultantToken))
      .send({ entry_id: entryId, delta_minutes: -15, kind: 'correction', reason: 'Logged too much' })
      .expect(403);
    const adjustment = await api()
      .post('/v1/time/adjustments')
      .set(bearer(adminToken))
      .send({ entry_id: entryId, delta_minutes: -15, kind: 'correction', reason: 'Logged too much' })
      .expect(201);
    expect(adjustment.body).toMatchObject({ delta_minutes: -15, kind: 'correction' });
    const belowZero = await api()
      .post('/v1/time/adjustments')
      .set(bearer(adminToken))
      .send({ entry_id: entryId, delta_minutes: -60, kind: 'write_off', reason: 'Too much' })
      .expect(409);
    expect(belowZero.body.code).toBe('adjustment_below_zero');
    const listed = await api().get(`/v1/tickets/${key}/time`).set(bearer(consultantToken)).expect(200);
    expect(listed.body.total_minutes).toBe(45);
  });

  it('keeps the commercial reads off tickets:view and computes the contract position on the server', async () => {
    // Contracts, rate cards, budget, account time and billing are
    // commercial: a consultant works tickets and does not read them
    // (security review finding 22). The position is the one exception, and
    // only because it prices nothing: it is the burn bar the wireframe puts
    // on the ticket record, so it answers a consultant below.
    for (const path of [
      `/v1/accounts/${accountId}/contracts`,
      `/v1/accounts/${accountId}/rate-cards`,
      `/v1/accounts/${accountId}/budget`,
      `/v1/accounts/${accountId}/time`,
      `/v1/accounts/${accountId}/billing-periods`,
    ]) {
      const refused = await api().get(path).set(bearer(consultantToken)).expect(403);
      expect(refused.body).toMatchObject({ code: 'forbidden', permission: 'contracts:view' });
    }
    await api()
      .get(`/v1/accounts/${accountId}/contracts/${contractId}/position`)
      .set(bearer(consultantToken))
      .expect(200);
    const position = await api()
      .get(`/v1/accounts/${accountId}/contracts/${contractId}/position`)
      .set(bearer(adminToken))
      .expect(200);
    expect(position.body).toMatchObject({
      contract: { id: contractId, model: 'retainer' },
      available_minutes: 2400,
      consumed_minutes: 30,
      non_consuming_minutes: 15,
      remaining_minutes: 2370,
    });
    expect(position.body.by_activity).toEqual({ analysis: 30, rework: 15 });
    expect(position.body.status).toBe('on_track');
  });

  it('serves my timesheet for the week', async () => {
    const mine = await api().get('/v1/time/mine').set(bearer(consultantToken)).expect(200);
    expect(
      mine.body.map((row: { minutes: number; ticket_number: string }) => [row.minutes, row.ticket_number]),
    ).toEqual([
      [45, String(Number(key.slice(2)))],
      [15, String(Number(key.slice(2)))],
    ]);
  });
});

describe('buckets and locked periods', () => {
  it('logs non-ticket time on a bucket with the bucket class', async () => {
    await api()
      .post(`/v1/accounts/${accountId}/buckets`)
      .set(bearer(consultantToken))
      .send({ key: 'governance', label: 'Governance', billable_class: 'non_billable' })
      .expect(403);
    const bucket = await api()
      .post(`/v1/accounts/${accountId}/buckets`)
      .set(bearer(adminToken))
      .send({ key: 'governance', label: 'Governance', billable_class: 'non_billable' })
      .expect(201);
    const entry = await api()
      .post(`/v1/accounts/${accountId}/buckets/${bucket.body.id}/time`)
      .set(bearer(consultantToken))
      .send({ performed_on: today, minutes: 30, activity_type: 'governance' })
      .expect(201);
    expect(entry.body).toMatchObject({ bucket_id: bucket.body.id, ticket_id: null, billable_class: 'non_billable' });
  });

  it('a locked billing period rejects new entries and adjustments dated inside it, at the database', async () => {
    const period = await api()
      .post(`/v1/accounts/${accountId}/billing-periods`)
      .set(bearer(adminToken))
      .send({ starts_on: '2026-01-01', ends_on: '2026-01-31' })
      .expect(201);
    await api()
      .post(`/v1/accounts/${accountId}/billing-periods/${period.body.id}/lock`)
      .set(bearer(adminToken))
      .expect(201);
    const ticket = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'Old' })
      .expect(201);
    const refused = await api()
      .post(`/v1/tickets/${ticket.body.key}/time`)
      .set(bearer(adminToken))
      .send({ performed_on: '2026-01-15', minutes: 30, activity_type: 'analysis' })
      .expect(409);
    expect(refused.body.code).toBe('billing_period_locked');
    // The trigger holds even when the service check is bypassed.
    const contract = contractId;
    await expect(
      withSuperuser((client) =>
        client.query(
          `insert into acct.time_entries (account_id, ticket_id, contract_id, person_id, performed_on, minutes, activity_type, billable_class, created_by)
           values ($1, $2, $3, 'x', '2026-01-15', 30, 'analysis', 'billable', 'x')`,
          [accountId, ticket.body.id, contract],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
