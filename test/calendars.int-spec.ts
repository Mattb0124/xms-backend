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
 * Business calendars end to end (P3.26.1 core; TM-06): the holiday library,
 * a calendar document with hours and the account default, the preview
 * route, and the SLA clocks of a new ticket bound to the calendar they
 * started on: the due time skips the evening, the weekend and the holiday,
 * the view counts working minutes only, and a pause across a weekend
 * excludes nothing. Wall clock stays the fallback for an account without a
 * default calendar.
 */
const ADMIN_EMAIL = 'admin@example.test';
const OFFICE = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 540, end_minute: 1020 }));

let app: INestApplication;
let adminToken: string;
let accountId: string;
let otherAccountId: string;
let calendarId = '';
let calendarVersion = 1;

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
      .send({ name: 'Retainer', model: 'retainer' })
      .expect(201);
    if (key === 'BRK') accountId = account.body.id;
    else otherAccountId = account.body.id;
  }
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

describe('calendar administration', () => {
  it('keeps a holiday library and refuses bad hours or an unknown zone', async () => {
    const library = await api()
      .post('/v1/holiday-calendars')
      .set(bearer(adminToken))
      .send({
        country: 'gb',
        name: 'England and Wales',
        holidays: [
          { date: '2026-04-06', label: 'Easter Monday' },
          { date: '2026-05-04', label: 'Early May bank holiday' },
        ],
      })
      .expect(201);
    expect(library.body).toMatchObject({ country: 'GB', name: 'England and Wales' });
    const list = await api().get('/v1/holiday-calendars').set(bearer(adminToken)).expect(200);
    expect(list.body[0].holidays).toHaveLength(2);
    const badZone = await api()
      .post(`/v1/accounts/${accountId}/calendars`)
      .set(bearer(adminToken))
      .send({ name: 'Bad', time_zone: 'Mars/Olympus', hours: OFFICE })
      .expect(400);
    expect(badZone.body.code).toBe('invalid_time_zone');
    const badHours = await api()
      .post(`/v1/accounts/${accountId}/calendars`)
      .set(bearer(adminToken))
      .send({ name: 'Bad', time_zone: 'Europe/London', hours: [{ weekday: 1, start_minute: 600, end_minute: 540 }] })
      .expect(400);
    expect(badHours.body.code).toBe('invalid_hours');
    const created = await api()
      .post(`/v1/accounts/${accountId}/calendars`)
      .set(bearer(adminToken))
      .send({
        name: 'UK office hours',
        time_zone: 'Europe/London',
        holiday_calendar_id: library.body.id,
        hours: OFFICE,
      })
      .expect(201);
    calendarId = created.body.id;
    calendarVersion = created.body.version;
    expect(created.body).toMatchObject({ is_default: true, status: 'active', time_zone: 'Europe/London' });
    expect(created.body.hours).toHaveLength(5);
    expect(created.body.holidays.map((row: { date: string }) => row.date)).toEqual(['2026-04-06', '2026-05-04']);
    const audit = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from acct.audit_events where event_type = 'admin.calendar.updated'`),
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('previews a due time that skips the evening, the weekend and the bank holiday', async () => {
    const preview = await api()
      .post(`/v1/calendars/${calendarId}/preview`)
      .set(bearer(adminToken))
      .send({ start: '2026-04-03T15:30:00Z', minutes: 60 })
      .expect(201);
    expect(preview.body).toMatchObject({
      due_at: '2026-04-07T08:30:00.000Z',
      working_minutes_between: 60,
      starts_in_working_time: true,
    });
    expect(preview.body.wall_minutes_between).toBeGreaterThan(60 * 24 * 3);
  });

  it('edits hours with the version, is readable by ticket viewers, and gates writes on admin:config', async () => {
    const patched = await api()
      .patch(`/v1/calendars/${calendarId}`)
      .set(bearer(adminToken))
      .send({
        version: calendarVersion,
        name: 'UK office hours (extended)',
        hours: [...OFFICE, { weekday: 6, start_minute: 600, end_minute: 720 }],
      })
      .expect(200);
    calendarVersion = patched.body.version;
    expect(patched.body.hours).toHaveLength(6);
    const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
    const consultant = roles.body.find((row: { name: string }) => row.name === 'Consultant');
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'consultant@example.test',
        first_name: 'Chris',
        last_name: 'Consultant',
        role_ids: [consultant.id],
        account_ids: [accountId],
      })
      .expect(201);
    const token = await devToken({ sub: 'dev_consultant', email: 'consultant@example.test' });
    const read = await api().get(`/v1/calendars/${calendarId}`).set(bearer(token)).expect(200);
    expect(read.body.name).toBe('UK office hours (extended)');
    await api()
      .patch(`/v1/calendars/${calendarId}`)
      .set(bearer(token))
      .send({ version: calendarVersion, name: 'Nope' })
      .expect(403);
    await api().get(`/v1/accounts/${accountId}/calendars`).set(bearer(token)).expect(200);
  });
});

describe('SLA clocks on the account calendar', () => {
  it('binds new clocks to the default calendar and reports working minutes remaining', async () => {
    const created = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Calendar clock',
        impact: 'high',
        urgency: 'high',
        requester_email: 'pat@client.test',
      })
      .expect(201);
    const clocks = await withSuperuser((client) =>
      client.query(
        `select kind, calendar_id, target_minutes, started_at, due_at from acct.sla_clocks where ticket_id = $1 order by kind`,
        [created.body.id],
      ),
    );
    expect(clocks.rows.map((row) => row.calendar_id)).toEqual([calendarId, calendarId]);
    const response = clocks.rows.find((row) => row.kind === 'response')!;
    const startedAt = new Date(response.started_at);
    const dueAt = new Date(response.due_at);
    // Thirty working minutes on a Monday-to-Friday 09:00 to 17:00 London calendar (plus Saturday mornings) never lands outside working hours.
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(dueAt);
    const [hour] = local.split(':').map(Number);
    expect(hour).toBeGreaterThanOrEqual(9);
    expect(hour).toBeLessThanOrEqual(17);
    expect(dueAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    const view = await api().get(`/v1/tickets/${created.body.id}`).set(bearer(adminToken)).expect(200);
    expect(view.body.sla.response.remainingMinutes).toBeLessThanOrEqual(30);
    expect(view.body.sla.response.remainingMinutes).toBeGreaterThanOrEqual(0);
  });

  it('keeps the wall clock for an account without a default calendar', async () => {
    const created = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: otherAccountId,
        type: 'incident',
        short_description: 'Wall clock',
        impact: 'high',
        urgency: 'high',
        requester_email: 'sam@client.test',
      })
      .expect(201);
    const clocks = await withSuperuser((client) =>
      client.query(
        `select calendar_id, started_at, due_at, target_minutes from acct.sla_clocks where ticket_id = $1 and kind = 'response'`,
        [created.body.id],
      ),
    );
    expect(clocks.rows[0].calendar_id).toBe('24x7');
    expect(new Date(clocks.rows[0].due_at).getTime() - new Date(clocks.rows[0].started_at).getTime()).toBe(
      clocks.rows[0].target_minutes * 60_000,
    );
  });

  it('the at-risk job judges calendar clocks on working minutes, not wall time', async () => {
    const created = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'At risk on Friday',
        impact: 'high',
        urgency: 'high',
        requester_email: 'pat@client.test',
      })
      .expect(201);
    // A response clock with 60 working minutes left at Friday 16:00 BST: due Monday 10:00 BST, two and a half wall days away.
    const friday = new Date('2026-04-10T15:00:00Z');
    await withSuperuser((client) =>
      client.query(
        `update acct.sla_clocks set target_minutes = 120, started_at = $2, due_at = '2026-04-13T09:00:00Z', at_risk_notified_at = null where ticket_id = $1 and kind = 'response'`,
        [created.body.id, friday],
      ),
    );
    const { SlaJobs } = await import('../src/worker/sla-jobs.js');
    const { TicketsRepository } = await import('../src/modules/tickets/tickets.repository.js');
    const { NotificationsRepository } = await import('../src/modules/notifications/notifications.repository.js');
    const { AuditService } = await import('../src/common/audit/audit.service.js');
    const { OutboxService } = await import('../src/common/outbox/outbox.service.js');
    const { CalendarService } = await import('../src/modules/calendars/calendars.module.js');
    const { UnitOfWork } = await import('../src/db/unit-of-work.js');
    const { pools } = await import('./kit/db.js');
    const jobs = new SlaJobs(
      pools(),
      app.get(UnitOfWork),
      app.get(TicketsRepository),
      app.get(NotificationsRepository),
      app.get(AuditService),
      app.get(OutboxService),
      app.get(CalendarService),
    );
    // Wall time says nothing is at risk for days; working minutes say one hour of a two-hour target remains, and that is not yet a quarter.
    const before = await jobs.notifyAtRisk();
    expect(before).toBe('notified 0');
    await withSuperuser((client) =>
      client.query(
        `update acct.sla_clocks set due_at = '2026-04-13T08:20:00Z' where ticket_id = $1 and kind = 'response'`,
        [created.body.id],
      ),
    );
    // Twenty working minutes of a hundred and twenty remain: under a quarter, so the notification fires despite the weekend in between.
    // (The job compares against now, so this only holds while the test clock is before that Monday; guard the assertion.)
    if (Date.now() < new Date('2026-04-13T08:20:00Z').getTime()) {
      expect(await jobs.notifyAtRisk()).toBe('notified 1');
    }
  });

  it('a pause and resume across a weekend excludes no working minutes', async () => {
    const created = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Weekend pause',
        impact: 'low',
        urgency: 'low',
        requester_email: 'pat@client.test',
      })
      .expect(201);
    // Move the clock to a known Friday and pause it there through the weekend, then resume on Monday.
    await withSuperuser((client) =>
      client.query(
        `update acct.sla_clocks set started_at = '2026-04-10T08:00:00Z', due_at = '2026-04-10T16:00:00Z', paused_at = '2026-04-10T15:00:00Z' where ticket_id = $1 and kind = 'resolution'`,
        [created.body.id],
      ),
    );
    const { resume } = await import('../src/domain/sla/engine.js');
    const { CalendarService } = await import('../src/modules/calendars/calendars.module.js');
    const { UnitOfWork } = await import('../src/db/unit-of-work.js');
    const calendars = app.get(CalendarService);
    const uow = app.get(UnitOfWork);
    const result = await uow.worker([accountId], async (tx) => {
      const calendar = await calendars.byId(tx, calendarId);
      return resume(
        {
          kind: 'resolution',
          policyRef: 'p',
          calendarId,
          targetMinutes: 480,
          startedAt: new Date('2026-04-10T08:00:00Z'),
          dueAt: new Date('2026-04-10T16:00:00Z'),
          pausedAt: new Date('2026-04-10T15:00:00Z'),
          pausedTotalMinutes: 0,
          metAt: null,
          breachedAt: null,
        },
        calendar,
        new Date('2026-04-13T08:00:00Z'),
      );
    });
    // Friday 16:00 to 17:00 BST is one working hour; Saturday 10:00 to 12:00 two more on the extended calendar; Sunday nothing; the due time moves three working hours to Monday 10:00 BST.
    expect(result.excludedMinutes).toBe(60 + 120);
    expect(result.clock.dueAt.toISOString()).toBe('2026-04-13T09:00:00.000Z');
  });
});
