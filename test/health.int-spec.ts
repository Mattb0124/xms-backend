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
import { HEALTH_WEIGHTS } from '../src/domain/reporting/health.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The account health score (DR-09). One account is seeded so that every
 * factor the spec names has something to say: resolution targets met and
 * missed, work that came back, satisfaction scores, time against a contract
 * period and portal sign-ins. A second account is left untouched, because a
 * score composed from nothing must say so rather than read as a bad one.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let quietAccountId: string;
let contractId: string;
const ticketIds: string[] = [];

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * An update to an audited table with the audit row the constraint trigger
 * insists on, in the same transaction. Seeding a breach or a reopen by hand
 * is the only way to put those shapes in front of the score without walking
 * a ticket through the whole close discipline.
 */
async function seededUpdate(statements: { text: string; values: unknown[] }[]): Promise<void> {
  await withSuperuser(async (client) => {
    await client.query('begin');
    for (const statement of statements) await client.query(statement.text, statement.values);
    await client.query(
      `insert into acct.audit_events (account_id, entity_kind, entity_id, event_type, actor_kind, actor_id)
       values ($1, 'ticket', 'seed', 'imported', 'system', 'test-seed')`,
      [accountId],
    );
    await client.query('commit');
    return undefined;
  });
}

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
  const quiet = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'QUI', name: 'Quiet Co' })
    .expect(201);
  quietAccountId = quiet.body.id;
  await api().post(`/v1/admin/accounts/${quietAccountId}/activate`).set(bearer(adminToken)).expect(201);

  // A ten-hour retainer over a period that is running now, so the budget
  // factor has a calendar to be measured against.
  const contract = await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({
      name: 'Retainer',
      model: 'retainer',
      period_hours: 10,
      period_starts_on: day(-15),
      period_ends_on: day(15),
    })
    .expect(201);
  contractId = contract.body.id;

  for (const description of ['Met on time', 'Missed the target', 'Came back once', 'Still open']) {
    const ticket = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: accountId, type: 'incident', short_description: description })
      .expect(201);
    ticketIds.push(ticket.body.id);
  }

  // Three of the four are resolved inside the window: two met their
  // resolution target, one missed it, and one of the two that met it came
  // back after it was resolved.
  await seededUpdate([
    {
      text: `update acct.tickets set state = 'resolved', resolved_at = now() - interval '2 days' where id = any ($1::uuid[])`,
      values: [ticketIds.slice(0, 3)],
    },
    {
      text: `update acct.tickets set sla_resolution_breached = true where id = $1`,
      values: [ticketIds[1]],
    },
    {
      text: `update acct.tickets set reopen_count = 1 where id = $1`,
      values: [ticketIds[2]],
    },
    {
      // Whether or not the account's policy gave these tickets a clock,
      // the two that met their resolution target say so.
      text: `insert into acct.sla_clocks (account_id, ticket_id, kind, policy_ref, target_minutes, started_at, due_at, met_at)
             select $2, t.id, 'resolution', 'seed', 480, now() - interval '3 days', now() - interval '1 day', now() - interval '2 days'
               from acct.tickets t where t.id = any ($1::uuid[])
             on conflict (ticket_id, kind) do update set met_at = excluded.met_at`,
      values: [[ticketIds[0], ticketIds[2]], accountId],
    },
  ]);

  // Five hours of billable time against the ten-hour period: half of it
  // consumed, whatever share of the calendar has run.
  await withSuperuser((client) =>
    client.query(
      `insert into acct.time_entries (account_id, ticket_id, contract_id, person_id, person_name, performed_on, minutes, activity_type, billable_class, created_by)
       values ($1, $2, $3, 'seed-person', 'Ada Byron', current_date, 300, 'analysis', 'billable', 'seed')`,
      [accountId, ticketIds[3], contractId],
    ),
  );

  // Two closed-request surveys, both answered, scoring five and four.
  await withSuperuser(async (client) => {
    const contact = await client.query<{ id: string }>(
      `insert into acct.contacts (account_id, email, display_name) values ($1, 'rita@client.test', 'Rita Reed') returning id`,
      [accountId],
    );
    for (const [index, score] of [5, 4].entries()) {
      const survey = await client.query<{ id: string }>(
        `insert into acct.csat_surveys (account_id, kind, ticket_id, contact_id, token_hash, status, sent_at, answered_at)
         values ($1, 'ticket_close', $2, $3, $4, 'answered', now() - interval '3 days', now() - interval '2 days') returning id`,
        [accountId, ticketIds[index], contact.rows[0].id, `hash-${index}`],
      );
      await client.query(
        `insert into acct.csat_responses (account_id, survey_id, answers, created_at)
         values ($1, $2, $3::jsonb, now() - interval '2 days')`,
        [accountId, survey.rows[0].id, JSON.stringify({ score })],
      );
    }
    return undefined;
  });

  // The portal is on and the client uses it: thirteen sign-ins over the
  // ninety-day window is more than the once a week the score asks for.
  await seededUpdate([
    { text: 'update acct.account_settings set portal_enabled = true where account_id = $1', values: [accountId] },
  ]);
  await withSuperuser((client) =>
    client.query(
      `insert into sys.security_events (occurred_at, event_type, account_id, actor_kind, actor_id, principal_kind, outcome)
       select now() - (n * interval '2 days'), 'auth.signin.success', $1, 'portal_user', 'rita', 'portal', 'success'
         from generate_series(1, 13) as n`,
      [accountId],
    ),
  );
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const factorOf = (body: { factors: { key: string }[] }, key: string) =>
  body.factors.find((row) => row.key === key) as {
    key: string;
    label: string;
    weight: number;
    score: number | null;
    contribution: number;
    detail: Record<string, number | boolean | null>;
  };

