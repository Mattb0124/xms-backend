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
 * Budget rules over the real database (TB-05, TB-07 to TB-09, TB-11): a
 * versioned rate card freezes the rate and amount on the entry, thresholds
 * fire once per period with a notification and an audit row, the overage
 * rule blocks or flags, the budget view carries position and forecast, and
 * the rollover rule computes the carry-over of a new period.
 */
const ADMIN_EMAIL = 'admin@example.test';
const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 8)}01`;
const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let consultantId: string;
let accountId: string;
let contractId: string;
let contractVersion: number;
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

  // A ten-hour retainer for this month, flagged over budget, thresholds at 50 and 100.
  const contract = await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({
      name: 'Retainer',
      model: 'retainer',
      period_hours: 10,
      period_starts_on: monthStart,
      period_ends_on: monthEnd,
      threshold_percents: [50, 100],
      overage_rule: 'allow_flag',
      rollover_rule: 'carry_month',
    })
    .expect(201);
  contractId = contract.body.id;
  contractVersion = contract.body.version;
  expect(contract.body).toMatchObject({
    threshold_percents: [50, 100],
    overage_rule: 'allow_flag',
    rollover_rule: 'carry_month',
    forecast_window_days: 10,
  });

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
  consultantId = user.body.id;
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  // The roster knows Cara as a consultant: the rate lookup keys on that role.
  await api()
    .post('/v1/roster/people')
    .set(bearer(adminToken))
    .send({ display_name: 'Cara Lee', email: 'cara@example.test', role: 'consultant', user_id: consultantId })
    .expect(201);

  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(consultantToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Budget check',
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

function log(minutes: number, extra: Record<string, unknown> = {}) {
  return api()
    .post(`/v1/tickets/${ticketKey}/time`)
    .set(bearer(consultantToken))
    .send({ performed_on: today, minutes, activity_type: 'analysis', ...extra });
}

describe('rate cards (TB-05)', () => {
  it('a new version per effective date, never edited; the same date twice is a conflict', async () => {
    const card = await api()
      .put(`/v1/accounts/${accountId}/rate-cards`)
      .set(bearer(adminToken))
      .send({ effective_from: '2026-01-01', entries: [{ role: 'consultant', bill_rate: 150, overage_rate: 200 }] })
      .expect(200);
    expect(card.body).toMatchObject({
      contract_id: null,
      effective_from: '2026-01-01',
      currency: 'USD',
      entries: [{ role: 'consultant', bill_rate: 150, overage_rate: 200 }],
    });
    const again = await api()
      .put(`/v1/accounts/${accountId}/rate-cards`)
      .set(bearer(adminToken))
      .send({ effective_from: '2026-01-01', entries: [{ role: 'consultant', bill_rate: 999 }] })
      .expect(409);
    expect(again.body.code).toBe('rate_card_exists');
    const dupe = await api()
      .put(`/v1/accounts/${accountId}/rate-cards`)
      .set(bearer(adminToken))
      .send({
        effective_from: '2026-02-01',
        entries: [
          { role: 'consultant', bill_rate: 1 },
          { role: 'consultant', bill_rate: 2 },
        ],
      })
      .expect(400);
    expect(dupe.body.code).toBe('duplicate_role');
    await api()
      .put(`/v1/accounts/${accountId}/rate-cards`)
      .set(bearer(consultantToken))
      .send({ effective_from: '2026-03-01', entries: [{ role: 'consultant', bill_rate: 1 }] })
      .expect(403);
    // Rate cards are commercial: reading them needs contracts:view, which
    // a consultant does not hold (finding 22).
    await api().get(`/v1/accounts/${accountId}/rate-cards`).set(bearer(consultantToken)).expect(403);
    const listed = await api().get(`/v1/accounts/${accountId}/rate-cards`).set(bearer(adminToken)).expect(200);
    expect(listed.body).toHaveLength(1);
  });

  it('freezes the rate and the amount on the entry', async () => {
    const entry = await log(90).expect(201);
    expect(entry.body).toMatchObject({ rate_snapshot: '150.00', amount: '225.00', over_budget: false });
  });
});

describe('thresholds (TB-09)', () => {
  it('fires once per period with an event, a notification for the account owners and an audit row', async () => {
    // 90 of 600 minutes so far; 240 more crosses 50 percent.
    const entry = await log(240).expect(201);
    expect(entry.body.over_budget).toBe(false);
    const events = await withSuperuser((client) =>
      client.query(
        `select percent, consumed_minutes_at_fire, available_minutes from acct.threshold_alert_events where contract_id = $1 order by percent`,
        [contractId],
      ),
    );
    expect(events.rows).toEqual([{ percent: 50, consumed_minutes_at_fire: 330, available_minutes: 600 }]);
    const periods = await api()
      .get(`/v1/accounts/${accountId}/contracts/${contractId}/periods`)
      .set(bearer(adminToken))
      .expect(200);
    expect(periods.body[0].thresholds_fired).toEqual([50]);
    const feed = await api().get('/v1/notifications').set(bearer(adminToken)).expect(200);
    const items = Array.isArray(feed.body) ? feed.body : feed.body.items;
    expect(items.some((row: { type: string }) => row.type === 'budget.threshold')).toBe(true);
    const audit = await withSuperuser((client) =>
      client.query(
        `select new_value from acct.audit_events where account_id = $1 and event_type = 'budget.threshold_crossed'`,
        [accountId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].new_value.percents).toEqual([50]);
    // Logging more inside the same band fires nothing new.
    await log(30).expect(201);
    const after = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from acct.threshold_alert_events where contract_id = $1`, [contractId]),
    );
    expect(after.rows[0].n).toBe(1);
  });
});

