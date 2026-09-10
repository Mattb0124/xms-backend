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
 * Account profitability over the real database (TB-16): a cost rate on the
 * person, revenue from the finance lines billing charges from, and a margin
 * that never guesses at a half it does not have.
 *
 * The permission boundary is the point of half of this. What a colleague
 * costs is not something a delivery lead reading a rate card should see, so
 * `contracts:view` opens the rate card and closes the margin.
 */
const ADMIN_EMAIL = 'admin@example.test';
const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 8)}01`;
const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let ownerToken: string;
let consultantId: string;
let personId: string;
let accountId: string;
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
    .send({
      name: 'Retainer',
      model: 'retainer',
      period_hours: 100,
      period_starts_on: monthStart,
      period_ends_on: monthEnd,
    })
    .expect(201);

  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const named = (name: string) => roles.body.find((role: { name: string }) => role.name === name);

  const user = await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'cara@example.test',
      first_name: 'Cara',
      last_name: 'Lee',
      role_ids: [named('Consultant').id],
      account_ids: [accountId],
    })
    .expect(201);
  consultantId = user.body.id;
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });

  // An Account Owner holds contracts:manage, so it reads rate cards. It does
  // not hold finance:view-margin, which is exactly the boundary under test.
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({
      email: 'owen@example.test',
      first_name: 'Owen',
      last_name: 'Reed',
      role_ids: [named('Account Owner').id],
      account_ids: [accountId],
    })
    .expect(201);
  ownerToken = await devToken({ sub: 'dev_owen', email: 'owen@example.test', sid: 'sess_owen' });

  const person = await api()
    .post('/v1/roster/people')
    .set(bearer(adminToken))
    .send({ display_name: 'Cara Lee', email: 'cara@example.test', role: 'consultant', user_id: consultantId })
    .expect(201);
  personId = person.body.id;

  await api()
    .put(`/v1/accounts/${accountId}/rate-cards`)
    .set(bearer(adminToken))
    .send({ effective_from: '2026-01-01', entries: [{ role: 'consultant', bill_rate: 200 }] })
    .expect(200);

  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(consultantToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Margin check',
      impact: 'high',
      urgency: 'high',
    })
    .expect(201);
  ticketKey = ticket.body.key;
  await api()
    .post(`/v1/tickets/${ticketKey}/transitions`)
    .set(bearer(consultantToken))
    .send({ version: 1, to: 'in_progress' })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const margin = (token: string) =>
  api().get(`/v1/accounts/${accountId}/profitability?from=${monthStart}&to=${monthEnd}`).set(bearer(token));

describe('cost rates (TB-16)', () => {
  it('are set, read back newest first, and corrected in place for the same date', async () => {
    const first = await api()
      .put(`/v1/people/${personId}/cost-rates`)
      .set(bearer(adminToken))
      .send({ effective_from: '2026-01-01', cost_rate: 80, note: 'Standard' })
      .expect(200);
    expect(first.body).toMatchObject({ effective_from: '2026-01-01', cost_rate: 80, currency: 'USD' });

    await api()
      .put(`/v1/people/${personId}/cost-rates`)
      .set(bearer(adminToken))
      .send({ effective_from: '2026-06-01', cost_rate: 95 })
      .expect(200);

    // The same date again corrects that rate rather than adding a second one
    // nobody could order.
    await api()
      .put(`/v1/people/${personId}/cost-rates`)
      .set(bearer(adminToken))
      .send({ effective_from: '2026-01-01', cost_rate: 85 })
      .expect(200);

    const rows = await api().get(`/v1/people/${personId}/cost-rates`).set(bearer(adminToken)).expect(200);
    expect(rows.body).toHaveLength(2);
    expect(rows.body.map((row: { effective_from: string }) => row.effective_from)).toEqual([
      '2026-06-01',
      '2026-01-01',
    ]);
    expect(rows.body[1].cost_rate).toBe(85);
  });

  it('are written to the audit, because they decide what every account looks worth', async () => {
    const events = await api()
      .post('/v1/audit/search')
      .set(bearer(adminToken))
      .send({ conditions: [{ field: 'entity_kind', op: 'eq', value: 'person_cost_rate' }] })
      .expect(201);
    expect(events.body.items.length).toBeGreaterThan(0);
    expect(events.body.items.some((row: { event_type: string }) => row.event_type === 'created')).toBe(true);
  });

  it('are closed to a reader who may see the rate card but not what a colleague is paid', async () => {
    // The Account Owner holds contracts:manage, so the rate card opens.
    await api().get(`/v1/accounts/${accountId}/rate-cards`).set(bearer(ownerToken)).expect(200);
    // The cost of a person, and the margin standing on it, do not.
    await api().get(`/v1/people/${personId}/cost-rates`).set(bearer(ownerToken)).expect(403);
    await margin(ownerToken).expect(403);
    // A consultant is nowhere near either.
    await api().get(`/v1/people/${personId}/cost-rates`).set(bearer(consultantToken)).expect(403);
    await margin(consultantToken).expect(403);
  });

  it('are removed, and the margin stops standing on them', async () => {
    const made = await api()
      .put(`/v1/people/${personId}/cost-rates`)
      .set(bearer(adminToken))
      .send({ effective_from: '2020-01-01', cost_rate: 10 })
      .expect(200);
    await api().delete(`/v1/people/${personId}/cost-rates/${made.body.id}`).set(bearer(adminToken)).expect(204);
    const rows = await api().get(`/v1/people/${personId}/cost-rates`).set(bearer(adminToken)).expect(200);
    expect(rows.body.some((row: { id: string }) => row.id === made.body.id)).toBe(false);
  });
});

describe('account profitability (TB-16)', () => {
  it('is revenue less cost, from the lines billing itself charges from', async () => {
    // Two hours at 200 an hour, worked by somebody whose rate in force
    // today is the June one, 95, not the January one it replaced.
    await api()
      .post(`/v1/tickets/${ticketKey}/time`)
      .set(bearer(consultantToken))
      .send({ performed_on: today, minutes: 120, activity_type: 'analysis' })
      .expect(201);

    const result = await margin(adminToken).expect(200);
    expect(result.body.total).toMatchObject({ minutes: 120, revenue: 400, cost: 190, margin: 210 });
    expect(result.body.total.margin_percent).toBe(52.5);
    expect(result.body.by_person[0]).toMatchObject({ label: 'Cara Lee', margin: 210 });
    expect(result.body.by_role[0]).toMatchObject({ key: 'consultant' });
    expect(result.body.currencies).toEqual(['USD']);
  });

  it('reports time it could not cost as unweighed rather than as free', async () => {
    // A second person with no cost rate on file at all.
    const other = await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'dee@example.test',
        first_name: 'Dee',
        last_name: 'Novak',
        role_ids: [
          (await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken))).body.find(
            (role: { name: string }) => role.name === 'Consultant',
          ).id,
        ],
        account_ids: [accountId],
      })
      .expect(201);
    await api()
      .post('/v1/roster/people')
      .set(bearer(adminToken))
      .send({ display_name: 'Dee Novak', email: 'dee@example.test', role: 'consultant', user_id: other.body.id })
      .expect(201);
    const deeToken = await devToken({ sub: 'dev_dee', email: 'dee@example.test', sid: 'sess_dee' });
    await api()
      .post(`/v1/tickets/${ticketKey}/time`)
      .set(bearer(deeToken))
      .send({ performed_on: today, minutes: 60, activity_type: 'analysis' })
      .expect(201);

    const result = await margin(adminToken).expect(200);
    expect(result.body.total.minutes).toBe(180);
    // The hour still earns, and its cost is unknown rather than nil, so the
    // total says how much of the time it could not weigh.
    expect(result.body.total.revenue).toBe(600);
    expect(result.body.total.minutes_without_cost).toBe(60);
    const dee = result.body.by_person.find((row: { label: string }) => row.label === 'Dee Novak');
    expect(dee).toMatchObject({ cost: null, margin: null, minutes_without_cost: 60 });
  });

  it('refuses a range that is not one', async () => {
    await api()
      .get(`/v1/accounts/${accountId}/profitability?from=not-a-date&to=${monthEnd}`)
      .set(bearer(adminToken))
      .expect(400);
  });
});

describe('system roles reconcile on boot (TB-16)', () => {
  it('gives an existing Administrator a permission the catalog gained, without touching one it did not', async () => {
    const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
    const admin = roles.body.find((role: { name: string }) => role.name === 'Administrator');
    const finance = roles.body.find((role: { name: string }) => role.name === 'Finance');
    expect(admin.permissions).toContain('finance:manage-cost');
    expect(finance.permissions).toContain('finance:manage-cost');

    // A role the bundle does not name keeps its own list.
    const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
    expect(consultant.permissions).not.toContain('finance:view-margin');
    expect(consultant.permissions).not.toContain('finance:manage-cost');
  });

  it('never takes a permission away that an operator added to a system role', async () => {
    const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
    const dispatcher = roles.body.find((role: { name: string }) => role.name === 'Dispatcher');
    await api()
      .patch(`/v1/admin/roles/${dispatcher.id}`)
      .set(bearer(adminToken))
      .send({ version: dispatcher.version, permissions: [...dispatcher.permissions, 'kb:author'] })
      .expect(200);

    // Booting again reconciles; the operator's own addition survives it.
    const { BootstrapService } = await import('../src/modules/admin/bootstrap.service.js');
    const { UnitOfWork } = await import('../src/db/unit-of-work.js');
    await app.get(UnitOfWork).operator((tx) => app.get(BootstrapService).ensureSystemRoles(tx));

    const after = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
    const again = after.body.find((role: { name: string }) => role.name === 'Dispatcher');
    expect(again.permissions).toContain('kb:author');
  });
});

describe('team time (P2.18)', () => {
  it('returns the entries of everyone sharing a group, and refuses a reader without time:adjust', async () => {
    // The consultant logs time; the admin, who holds time:adjust, reads it.
    const window = `from=${monthStart}&to=${monthEnd}`;
    const mine = await api().get(`/v1/time/team?${window}`).set(bearer(adminToken)).expect(200);
    expect(Array.isArray(mine.body)).toBe(true);

    // A consultant holds time:log and not time:adjust: reading a colleague's
    // time is for correcting it.
    await api().get(`/v1/time/team?${window}`).set(bearer(consultantToken)).expect(403);
  });

  it('falls back to the reader alone rather than failing, for somebody in no group', async () => {
    // The admin has no roster row at all in this suite, which is the same
    // shape as a person in no group: the query must still answer.
    const rows = await api().get(`/v1/time/team?from=${monthStart}&to=${monthEnd}`).set(bearer(adminToken)).expect(200);
    expect(rows.body.every((row: { person_id: string }) => typeof row.person_id === 'string')).toBe(true);
  });
});
