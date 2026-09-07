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
 * After-hours class on time entries (TB-13): the account calendar decides
 * the class of the date and start time, the contract's handling freezes a
 * premium multiplier or leaves the fact for the comp-time report, and the
 * handling can be changed on a live contract with an audit trail.
 */
const ADMIN_EMAIL = 'admin@example.test';
const OFFICE = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 540, end_minute: 1020 }));
// Fixed dates in the past relative to any run after 2026-09-07: a Tuesday, a Saturday and a declared holiday.
const TUESDAY = '2026-09-01';
const SATURDAY = '2026-09-05';
const HOLIDAY = '2026-09-02';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let plainAccountId: string;
let contractId: string;
let contractVersion: number;
let plainContractId: string;
let ticketKey: string;
let plainTicketKey: string;

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
  const library = await api()
    .post('/v1/holiday-calendars')
    .set(bearer(adminToken))
    .send({ country: 'gb', name: 'Test holidays', holidays: [{ date: HOLIDAY, label: 'Declared holiday' }] })
    .expect(201);
  await api()
    .post(`/v1/accounts/${accountId}/calendars`)
    .set(bearer(adminToken))
    .send({ name: 'UK office hours', time_zone: 'Europe/London', holiday_calendar_id: library.body.id, hours: OFFICE })
    .expect(201);
  const contract = await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({
      name: 'Retainer',
      model: 'retainer',
      period_hours: 40,
      period_starts_on: '2026-08-01',
      period_ends_on: '2026-12-31',
      after_hours_handling: 'premium_rate',
      after_hours_multiplier: 1.5,
    })
    .expect(201);
  contractId = contract.body.id;
  contractVersion = contract.body.version;
  expect(contract.body).toMatchObject({ after_hours_handling: 'premium_rate', after_hours_multiplier: '1.500' });
  ticketKey = await openTicket(accountId);

  const plain = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'AUS', name: 'Austral Mining' })
    .expect(201);
  plainAccountId = plain.body.id;
  await api().post(`/v1/admin/accounts/${plainAccountId}/activate`).set(bearer(adminToken)).expect(201);
  const plainContract = await api()
    .post(`/v1/accounts/${plainAccountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'T&M', model: 'time_and_materials', period_starts_on: '2026-08-01', period_ends_on: '2026-12-31' })
    .expect(201);
  plainContractId = plainContract.body.id;
  expect(plainContract.body).toMatchObject({ after_hours_handling: 'none', after_hours_multiplier: null });
  plainTicketKey = await openTicket(plainAccountId);
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

async function openTicket(account: string): Promise<string> {
  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({
      account_id: account,
      type: 'incident',
      short_description: 'Overnight batch failed',
      impact: 'high',
      urgency: 'high',
      requester_email: 'pat@client.test',
    })
    .expect(201);
  await api()
    .post(`/v1/tickets/${ticket.body.key}/transitions`)
    .set(bearer(adminToken))
    .send({ version: 1, to: 'in_progress' })
    .expect(201);
  return ticket.body.key;
}

async function log(key: string, body: Record<string, unknown>) {
  const entry = await api()
    .post(`/v1/tickets/${key}/time`)
    .set(bearer(adminToken))
    .send({ minutes: 60, activity_type: 'analysis', ...body })
    .expect(201);
  return entry.body;
}

describe('after-hours class on time entries', () => {
  it('a working-day entry without a start is standard at multiplier 1', async () => {
    const entry = await log(ticketKey, { performed_on: TUESDAY });
    expect(entry).toMatchObject({ after_hours_class: 'standard', after_hours: false, rate_multiplier: '1.000' });
  });

  it('a start outside the hours is after hours and carries the contract premium', async () => {
    const entry = await log(ticketKey, { performed_on: TUESDAY, performed_start: '19:30' });
    expect(entry).toMatchObject({
      after_hours_class: 'after_hours',
      after_hours: true,
      performed_start: '19:30:00',
      rate_multiplier: '1.500',
    });
    const inside = await log(ticketKey, { performed_on: TUESDAY, performed_start: '10:00', after_hours: true });
    expect(inside).toMatchObject({ after_hours_class: 'standard', rate_multiplier: '1.000' });
  });

  it('weekend and holiday come from the calendar and the holiday library', async () => {
    const weekend = await log(ticketKey, { performed_on: SATURDAY, performed_start: '10:00' });
    expect(weekend).toMatchObject({ after_hours_class: 'weekend', rate_multiplier: '1.500' });
    const holiday = await log(ticketKey, { performed_on: HOLIDAY });
    expect(holiday).toMatchObject({ after_hours_class: 'holiday', after_hours: true, rate_multiplier: '1.500' });
  });

  it("takes the person's word when there is no calendar or no start, and refuses a malformed start", async () => {
    const asserted = await log(plainTicketKey, { performed_on: TUESDAY, after_hours: true });
    expect(asserted).toMatchObject({ after_hours_class: 'after_hours', rate_multiplier: '1.000' });
    const saturday = await log(plainTicketKey, { performed_on: SATURDAY, performed_start: '10:00' });
    expect(saturday).toMatchObject({ after_hours_class: 'standard', after_hours: false });
    const bad = await api()
      .post(`/v1/tickets/${plainTicketKey}/time`)
      .set(bearer(adminToken))
      .send({ minutes: 30, activity_type: 'analysis', performed_on: TUESDAY, performed_start: '7pm' })
      .expect(400);
    expect(bad.body.code).toBe('validation_failed');
  });

  it('the handling changes on a live contract with an audit row, and premium needs a multiplier', async () => {
    const missing = await api()
      .patch(`/v1/accounts/${plainAccountId}/contracts/${plainContractId}`)
      .set(bearer(adminToken))
      .send({ version: 1, after_hours_handling: 'premium_rate' })
      .expect(400);
    expect(missing.body.code).toBe('multiplier_required');
    const changed = await api()
      .patch(`/v1/accounts/${accountId}/contracts/${contractId}`)
      .set(bearer(adminToken))
      .send({ version: contractVersion, after_hours_handling: 'comp_time' })
      .expect(200);
    expect(changed.body).toMatchObject({ after_hours_handling: 'comp_time', after_hours_multiplier: null });
    contractVersion = changed.body.version;
    await api()
      .patch(`/v1/accounts/${accountId}/contracts/${contractId}`)
      .set(bearer(adminToken))
      .send({ version: contractVersion - 1, after_hours_handling: 'none' })
      .expect(409);
    await api()
      .patch(`/v1/accounts/${plainAccountId}/contracts/${contractId}`)
      .set(bearer(adminToken))
      .send({ version: contractVersion, after_hours_handling: 'none' })
      .expect(404);
    const audit = await withSuperuser((client) =>
      client.query(
        `select field from acct.audit_events where account_id = $1 and entity_kind = 'contract' and entity_id = $2 and event_type = 'updated'`,
        [accountId, contractId],
      ),
    );
    expect(audit.rows.map((row) => row.field)).toContain('after_hours');
  });

  it('under comp time the multiplier stays 1 and the entry reaches the comp-time report', async () => {
    const entry = await log(ticketKey, { performed_on: SATURDAY, minutes: 90 });
    expect(entry).toMatchObject({ after_hours_class: 'weekend', rate_multiplier: '1.000' });
    const report = await api()
      .get(`/v1/accounts/${accountId}/time/comp-time?from=2026-08-01&to=2026-09-30`)
      .set(bearer(adminToken))
      .expect(200);
    expect(report.body.total_minutes).toBe(90);
    expect(report.body.entries.map((row: { id: string }) => row.id)).toEqual([entry.id]);
    expect(report.body.by_person).toEqual([
      { person_id: expect.any(String), person_name: expect.any(String), minutes: 90, entries: 1 },
    ]);
    const other = await api()
      .get(`/v1/accounts/${plainAccountId}/time/comp-time?from=2026-08-01&to=2026-09-30`)
      .set(bearer(adminToken))
      .expect(200);
    expect(other.body.entries).toEqual([]);
  });
});