describe('overage (TB-11)', () => {
  it('allow_flag saves the entry over budget at the overage rate; block refuses', async () => {
    // 360 consumed; 300 more crosses 100 percent and goes 60 over.
    const flagged = await log(300).expect(201);
    expect(flagged.body).toMatchObject({ over_budget: true, rate_snapshot: '200.00', amount: '1000.00' });
    const fired = await withSuperuser((client) =>
      client.query(`select percent from acct.threshold_alert_events where contract_id = $1 order by percent`, [
        contractId,
      ]),
    );
    expect(fired.rows.map((row) => row.percent)).toEqual([50, 100]);
    const patched = await api()
      .patch(`/v1/accounts/${accountId}/contracts/${contractId}`)
      .set(bearer(adminToken))
      .send({ version: contractVersion, overage_rule: 'block' })
      .expect(200);
    contractVersion = patched.body.version;
    const blocked = await log(15).expect(409);
    expect(blocked.body).toMatchObject({ code: 'overage_blocked', available_minutes: 600, consumed_minutes: 660 });
    const rated = await api()
      .patch(`/v1/accounts/${accountId}/contracts/${contractId}`)
      .set(bearer(adminToken))
      .send({ version: contractVersion, overage_rule: 'allow_rate' })
      .expect(400);
    expect(rated.body.code).toBe('multiplier_required');
    const ok = await api()
      .patch(`/v1/accounts/${accountId}/contracts/${contractId}`)
      .set(bearer(adminToken))
      .send({ version: contractVersion, overage_rule: 'allow_rate', overage_multiplier: 1.25 })
      .expect(200);
    contractVersion = ok.body.version;
    const atRate = await log(60).expect(201);
    expect(atRate.body).toMatchObject({ over_budget: true, rate_multiplier: '1.250', rate_snapshot: '200.00' });
    expect(Number(atRate.body.amount)).toBe(250);
  });
});

