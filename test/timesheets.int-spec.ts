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
 * My timesheet and the unlogged-time data (P2.18.3 done-when): a day with
 * four hours logged against an eight-hour calendar reports four unlogged
 * hours; the person's own calendar and holidays drive the expectation; a
 * user without a roster row gets the five-day eight-hour default.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let ticketId = '';

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
  await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer' })
    .expect(201);
  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Timesheet',
      requester_email: 'pat@client.test',
    })
    .expect(201);
  ticketId = ticket.body.id;
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

describe('unlogged time', () => {
  it('uses the default calendar for a user without a roster row: four hours logged on a Tuesday leaves four unlogged', async () => {
    await api()
      .post(`/v1/tickets/${ticketId}/time`)
      .set(bearer(adminToken))
      .send({ performed_on: '2026-04-07', minutes: 240, activity_type: 'analysis' })
      .expect(201);
    const report = await api()
      .get('/v1/timesheets/me/unlogged?from=2026-04-06&to=2026-04-12')
      .set(bearer(adminToken))
      .expect(200);
    const tuesday = report.body.days.find((day: { date: string }) => day.date === '2026-04-07');
    expect(tuesday).toMatchObject({
      expected_minutes: 480,
      logged_minutes: 240,
      unlogged_minutes: 240,
      holiday: false,
    });
    const saturday = report.body.days.find((day: { date: string }) => day.date === '2026-04-11');
    expect(saturday).toMatchObject({ expected_minutes: 0, unlogged_minutes: 0 });
    expect(report.body.unlogged_minutes).toBe(480 * 4 + 240);
  });

  it('follows the person calendar and holidays once the roster knows the user', async () => {
    const imported = await api().post('/v1/roster/import').set(bearer(adminToken)).expect(201);
    const me = imported.body.people.find((row: { email: string }) => row.email === ADMIN_EMAIL);
    await api()
      .put(`/v1/roster/people/${me.id}/calendar`)
      .set(bearer(adminToken))
      .send({ working_days: [1, 2, 3, 4], day_start: '08:00', day_end: '18:00' })
      .expect(200);
    const library = await api()
      .post('/v1/holiday-calendars')
      .set(bearer(adminToken))
      .send({ country: 'GB', name: 'England', holidays: [{ date: '2026-04-06', label: 'Easter Monday' }] })
      .expect(201);
    const person = await api().get(`/v1/roster/people/${me.id}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/roster/people/${me.id}`)
      .set(bearer(adminToken))
      .send({ version: person.body.version, holiday_calendar_id: library.body.id })
      .expect(200);
    const report = await api()
      .get('/v1/timesheets/me/unlogged?from=2026-04-06&to=2026-04-12')
      .set(bearer(adminToken))
      .expect(200);
    const byDate = Object.fromEntries(report.body.days.map((day: { date: string }) => [day.date, day]));
    expect(byDate['2026-04-06']).toMatchObject({ expected_minutes: 0, holiday: true });
    expect(byDate['2026-04-07']).toMatchObject({ expected_minutes: 600, logged_minutes: 240, unlogged_minutes: 360 });
    expect(byDate['2026-04-10']).toMatchObject({ expected_minutes: 0 });
  });

  it('serves my week with entries per day and totals', async () => {
    const week = await api().get('/v1/timesheets/me?week=2026-W15').set(bearer(adminToken)).expect(200);
    expect(week.body).toMatchObject({ from: '2026-04-06', to: '2026-04-12', total_minutes: 240 });
    expect(week.body.days).toHaveLength(7);
    const tuesday = week.body.days.find((day: { date: string }) => day.date === '2026-04-07');
    expect(tuesday.entries).toHaveLength(1);
    expect(tuesday.entries[0].minutes).toBe(240);
    const consultantOnly = await api().get('/v1/timesheets/me').expect(401);
    expect(consultantOnly.status).toBe(401);
  });
});
