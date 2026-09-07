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
 * Capacity over the real database (CAP-02 to CAP-06, cut): PTO by the
 * person or a capacity manager, the month computed from the calendar,
 * holidays, PTO and FTE, allocations upserted as grid cells with versions,
 * the status against the allocation, the assignment-time check, planned
 * versus actual from logged time, and the read models written as a side
 * effect of every read.
 */
const ADMIN_EMAIL = 'admin@example.test';
// September 2026: 22 weekdays; the holiday library declares the 7th.
const MONTH = '2026-09-01';

let app: INestApplication;
let adminToken: string;
let caraToken: string;
let caraId: string;
let caraPersonId: string;
let accountId: string;
let otherAccountId: string;
let ticketKey: string;

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
      .send({ name: 'Retainer', model: 'retainer', period_starts_on: '2026-01-01', period_ends_on: '2026-12-31' })
      .expect(201);
    if (key === 'BRK') accountId = account.body.id;
    else otherAccountId = account.body.id;
  }
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
  caraToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  const library = await api()
    .post('/v1/holiday-calendars')
    .set(bearer(adminToken))
    .send({ country: 'gb', name: 'Test holidays', holidays: [{ date: '2026-09-07', label: 'Declared holiday' }] })
    .expect(201);
  const person = await api()
    .post('/v1/roster/people')
    .set(bearer(adminToken))
    .send({
      display_name: 'Cara Lee',
      email: 'cara@example.test',
      role: 'consultant',
      user_id: caraId,
      fte_percent: 100,
      admin_overhead_percent: 10,
      holiday_calendar_id: library.body.id,
    })
    .expect(201);
  caraPersonId = person.body.id;
  await api()
    .put(`/v1/roster/people/${caraPersonId}/calendar`)
    .set(bearer(adminToken))
    .send({ working_days: [1, 2, 3, 4, 5], day_start: '09:00', day_end: '17:00' })
    .expect(200);
  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(caraToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Capacity check',
      impact: 'high',
      urgency: 'high',
    })
    .expect(201);
  ticketKey = ticket.body.key;
  await api()
    .post(`/v1/tickets/${ticketKey}/transitions`)
    .set(bearer(caraToken))
    .send({ version: 1, to: 'in_progress' })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('PTO (CAP-02)', () => {
  it('the person records their own PTO; another consultant may not; a manager may', async () => {
    const own = await api()
      .post(`/v1/roster/people/${caraPersonId}/pto`)
      .set(bearer(caraToken))
      .send({ starts_on: '2026-09-07', ends_on: '2026-09-09', kind: 'vacation' })
      .expect(201);
    expect(own.body).toMatchObject({ kind: 'vacation', fraction: '1.00', entered_by: caraId });
    const half = await api()
      .post(`/v1/roster/people/${caraPersonId}/pto`)
      .set(bearer(adminToken))
      .send({ starts_on: '2026-09-11', ends_on: '2026-09-11', kind: 'sick', fraction: 0.5 })
      .expect(201);
    expect(half.body.fraction).toBe('0.50');
    const bad = await api()
      .post(`/v1/roster/people/${caraPersonId}/pto`)
      .set(bearer(adminToken))
      .send({ starts_on: '2026-09-12', ends_on: '2026-09-11', kind: 'other' })
      .expect(400);
    expect(bad.body.code).toBe('invalid_range');
    const listed = await api().get(`/v1/roster/people/${caraPersonId}/pto`).set(bearer(caraToken)).expect(200);
    expect(listed.body).toHaveLength(2);
    await api().delete(`/v1/roster/people/${caraPersonId}/pto/${half.body.id}`).set(bearer(adminToken)).expect(200);
    await api().delete(`/v1/roster/people/${caraPersonId}/pto/${half.body.id}`).set(bearer(adminToken)).expect(404);
  });
});

