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
 * The out-of-scope flag and its approval (TM-11, Ticket Management
 * functional 5 and technical 3.3): whoever works the ticket may flag work
 * as outside the contract with a reason, the account's contract managers
 * are told, and someone holding `tickets:approve-scope` who is not the
 * flagger either approves it with an allowance the contract period carries,
 * or declines it and says why.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let accountId: string;
let contractId: string;
let periodId: string;
let adminId: string;
let consultantId: string;

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
  adminId = (await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201)).body.userId;

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
  // The contract opens with a period covering today, which is where an
  // approved allowance lands.
  const today = new Date().toISOString().slice(0, 10);
  const periods = await api()
    .get(`/v1/accounts/${accountId}/contracts/${contractId}/periods`)
    .set(bearer(adminToken))
    .expect(200);
  const current = periods.body.find(
    (row: { starts_on: string; ends_on: string }) => row.starts_on <= today && row.ends_on >= today,
  );
  expect(current, 'the new contract has a period covering today').toBeDefined();
  periodId = current.id;

  // Cara works tickets (Consultant) and cannot decide a flag; the
  // administrator holds tickets:approve-scope.
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
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function newTicket(description: string): Promise<{ key: string; version: number }> {
  const created = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: accountId, type: 'incident', short_description: description })
    .expect(201);
  return { key: created.body.key, version: created.body.version };
}

async function flag(key: string, version: number, reason: string, token = consultantToken) {
  return api()
    .post(`/v1/tickets/${key}/scope`)
    .set(bearer(token))
    .send({ version, out_of_scope: true, reason })
    .expect(201);
}

const carried = () =>
  withSuperuser((client) =>
    client.query('select carried_over_minutes from acct.contract_periods where id = $1', [periodId]),
  ).then((result) => Number(result.rows[0].carried_over_minutes));

