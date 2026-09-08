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
import { weekBounds } from '../src/domain/time/unlogged.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * "Waiting on me" for the My work rail (User Experience 3.1): per-person
 * counts of what the signed-in user must act on, each with a link. Every
 * count is bound to the principal, so one person's rail never shows
 * another's work and a foreign account contributes nothing.
 */
const ADMIN_EMAIL = 'admin@example.test';
const today = new Date().toISOString().slice(0, 10);

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let strangerToken: string;
let adminId: string;
let consultantId: string;
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
  for (const id of [accountId, otherAccountId]) {
    await api()
      .post(`/v1/accounts/${id}/contracts`)
      .set(bearer(adminToken))
      .send({ name: 'Support retainer', model: 'retainer', period_hours: 40 })
      .expect(201);
  }
  // The administrator owns Brookfield: out-of-scope flags and unclaimed
  // report reviews on it are theirs to act on.
  const current = await api().get(`/v1/admin/accounts/${accountId}`).set(bearer(adminToken)).expect(200);
  await api()
    .patch(`/v1/admin/accounts/${accountId}`)
    .set(bearer(adminToken))
    .send({ version: current.body.version, owner_user_id: adminId })
    .expect(200);

  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  const invited = await api()
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
  consultantId = invited.body.id;
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'sam@example.test',
      first_name: 'Sam',
      last_name: 'Okafor',
      role_ids: [consultant.id],
      account_ids: [accountId],
    })
    .expect(201);
  strangerToken = await devToken({ sub: 'dev_sam', email: 'sam@example.test', sid: 'sess_sam' });
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function waiting(token: string): Promise<Record<string, { count: number; link?: string; label: string }>> {
  const response = await api().get('/v1/me/waiting').set(bearer(token)).expect(200);
  expect(response.body.as_of).toBe(today);
  const items: { key: string; label: string; count: number; link?: string }[] = response.body.items;
  return Object.fromEntries(items.map((item) => [item.key, item]));
}