describe('the month (CAP-03) and allocations (CAP-04)', () => {
  it('computes the month from the calendar, the holiday and the PTO, and writes the read model', async () => {
    const view = await api().get(`/v1/capacity?month=2026-09`).set(bearer(adminToken)).expect(200);
    const cara = view.body.people.find((row: { person: { id: string } }) => row.person.id === caraPersonId);
    // 22 working days; the 7th is a holiday inside the PTO range, so PTO counts the 8th and 9th only.
    expect(cara.month).toMatchObject({
      working_days: 22,
      contracted_minutes: 22 * 480,
      holiday_minutes: 480,
      pto_minutes: 960,
      overhead_minutes: Math.round((22 * 480 - 480 - 960) * 0.1),
      allocated_minutes: 0,
      status: 'available',
    });
    expect(cara.month.available_minutes).toBe(22 * 480 - 480 - 960 - Math.round((22 * 480 - 480 - 960) * 0.1));
    const stored = await withSuperuser((client) =>
      client.query(
        'select available_minutes, status from rpt.capacity_periods where person_id = $1 and period_month = $2',
        [caraPersonId, MONTH],
      ),
    );
    expect(stored.rows[0]).toEqual({ available_minutes: cara.month.available_minutes, status: 'available' });
    await api().get(`/v1/capacity?month=2026-9`).set(bearer(adminToken)).expect(400);
    await api().get(`/v1/capacity?month=2026-09`).set(bearer(caraToken)).expect(403);
  });

  it('upserts grid cells with versions, needs a granted account, and flags the status', async () => {
    const available = (
      await api().get(`/v1/capacity?month=2026-09`).set(bearer(adminToken)).expect(200)
    ).body.people.find((row: { person: { id: string } }) => row.person.id === caraPersonId).month.available_minutes;
    const put = await api()
      .put('/v1/allocations')
      .set(bearer(adminToken))
      .send({
        cells: [
          {
            person_id: caraPersonId,
            account_id: accountId,
            month: MONTH,
            planned_minutes: Math.round(available * 0.6),
          },
          {
            person_id: caraPersonId,
            account_id: otherAccountId,
            month: MONTH,
            planned_minutes: Math.round(available * 0.35),
          },
        ],
      })
      .expect(200);
    expect(put.body.cells).toHaveLength(2);
    expect(put.body.cells[0]).toMatchObject({ person_id: caraPersonId, account_id: accountId, version: 1 });
    const warning = await api()
      .get(`/v1/capacity?month=2026-09&account=${accountId}`)
      .set(bearer(adminToken))
      .expect(200);
    const cara = warning.body.people.find((row: { person: { id: string } }) => row.person.id === caraPersonId);
    expect(cara.month.status).toBe('warning');
    expect(cara.allocations).toHaveLength(2);
    const stale = await api()
      .put('/v1/allocations')
      .set(bearer(adminToken))
      .send({
        cells: [{ person_id: caraPersonId, account_id: accountId, month: MONTH, planned_minutes: 60, version: 5 }],
      })
      .expect(409);
    expect(stale.body.code).toBe('stale_version');
    const over = await api()
      .put('/v1/allocations')
      .set(bearer(adminToken))
      .send({
        cells: [
          { person_id: caraPersonId, account_id: accountId, month: MONTH, planned_minutes: available, version: 1 },
        ],
      })
      .expect(200);
    expect(over.body.cells[0].version).toBe(2);
    const check = await api()
      .get(`/v1/capacity/check?person_ids=${caraPersonId}&month=2026-09`)
      .set(bearer(caraToken))
      .expect(200);
    expect(check.body[0]).toMatchObject({ person_id: caraPersonId, status: 'over', remaining_minutes: 0 });
    await api()
      .put('/v1/allocations')
      .set(bearer(caraToken))
      .send({ cells: [{ person_id: caraPersonId, account_id: accountId, month: MONTH, planned_minutes: 60 }] })
      .expect(403);
    const listed = await api()
      .get(`/v1/allocations?account=${accountId}&from=2026-09&to=2026-09`)
      .set(bearer(adminToken))
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].planned_minutes).toBe(available);
    const removed = await api()
      .put('/v1/allocations')
      .set(bearer(adminToken))
      .send({ cells: [{ person_id: caraPersonId, account_id: otherAccountId, month: MONTH, planned_minutes: 0 }] })
      .expect(200);
    expect(removed.body.cells[0]).toMatchObject({ removed: true });
  });
});

describe('planned versus actual (CAP-05)', () => {
  it('compares the allocation with the logged minutes per account', async () => {
    await api()
      .post(`/v1/tickets/${ticketKey}/time`)
      .set(bearer(caraToken))
      .send({ performed_on: '2026-09-02', minutes: 120, activity_type: 'analysis' })
      .expect(201);
    const report = await api()
      .get(`/v1/capacity/variance?month=2026-09&account=${accountId}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(report.body.lines).toHaveLength(1);
    const line = report.body.lines[0];
    expect(line).toMatchObject({ person_id: caraPersonId, account_id: accountId, actual_minutes: 120 });
    expect(line.variance_minutes).toBe(120 - line.planned_minutes);
    expect(line.variance_ratio).toBeCloseTo((120 - line.planned_minutes) / line.planned_minutes, 3);
    const actuals = await withSuperuser((client) =>
      client.query(
        'select planned_minutes, actual_minutes, variance_minutes from rpt.capacity_actuals where person_id = $1 and account_id = $2',
        [caraPersonId, accountId],
      ),
    );
    expect(actuals.rows[0]).toEqual({
      planned_minutes: line.planned_minutes,
      actual_minutes: 120,
      variance_minutes: 120 - line.planned_minutes,
    });
    const view = await api().get(`/v1/capacity?month=2026-09`).set(bearer(adminToken)).expect(200);
    expect(view.body.people[0].month.actual_minutes).toBe(120);
    expect(view.body.totals.actual_minutes).toBe(120);
  });
});