describe('POST /v1/tickets/:key/scope', () => {
  it('records who flagged the work and why, audits it, and tells the contract managers', async () => {
    const ticket = await newTicket('Rebuild the consolidation hierarchy');
    const before = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
    expect(before.body.scope).toMatchObject({ out_of_scope: 'none', reason: null, decision: null });

    const flagged = await flag(ticket.key, ticket.version, 'A new hierarchy is a project, not support.');
    expect(flagged.body.scope).toMatchObject({
      out_of_scope: 'flagged',
      reason: 'A new hierarchy is a project, not support.',
      flagged_by: consultantId,
      flagged_by_name: 'Cara Lee',
      decision: null,
      decided_by: null,
    });
    expect(flagged.body.scope.flagged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The flag survives a re-read; it is on the record, not in the response.
    const reread = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
    expect(reread.body.scope.out_of_scope).toBe('flagged');

    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type, new_value from acct.audit_events where event_type = 'ticket.scope_flagged' and entity_id = $1`,
        [flagged.body.id],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].new_value).toMatchObject({ state: 'flagged' });
    const outbox = await withSuperuser((client) =>
      client.query(`select payload from sys.outbox where event_type = 'ticket.scope_flagged' and aggregate_id = $1`, [
        flagged.body.id,
      ]),
    );
    expect(outbox.rows[0].payload).toMatchObject({ flagged_by: consultantId });
    // The administrator manages the account's contracts, so the decision is theirs to make.
    const notes = await withSuperuser((client) =>
      client.query(`select recipient_id, title from acct.notifications where type = 'ticket.scope_flagged'`),
    );
    expect(notes.rows.map((row: { recipient_id: string }) => row.recipient_id)).toEqual([adminId]);
    expect(notes.rows[0].title).toContain(ticket.key);

    // A flag says why, and a ticket cannot be flagged twice.
    const wordless = await newTicket('No reason given');
    const refused = await api()
      .post(`/v1/tickets/${wordless.key}/scope`)
      .set(bearer(consultantToken))
      .send({ version: wordless.version, out_of_scope: true })
      .expect(400);
    expect(refused.body.code).toBe('reason_required');
    const again = await api()
      .post(`/v1/tickets/${ticket.key}/scope`)
      .set(bearer(consultantToken))
      .send({ version: flagged.body.version, out_of_scope: true, reason: 'Again' })
      .expect(409);
    expect(again.body.code).toBe('already_flagged');
  });

  it('counts a pending flag on the waiting rail of the account owner', async () => {
    const owned = await api().get(`/v1/admin/accounts/${accountId}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/admin/accounts/${accountId}`)
      .set(bearer(adminToken))
      .send({ version: owned.body.version, owner_user_id: adminId })
      .expect(200);
    const rail = await api().get('/v1/me/waiting').set(bearer(adminToken)).expect(200);
    const approvals = rail.body.items.find((item: { key: string }) => item.key === 'scope_approvals');
    expect(approvals.count).toBe(1);
    expect(approvals.link).toBe('/tickets');
  });

  it('lets the flagger withdraw a flag no one has decided', async () => {
    const ticket = await newTicket('Second opinion on the close calendar');
    const flagged = await flag(ticket.key, ticket.version, 'Possibly outside the retainer.');
    const withdrawn = await api()
      .post(`/v1/tickets/${ticket.key}/scope`)
      .set(bearer(consultantToken))
      .send({ version: flagged.body.version, out_of_scope: false })
      .expect(201);
    expect(withdrawn.body.scope.out_of_scope).toBe('none');
    const nothing = await api()
      .post(`/v1/tickets/${ticket.key}/scope`)
      .set(bearer(consultantToken))
      .send({ version: withdrawn.body.version, out_of_scope: false })
      .expect(409);
    expect(nothing.body.code).toBe('not_flagged');
  });
});

describe('POST /v1/tickets/:key/scope/decision', () => {
  it('approves the work and puts the allowance into the current contract period', async () => {
    const ticket = await newTicket('Migrate the legacy cube');
    const flagged = await flag(ticket.key, ticket.version, 'The migration is beyond the retainer.');
    const before = await carried();

    const approved = await api()
      .post(`/v1/tickets/${ticket.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({
        version: flagged.body.version,
        decision: 'approve',
        note: 'Agreed with the client.',
        overage_allowance_minutes: 480,
      })
      .expect(201);
    expect(approved.body.scope).toMatchObject({
      out_of_scope: 'approved',
      reason: 'The migration is beyond the retainer.',
      flagged_by: consultantId,
      decision: 'approve',
      note: 'Agreed with the client.',
      decided_by: adminId,
      overage_allowance_minutes: 480,
    });
    expect(approved.body.scope.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The eight hours are budget now, so the time logged on the ticket is
    // inside it rather than over it.
    expect(await carried()).toBe(before + 480);
    const budget = await api().get(`/v1/accounts/${accountId}/budget`).set(bearer(adminToken)).expect(200);
    const position = budget.body.contracts[0].position;
    expect(position.carried_over_minutes).toBe(before + 480);
    expect(position.available_minutes).toBe(position.contracted_minutes + before + 480);

    // The audit names the allowance on the period, so the increase is never
    // mistaken for an ordinary rollover.
    const audit = await withSuperuser((client) =>
      client.query(
        `select entity_kind, field, new_value from acct.audit_events
          where event_type = 'ticket.scope_decided' and entity_kind = 'contract_period' and ticket_id = $1`,
        [approved.body.id],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ field: 'carried_over_minutes' });
    expect(audit.rows[0].new_value).toMatchObject({ out_of_scope_allowance_minutes: 480 });
    const outbox = await withSuperuser((client) =>
      client.query(`select payload from sys.outbox where event_type = 'ticket.scope_decided' and aggregate_id = $1`, [
        approved.body.id,
      ]),
    );
    expect(outbox.rows[0].payload).toMatchObject({ decision: 'approve', allowance_minutes: 480 });
    // The person who raised the flag hears the answer.
    const notes = await withSuperuser((client) =>
      client.query(`select recipient_id, title from acct.notifications where type = 'ticket.scope_decided'`),
    );
    expect(notes.rows[0].recipient_id).toBe(consultantId);
    expect(notes.rows[0].title).toContain('480 minutes of budget');
  });

  it('declines the work, words why, and leaves the budget alone', async () => {
    const ticket = await newTicket('Write the quarterly board deck');
    const flagged = await flag(ticket.key, ticket.version, 'Deck writing is not support work.');
    const before = await carried();
    const declined = await api()
      .post(`/v1/tickets/${ticket.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({ version: flagged.body.version, decision: 'decline', note: 'The client has not funded this.' })
      .expect(201);
    expect(declined.body.scope).toMatchObject({
      out_of_scope: 'declined',
      decision: 'decline',
      note: 'The client has not funded this.',
      decided_by: adminId,
      overage_allowance_minutes: null,
    });
    expect(await carried()).toBe(before);
    // The flag is no longer pending, so it leaves the approver's rail.
    const rail = await api().get('/v1/me/waiting').set(bearer(adminToken)).expect(200);
    expect(rail.body.items.find((item: { key: string }) => item.key === 'scope_approvals').count).toBe(1);
    // Nothing is left to decide on this one.
    const settled = await api()
      .post(`/v1/tickets/${ticket.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({ version: declined.body.version, decision: 'approve' })
      .expect(409);
    expect(settled.body.code).toBe('not_flagged');
  });

  it('splits the permission: working a ticket is not deciding its scope, and the flagger never decides', async () => {
    const ticket = await newTicket('Rewrite the allocation rules');
    const flagged = await flag(ticket.key, ticket.version, 'Rules work is a change, not an incident.');
    // Cara may flag but holds no tickets:approve-scope.
    const refused = await api()
      .post(`/v1/tickets/${ticket.key}/scope/decision`)
      .set(bearer(consultantToken))
      .send({ version: flagged.body.version, decision: 'approve' })
      .expect(403);
    expect(refused.body.permission).toBe('tickets:approve-scope');

    // The administrator holds it, but not on a flag they raised themselves.
    const own = await newTicket('Reconfigure the data source');
    const ownFlag = await flag(own.key, own.version, 'Reconfiguration is project work.', adminToken);
    const selfDecided = await api()
      .post(`/v1/tickets/${own.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({ version: ownFlag.body.version, decision: 'approve' })
      .expect(409);
    expect(selfDecided.body.code).toBe('flagger_cannot_decide');
    // Cara's flag is theirs to decide, and it needs no allowance to be approved.
    const approved = await api()
      .post(`/v1/tickets/${ticket.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({ version: flagged.body.version, decision: 'approve' })
      .expect(201);
    expect(approved.body.scope).toMatchObject({ out_of_scope: 'approved', overage_allowance_minutes: null });
  });
});