describe('GET /v1/me/waiting', () => {
  it('answers every internal person with the seven counts, at zero when nothing is waiting', async () => {
    const rail = await waiting(strangerToken);
    expect(Object.keys(rail).sort()).toEqual([
      'articles_in_review',
      'csat_low_scores',
      'pending_time',
      'report_reviews',
      'scope_approvals',
      'tickets_assigned',
      'unread_notifications',
    ]);
    for (const key of [
      'tickets_assigned',
      'scope_approvals',
      'articles_in_review',
      'report_reviews',
      'csat_low_scores',
    ])
      expect(rail[key].count, key).toBe(0);
    expect(rail.tickets_assigned.link).toBe('/tickets?view=mine');
    expect(rail.tickets_assigned.label).toBe('Tickets assigned to me');
  });

  /**
   * Every address the rail answers is a route the web application registers
   * (frontend/lib/routes.ts) written in that application's own URL grammar,
   * so the browser follows it as it stands. The rail used to answer
   * `/queue`, `/timesheet`, `/reports/runs` and `/notifications`, none of
   * which the desk serves, and the browser had to translate every one.
   */
  it('links only to addresses the web application serves, and leaves the bell without one', async () => {
    const rail = await waiting(strangerToken);
    expect(rail.tickets_assigned.link).toBe('/tickets?view=mine');
    expect(rail.scope_approvals.link).toBe('/tickets');
    expect(rail.articles_in_review.link).toBe('/knowledge?status=in_review');
    expect(rail.pending_time.link).toBe('/time');
    // Nothing is waiting for this person, so the two account-scoped rows
    // fall back to their list screens rather than naming an account.
    expect(rail.report_reviews.link).toBe('/reports');
    expect(rail.csat_low_scores.link).toBe('/accounts');
    // The bell is in the shell on every page, so there is no screen to open.
    expect(rail.unread_notifications.link).toBeUndefined();
    // No row keeps one of the addresses the desk never served.
    for (const item of Object.values(rail))
      expect(item.link ?? '/tickets', item.label).toMatch(/^\/(tickets|knowledge|time|reports|accounts|admin)\b/);
  });

  it('counts tickets assigned to me and leaves out the ones waiting on the client or closed', async () => {
    const created = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: accountId, type: 'incident', short_description: 'Consolidation fails' })
      .expect(201);
    ticketKey = created.body.key;
    expect((await waiting(consultantToken)).tickets_assigned.count).toBe(0);
    const assigned = await api()
      .patch(`/v1/tickets/${ticketKey}`)
      .set(bearer(adminToken))
      .send({ version: created.body.version, assignee_id: consultantId })
      .expect(200);
    expect(assigned.body.assignee_id).toBe(consultantId);
    expect((await waiting(consultantToken)).tickets_assigned.count).toBe(1);

    // Paused on the client: no longer waiting on the consultant.
    const progressed = await api()
      .post(`/v1/tickets/${ticketKey}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: assigned.body.version, to: 'in_progress' })
      .expect(201);
    expect((await waiting(consultantToken)).tickets_assigned.count).toBe(1);
    await api()
      .post(`/v1/tickets/${ticketKey}/transitions`)
      .set(bearer(consultantToken))
      .send({
        version: progressed.body.version,
        to: 'awaiting_client',
        pause_reason: 'awaiting_client',
        note: 'Waiting for the client file',
      })
      .expect(201);
    expect((await waiting(consultantToken)).tickets_assigned.count).toBe(0);
    // Someone else's ticket never reaches my rail.
    expect((await waiting(strangerToken)).tickets_assigned.count).toBe(0);
  });

  it('counts out-of-scope flags on the accounts I own, for the owner only', async () => {
    // Nothing writes acct.tickets.out_of_scope yet (0004 carries the column
    // and tickets:approve-scope names the action); the fixture sets the flag
    // the way the approval flow will.
    await withSuperuser(async (client) => {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(`update acct.tickets set out_of_scope = 'flagged' where account_id = $1`, [accountId]);
      await client.query('commit');
    });
    expect((await waiting(adminToken)).scope_approvals.count).toBe(1);
    // Cara works the ticket but does not own the account.
    expect((await waiting(consultantToken)).scope_approvals.count).toBe(0);
  });

  it('counts the articles I authored that are sitting in review', async () => {
    const draft = await api()
      .post('/v1/articles')
      .set(bearer(consultantToken))
      .send({
        account_id: accountId,
        title: 'Consolidation certificate renewal',
        problem_statement: 'The consolidation report returns error 500',
        steps: 'Renew the certificate and restart the service.',
      })
      .expect(201);
    expect((await waiting(consultantToken)).articles_in_review.count).toBe(0);
    await api()
      .post(`/v1/articles/${draft.body.display_key}/submit`)
      .set(bearer(consultantToken))
      .send({ version: draft.body.version })
      .expect(201);
    expect((await waiting(consultantToken)).articles_in_review.count).toBe(1);
    // The review queue of an article is its author's, not everyone's.
    expect((await waiting(strangerToken)).articles_in_review.count).toBe(0);
  });

  it('counts report runs that name me as reviewer and the unclaimed ones on an account I own', async () => {
    await withSuperuser((client) =>
      client.query(
        `insert into acct.report_runs (account_id, pack_type, period_start, period_end, status, reviewer_id, requested_by)
         values ($1, 'wsr', current_date - 7, current_date - 1, 'awaiting_review', $2, $2),
                ($1, 'wsr', current_date - 14, current_date - 8, 'awaiting_review', null, $2),
                ($3, 'wsr', current_date - 7, current_date - 1, 'awaiting_review', null, $2),
                ($1, 'wsr', current_date - 21, current_date - 15, 'sent', null, $2)`,
        [accountId, adminId, otherAccountId],
      ),
    );
    // One naming the administrator, one unclaimed on the account they own;
    // the unclaimed run on Austral and the sent run count for nobody.
    const admin = await waiting(adminToken);
    expect(admin.report_reviews.count).toBe(2);
    // The runs live on the account record's Report packs tab.
    expect(admin.report_reviews.link).toBe(`/admin/accounts/${accountId}?tab=reports`);
    const cara = await waiting(consultantToken);
    expect(cara.report_reviews.count).toBe(0);
    expect(cara.report_reviews.link).toBe('/reports');
  });

  it('counts my unread notifications, and the low satisfaction scores among them separately', async () => {
    await withSuperuser((client) =>
      client.query(
        `insert into acct.notifications (account_id, recipient_id, type, title, target_kind, target_id)
         values ($1, $2, 'csat.low_score', 'Low satisfaction score (2 of 5) on TK00001', 'ticket', $3),
                ($1, $2, 'ticket.assigned', 'A ticket was assigned to you', 'ticket', $3),
                ($1, $4, 'csat.low_score', 'Low satisfaction score (1 of 5) on TK00002', 'ticket', $3)`,
        [accountId, adminId, ticketKey, consultantId],
      ),
    );
    const admin = await waiting(adminToken);
    // The rail and the bell answer the same number.
    const bell = await api().get('/v1/notifications/unread-count').set(bearer(adminToken)).expect(200);
    expect(admin.unread_notifications.count).toBe(bell.body.count);
    expect(admin.unread_notifications.count).toBeGreaterThanOrEqual(2);
    expect(admin.csat_low_scores.count).toBe(1);
    // The scores and their comments live on the account's Satisfaction tab.
    expect(admin.csat_low_scores.link).toBe(`/accounts/${accountId}?tab=satisfaction`);
    // The low score routed to Cara is hers alone, and the administrator's is his.
    const cara = await waiting(consultantToken);
    expect(cara.csat_low_scores.count).toBe(1);
    expect(cara.unread_notifications.count).toBeGreaterThanOrEqual(1);
  });

  it('counts the days this week with unlogged time, agreeing with the timesheet', async () => {
    const rail = await waiting(consultantToken);
    // The timesheet screen opens on the current week and takes no week
    // parameter, so the rail links to it plainly; the count is still the
    // one the timesheet route answers for the same week.
    expect(rail.pending_time.link).toBe('/time');
    const monday = weekBounds(today).from;
    const unlogged = await api()
      .get(`/v1/timesheets/me/unlogged?from=${monday}&to=${today}`)
      .set(bearer(consultantToken))
      .expect(200);
    const days: { unlogged_minutes: number }[] = unlogged.body.days;
    expect(rail.pending_time.count).toBe(days.filter((day) => day.unlogged_minutes > 0).length);
    expect(rail.pending_time.label).toBe('Days this week with unlogged time');
  });

  it('is refused to a principal without tickets:view', async () => {
    // A portal user is in the wrong realm for an internal route entirely.
    await api().get('/v1/me/waiting').expect(401);
  });
});