describe('account health (DR-09)', () => {
  it('scores every factor the spec names, with the numbers behind each one', async () => {
    const response = await api().get(`/v1/accounts/${accountId}/health`).set(bearer(adminToken)).expect(200);
    expect(response.body.account_id).toBe(accountId);
    expect(response.body.window.days).toBe(90);
    expect(response.body.measured_weight).toBe(100);
    expect(response.body.factors.map((row: { key: string }) => row.key)).toEqual(Object.keys(HEALTH_WEIGHTS));

    // Two of the three resolution targets that came due were met.
    const sla = factorOf(response.body, 'sla_resolution');
    expect(sla.detail).toMatchObject({ met: 2, due: 3, attainment_percent: 66.7 });
    expect(sla.score).toBe(66.7);
    expect(sla.weight).toBe(30);

    // One of the three resolved requests came back.
    const reopen = factorOf(response.body, 'reopen_rate');
    expect(reopen.detail).toMatchObject({ reopened: 1, resolved: 3 });
    // A third of the resolved work coming back is past the floor of a quarter.
    expect(reopen.score).toBe(0);

    const csat = factorOf(response.body, 'csat');
    expect(csat.detail).toMatchObject({ mean_score: 4.5, responses: 2 });
    expect(csat.score).toBe(87.5);

    // Five of the ten contracted hours are gone.
    const budget = factorOf(response.body, 'budget');
    expect(budget.detail).toMatchObject({ available_minutes: 600, consumed_minutes: 300, percent_consumed: 50 });
    expect(budget.score).not.toBeNull();

    const engagement = factorOf(response.body, 'engagement');
    expect(engagement.detail).toMatchObject({
      portal_enabled: true,
      portal_signins: 13,
      surveys_sent: 2,
      surveys_answered: 2,
    });
    expect(engagement.score).toBe(100);

    expect(response.body.score).toBeGreaterThan(0);
    expect(response.body.score).toBeLessThanOrEqual(100);
    expect(['green', 'amber', 'red']).toContain(response.body.band);
    // The contributions of the measured factors add up to the score itself.
    const total = response.body.factors.reduce(
      (sum: number, row: { contribution: number }) => sum + row.contribution,
      0,
    );
    expect(Math.abs(total - response.body.score)).toBeLessThan(1);
  });

  it('rates an account with nothing to go on as unrated rather than bad', async () => {
    const response = await api().get(`/v1/accounts/${quietAccountId}/health`).set(bearer(adminToken)).expect(200);
    expect(response.body).toMatchObject({ score: null, band: 'unrated', measured_weight: 0 });
    expect(response.body.factors.every((row: { score: number | null }) => row.score === null)).toBe(true);
  });

  it('takes the window from the query and moves the numbers with it', async () => {
    const narrow = await api().get(`/v1/accounts/${accountId}/health?days=1`).set(bearer(adminToken)).expect(200);
    expect(narrow.body.window.days).toBe(1);
    // Nothing was resolved and nothing was scored yesterday, so those two
    // factors drop out and the rest carry the score.
    expect(factorOf(narrow.body, 'sla_resolution').score).toBeNull();
    expect(factorOf(narrow.body, 'csat').score).toBeNull();
    expect(narrow.body.measured_weight).toBeLessThan(100);
  });

  it('puts the same score on the Operations strip, and refuses an account the reader is not granted', async () => {
    const dashboard = await api().get('/v1/dashboards/operations').set(bearer(adminToken)).expect(200);
    const strip = dashboard.body.per_account.find((row: { account_id: string }) => row.account_id === accountId);
    expect(strip.health.measured_weight).toBeGreaterThan(0);
    expect(['green', 'amber', 'red']).toContain(strip.health.band);
    expect(strip.health.factors.map((row: { key: string }) => row.key)).toEqual(Object.keys(HEALTH_WEIGHTS));

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
        account_ids: [quietAccountId],
      })
      .expect(201);
    const consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
    await api().get(`/v1/accounts/${quietAccountId}/health`).set(bearer(consultantToken)).expect(200);
    const refused = await api().get(`/v1/accounts/${accountId}/health`).set(bearer(consultantToken)).expect(404);
    expect(refused.body).toMatchObject({ code: 'not_found', entity: 'account' });
    await api().get(`/v1/accounts/${accountId}/health`).expect(401);
  });
});