describe('budget view (TB-07, TB-08)', () => {
  it('carries position, forecast, thresholds and the unrated figure per contract', async () => {
    await api().get(`/v1/accounts/${accountId}/budget`).set(bearer(consultantToken)).expect(403);
    const view = await api().get(`/v1/accounts/${accountId}/budget`).set(bearer(adminToken)).expect(200);
    expect(view.body.as_of).toBe(today);
    expect(view.body.contracts).toHaveLength(1);
    const card = view.body.contracts[0];
    expect(card.contract).toMatchObject({ id: contractId, overage_rule: 'allow_rate' });
    expect(card.position).toMatchObject({ available_minutes: 600, consumed_minutes: 720, status: 'over' });
    expect(card.forecast.business_days_total).toBeGreaterThan(0);
    expect(card.forecast.forecast_minutes).toBeGreaterThanOrEqual(720);
    expect(card.forecast.business_days_to_exhaustion).toBe(0);
    expect(card.thresholds).toMatchObject({ percents: [50, 100], fired: [50, 100], next_percent: null });
    expect(card.thresholds.events).toHaveLength(2);
    expect(card.unrated_minutes).toBe(0);
    const entries = await api()
      .get(
        `/v1/accounts/${accountId}/budget/entries?contract=${contractId}&person=${consultantId}&from=${monthStart}&to=${monthEnd}`,
      )
      .set(bearer(adminToken))
      .expect(200);
    expect(entries.body.total_minutes).toBe(720);
    expect(entries.body.total_amount).toBe(225 + 600 + 75 + 1000 + 250);
    expect(entries.body.entries.every((row: { contract_key: string }) => row.contract_key.startsWith('CT'))).toBe(true);
  });
});

describe('contract position on the ticket record', () => {
  it('a consultant reads the burn bar and is still refused the rate cards and the budget view', async () => {
    const position = await api()
      .get(`/v1/accounts/${accountId}/contracts/${contractId}/position`)
      .set(bearer(consultantToken))
      .expect(200);
    expect(position.body).toMatchObject({
      contract: { id: contractId, name: 'Retainer', model: 'retainer' },
      available_minutes: 600,
      consumed_minutes: 720,
      status: 'over',
    });
    expect(position.body.percent_consumed).toBe(120);
    // Minutes and percentages only: nothing priced reaches a consultant.
    const serialised = JSON.stringify(position.body);
    for (const forbidden of ['rate', 'amount', 'currency', 'bill_rate']) {
      expect(serialised, `position leaked ${forbidden}`).not.toContain(forbidden);
    }
    await api().get(`/v1/accounts/${accountId}/rate-cards`).set(bearer(consultantToken)).expect(403);
    await api().get(`/v1/accounts/${accountId}/budget`).set(bearer(consultantToken)).expect(403);
    await api()
      .get(`/v1/accounts/${accountId}/budget/entries?from=${monthStart}&to=${monthEnd}`)
      .set(bearer(consultantToken))
      .expect(403);
  });
});

describe('rollover (technical section 2)', () => {
  it('a new period carries the unused contracted minutes under carry_month', async () => {
    const other = await api()
      .post(`/v1/accounts/${accountId}/contracts`)
      .set(bearer(adminToken))
      .send({
        name: 'Carry retainer',
        model: 'retainer',
        period_hours: 20,
        period_starts_on: '2026-07-01',
        period_ends_on: '2026-07-31',
        rollover_rule: 'carry_month',
      })
      .expect(201);
    const next = await api()
      .post(`/v1/accounts/${accountId}/contracts/${other.body.id}/periods`)
      .set(bearer(adminToken))
      .send({ starts_on: '2026-08-01', ends_on: '2026-08-31', contracted_minutes: 1200 })
      .expect(201);
    expect(next.body.carried_over_minutes).toBe(1200);
    const gap = await api()
      .post(`/v1/accounts/${accountId}/contracts/${other.body.id}/periods`)
      .set(bearer(adminToken))
      .send({ starts_on: '2026-10-01', ends_on: '2026-10-31', contracted_minutes: 1200 })
      .expect(201);
    expect(gap.body.carried_over_minutes).toBe(0);
    const capped = await api()
      .patch(`/v1/accounts/${accountId}/contracts/${other.body.id}`)
      .set(bearer(adminToken))
      .send({ version: other.body.version, rollover_rule: 'cap' })
      .expect(400);
    expect(capped.body.code).toBe('cap_required');
  });
});
