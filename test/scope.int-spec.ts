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
    expect(approvals.link).toBe('/tickets?out_of_scope=flagged');
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
    // A retraction is its own event and it is published, so a consumer can
    // tell it from the raise without reading the value, and the outbox
    // stops saying a flag is open after it has gone.
    const audited = await withSuperuser((client) =>
      client.query<{ event_type: string }>(
        `select event_type from acct.audit_events where ticket_id = $1 and event_type like 'ticket.scope%' order by created_at`,
        [withdrawn.body.id],
      ),
    );
    expect(audited.rows.map((row) => row.event_type)).toEqual(['ticket.scope_flagged', 'ticket.scope_withdrawn']);
    const published = await withSuperuser((client) =>
      client.query<{ event_type: string; payload: Record<string, unknown> }>(
        `select event_type, payload from sys.outbox where aggregate_id = $1 and event_type like 'ticket.scope%' order by id`,
        [withdrawn.body.id],
      ),
    );
    expect(published.rows.map((row) => row.event_type)).toEqual(['ticket.scope_flagged', 'ticket.scope_withdrawn']);
    expect(published.rows[1].payload).toMatchObject({ reason: 'Possibly outside the retainer.' });

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

  it('bounds the allowance and refuses one against a period Finance has locked', async () => {
    // The allowance is added straight to the period budget, so an unbounded
    // one would make every subsequent overage check pass forever.
    const huge = await newTicket('Rebuild every integration');
    const hugeFlag = await flag(huge.key, huge.version, 'A rebuild is not support.');
    const refused = await api()
      .post(`/v1/tickets/${huge.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({ version: hugeFlag.body.version, decision: 'approve', overage_allowance_minutes: 2_147_483_647 })
      .expect(400);
    expect(JSON.stringify(refused.body)).toContain('overage_allowance_minutes');

    // A locked period is Finance's final word: an allowance against it is
    // refused in the words an entry dated inside it is refused in.
    await withSuperuser((client) =>
      client.query('update acct.contract_periods set locked = true where id = $1', [periodId]),
    );
    const before = await carried();
    const locked = await api()
      .post(`/v1/tickets/${huge.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({ version: hugeFlag.body.version, decision: 'approve', overage_allowance_minutes: 60 })
      .expect(409);
    expect(locked.body.code).toBe('contract_period_locked');
    expect(await carried()).toBe(before);

    // Unlocked, the same decision goes through, so the refusal is the lock
    // and not the ticket.
    await withSuperuser((client) =>
      client.query('update acct.contract_periods set locked = false where id = $1', [periodId]),
    );
    const approved = await api()
      .post(`/v1/tickets/${huge.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({ version: hugeFlag.body.version, decision: 'approve', overage_allowance_minutes: 60 })
      .expect(201);
    expect(approved.body.scope).toMatchObject({ out_of_scope: 'approved', overage_allowance_minutes: 60 });
    expect(await carried()).toBe(before + 60);
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

/**
 * The Queue's Flagged chip and the waiting rail's link (TM-11): the flag is
 * a list filter of its own and a field of the condition grammar, so a chip
 * and a saved view both reach the same rows.
 */
describe('filtering the queue on the flag', () => {
  const descriptionsOf = (body: { items: { short_description: string }[] }) =>
    body.items.map((item) => item.short_description).sort();

  it('returns only the flagged tickets, and every one of them', async () => {
    const listed = await api().get('/v1/tickets?out_of_scope=flagged').set(bearer(adminToken)).expect(200);
    // Two flags are still waiting for a decision: Cara's first one and the
    // administrator's own, which they may not decide themselves.
    expect(descriptionsOf(listed.body)).toEqual(['Rebuild the consolidation hierarchy', 'Reconfigure the data source']);
    for (const item of listed.body.items) expect(item.scope.out_of_scope).toBe('flagged');

    // The parameter takes the whole vocabulary, and a decided flag is not a
    // pending one.
    const decided = await api().get('/v1/tickets?out_of_scope=approved,declined').set(bearer(adminToken)).expect(200);
    expect(descriptionsOf(decided.body)).toEqual([
      'Migrate the legacy cube',
      'Rebuild every integration',
      'Rewrite the allocation rules',
      'Write the quarterly board deck',
    ]);
    // Unfiltered, the queue still holds everything.
    const all = await api().get('/v1/tickets').set(bearer(adminToken)).expect(200);
    expect(all.body.items.length).toBeGreaterThan(listed.body.items.length);
  });

  it('carries the same field in a saved view', async () => {
    const view = await api()
      .post('/v1/views')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        name: 'Flags to decide',
        definition: {
          conditions: { conditions: [{ field: 'out_of_scope', op: 'in', value: ['flagged'] }], match: 'all' },
          sort: 'created_desc',
          columns: ['key', 'short_description'],
        },
      })
      .expect(201);
    const listed = await api().get(`/v1/tickets?view=${view.body.id}`).set(bearer(adminToken)).expect(200);
    expect(descriptionsOf(listed.body)).toEqual(['Rebuild the consolidation hierarchy', 'Reconfigure the data source']);

    // The condition set is checked against the same closed vocabulary.
    const refused = await api()
      .post('/v1/views')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        name: 'Nonsense',
        definition: { conditions: { conditions: [{ field: 'out_of_scope', op: 'eq', value: 'maybe' }] } },
      })
      .expect(400);
    expect(refused.body.code).toBe('invalid_conditions');
  });

  it('refuses a value the flag cannot hold', async () => {
    const refused = await api().get('/v1/tickets?out_of_scope=maybe').set(bearer(adminToken)).expect(400);
    expect(refused.body.code).toBe('validation_failed');
    await api().get('/v1/tickets?out_of_scope=flagged,maybe').set(bearer(adminToken)).expect(400);
  });
});

describe('the scope record (TM-11)', () => {
  it('keeps one row per thing that happened, and refuses to let any of them be changed', async () => {
    const ticket = await newTicket('Rework the mapping tables');
    const flagged = await flag(ticket.key, ticket.version, 'Not in the statement of work');
    await api()
      .post(`/v1/tickets/${ticket.key}/scope/decision`)
      .set(bearer(adminToken))
      .send({ version: flagged.body.version, decision: 'approve', note: 'Client agreed on the call' })
      .expect(201);

    const record = await api().get(`/v1/tickets/${ticket.key}/scope/record`).set(bearer(adminToken)).expect(200);
    expect(record.body.map((row: { event: string }) => row.event)).toEqual(['flagged', 'approved']);
    // The flag is internal; the decision is what the client is shown.
    expect(record.body.map((row: { client_visible: boolean }) => row.client_visible)).toEqual([false, true]);
    expect(record.body[1]).toMatchObject({
      reason: 'Not in the statement of work',
      note: 'Client agreed on the call',
    });

    // Append-only in the database, which is what makes it worth showing.
    const row = record.body[0];
    await expect(
      withSuperuser((client) =>
        client.query('update acct.scope_decisions set reason = $2 where id = $1', [row.id, 'rewritten']),
      ),
    ).rejects.toThrow();
    await expect(
      withSuperuser((client) => client.query('delete from acct.scope_decisions where id = $1', [row.id])),
    ).rejects.toThrow();
  });

  it('records a withdrawal, which the ticket column cannot express', async () => {
    const ticket = await newTicket('Second look at the load');
    const flagged = await flag(ticket.key, ticket.version, 'Looks like new work');
    await api()
      .post(`/v1/tickets/${ticket.key}/scope`)
      .set(bearer(consultantToken))
      .send({ version: flagged.body.version, out_of_scope: false })
      .expect(201);

    const record = await api().get(`/v1/tickets/${ticket.key}/scope/record`).set(bearer(adminToken)).expect(200);
    expect(record.body.map((row: { event: string }) => row.event)).toEqual(['flagged', 'withdrawn']);
    // The ticket is back to 'none', so without the record the flag would look
    // like something that never happened.
    const after = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
    expect(after.body.scope.out_of_scope).toBe('none');
  });

  it('exports every event in the window, withdrawals and declines included', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const csv = await api()
      .get(`/v1/tickets/scope-decisions.csv?account_id=${accountId}&from=${today}&to=${today}`)
      .set(bearer(adminToken))
      .expect(200);
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toContain('ticket,event,reason,note,allowance_minutes');
    expect(lines.length).toBeGreaterThan(1);
    expect(csv.headers['content-disposition']).toContain('scope-decisions-');
  });
});

describe('ticket participants (TM-21)', () => {
  it('records who had a part, in what role, and who put them there', async () => {
    const ticket = await newTicket('Migrate the reporting cube');
    const added = await api()
      .post(`/v1/tickets/${ticket.key}/participants`)
      .set(bearer(adminToken))
      .send({ user_id: 'dev_cara', display_name: 'Cara Lee', role: 'collaborator' })
      .expect(201);
    expect(added.body).toMatchObject({
      user_id: 'dev_cara',
      role: 'collaborator',
      status: 'active',
      invited_by_name: expect.any(String),
    });
    expect(added.body.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const listed = await api().get(`/v1/tickets/${ticket.key}/participants`).set(bearer(adminToken)).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.contributors).toBe(1);
  });

  it('refuses to put the same person on twice, and refuses the assignee', async () => {
    const ticket = await newTicket('Second pass on the cube');
    await api()
      .post(`/v1/tickets/${ticket.key}/participants`)
      .set(bearer(adminToken))
      .send({ user_id: 'dev_cara', role: 'reviewer' })
      .expect(201);
    const again = await api()
      .post(`/v1/tickets/${ticket.key}/participants`)
      .set(bearer(adminToken))
      .send({ user_id: 'dev_cara', role: 'observer' })
      .expect(409);
    expect(again.body.code).toBe('already_a_participant');

    // The ticket owns who it is assigned to; a second place to say so is a
    // second place for it to be wrong. An assignee is a real user id rather
    // than a token subject, so it is read back from the API.
    const who = await api().get('/v1/admin/me').set(bearer(consultantToken)).expect(200);
    const assigneeId = who.body.principal.userId;
    const current = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
    const assigned = await api()
      .patch(`/v1/tickets/${ticket.key}`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, assignee_id: assigneeId })
      .expect(200);
    expect(assigned.body.assignee_id).toBe(assigneeId);
    const refused = await api()
      .post(`/v1/tickets/${ticket.key}/participants`)
      .set(bearer(adminToken))
      .send({ user_id: assigneeId, role: 'collaborator' })
      .expect(409);
    expect(refused.body.code).toBe('assignee_is_not_a_participant');
  });

  it('keeps the row when somebody leaves, so the history survives', async () => {
    const ticket = await newTicket('Third pass on the cube');
    const added = await api()
      .post(`/v1/tickets/${ticket.key}/participants`)
      .set(bearer(adminToken))
      .send({ user_id: 'dev_cara', role: 'collaborator' })
      .expect(201);
    const left = await api()
      .delete(`/v1/tickets/${ticket.key}/participants/${added.body.id}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(left.body).toMatchObject({ status: 'left' });
    expect(left.body.left_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Gone from the ticket, still on the record, and still a contributor.
    const listed = await api().get(`/v1/tickets/${ticket.key}/participants`).set(bearer(adminToken)).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.contributors).toBe(1);

    // And they can be asked back, which is a second row rather than an edit.
    await api()
      .post(`/v1/tickets/${ticket.key}/participants`)
      .set(bearer(adminToken))
      .send({ user_id: 'dev_cara', role: 'reviewer' })
      .expect(201);
    const again = await api().get(`/v1/tickets/${ticket.key}/participants`).set(bearer(adminToken)).expect(200);
    expect(again.body.items).toHaveLength(2);
    // Counted once: a contributor is a person, not a stint.
    expect(again.body.contributors).toBe(1);
  });
});

/**
 * Inviting somebody onto a ticket without handing it to them (TM-22,
 * Ticket Management functional 5). The day-in-the-life analysis found people
 * transferring a ticket to ask a question and never getting it back, so the
 * assignee staying put is the assertion every test here carries.
 */
describe('participant invitations', () => {
  async function assignedTicket(description: string): Promise<{ key: string; assignee: string }> {
    const ticket = await newTicket(description);
    await api()
      .post(`/v1/tickets/${ticket.key}/transitions`)
      .set(bearer(adminToken))
      .send({ version: 1, to: 'in_progress' })
      .expect(201);
    const current = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
    const assigned = await api()
      .patch(`/v1/tickets/${ticket.key}`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, assignee_id: adminId })
      .expect(200);
    return { key: ticket.key, assignee: assigned.body.assignee_id };
  }

  it('asks a person on, tells them, and leaves the assignee where it was', async () => {
    const ticket = await assignedTicket('Reconcile the intercompany rule');
    const invited = await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ user_id: consultantId, display_name: 'Cara Lee', role: 'collaborator' })
      .expect(201);
    expect(invited.body).toMatchObject({ status: 'invited', user_id: consultantId, joined_at: null });

    // The invitee hears about it. Being asked is no use if nobody is told.
    const feed = await api().get('/v1/notifications').set(bearer(consultantToken)).expect(200);
    const note = feed.body.find((row: { type: string }) => row.type === 'ticket.participant_invited');
    expect(note, 'the invitee is notified').toBeDefined();
    expect(note.link).toBe(`/cases/${ticket.key}`);

    // An unanswered invitation is not a contributor.
    const pending = await api().get(`/v1/tickets/${ticket.key}/participants`).set(bearer(adminToken)).expect(200);
    expect(pending.body.contributors).toBe(0);

    const accepted = await api()
      .post(`/v1/tickets/${ticket.key}/participants/${invited.body.id}/accept`)
      .set(bearer(consultantToken))
      .expect(200);
    expect(accepted.body).toMatchObject({ status: 'active', responded_by: consultantId });
    expect(accepted.body.joined_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const after = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
    expect(after.body.assignee_id, 'the assignee is untouched by an invitation').toBe(ticket.assignee);
    const listed = await api().get(`/v1/tickets/${ticket.key}/participants`).set(bearer(adminToken)).expect(200);
    expect(listed.body.contributors).toBe(1);
  });

  it('keeps a no on the record, with its reason, and counts nobody for it', async () => {
    const ticket = await assignedTicket('Rebuild the metadata load');
    const invited = await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ user_id: consultantId, role: 'reviewer' })
      .expect(201);
    const declined = await api()
      .post(`/v1/tickets/${ticket.key}/participants/${invited.body.id}/decline`)
      .set(bearer(consultantToken))
      .send({ reason: 'On the Brookfield cutover all week' })
      .expect(200);
    expect(declined.body).toMatchObject({
      status: 'declined',
      decline_reason: 'On the Brookfield cutover all week',
      responded_by: consultantId,
      joined_at: null,
    });

    const listed = await api().get(`/v1/tickets/${ticket.key}/participants`).set(bearer(adminToken)).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.contributors).toBe(0);

    // Asking again is allowed, because a no was about that week and not forever.
    await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ user_id: consultantId, role: 'reviewer' })
      .expect(201);
  });

  it('refuses an answer from anybody but the person asked', async () => {
    const ticket = await assignedTicket('Trace the failing consolidation');
    const invited = await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ user_id: consultantId, role: 'collaborator' })
      .expect(201);
    const refused = await api()
      .post(`/v1/tickets/${ticket.key}/participants/${invited.body.id}/accept`)
      .set(bearer(adminToken))
      .expect(403);
    expect(refused.body.code).toBe('not_your_invitation');
  });

  it('asks a group, and a member accepts for it without losing who was asked', async () => {
    const group = await api()
      .post('/v1/admin/groups')
      .set(bearer(adminToken))
      .send({ name: 'Consolidation Technical', service_line: 'OneStream' })
      .expect(201);
    await api()
      .put(`/v1/admin/groups/${group.body.id}/members`)
      .set(bearer(adminToken))
      .send({ user_ids: [consultantId] })
      .expect(200);

    const ticket = await assignedTicket('Cash flow statement will not tie');
    const invited = await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ group_id: group.body.id, role: 'reviewer' })
      .expect(201);
    // Nobody is invented to hang the ask on: the group was asked, not a person.
    expect(invited.body).toMatchObject({
      status: 'invited',
      user_id: null,
      group_id: group.body.id,
      group_name: 'Consolidation Technical',
    });

    const twice = await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ group_id: group.body.id, role: 'collaborator' })
      .expect(409);
    expect(twice.body.code).toBe('group_already_invited');

    const accepted = await api()
      .post(`/v1/tickets/${ticket.key}/participants/${invited.body.id}/accept`)
      .set(bearer(consultantToken))
      .expect(200);
    expect(accepted.body).toMatchObject({
      status: 'active',
      user_id: consultantId,
      group_id: group.body.id,
      group_name: 'Consolidation Technical',
    });

    const after = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
    expect(after.body.assignee_id, 'a group invitation moves no ownership either').toBe(ticket.assignee);
  });

  it('lets the inviter take an unanswered ask back, which is not a no', async () => {
    const ticket = await assignedTicket('Second look at the currency table');
    const invited = await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ user_id: consultantId, role: 'observer' })
      .expect(201);
    const withdrawn = await api()
      .delete(`/v1/tickets/${ticket.key}/participants/${invited.body.id}`)
      .set(bearer(adminToken))
      .expect(200);
    // Withdrawn, not declined and not left: three different facts, three words.
    expect(withdrawn.body).toMatchObject({ status: 'withdrawn', left_at: null, responded_at: null });

    const late = await api()
      .post(`/v1/tickets/${ticket.key}/participants/${invited.body.id}/accept`)
      .set(bearer(consultantToken))
      .expect(409);
    expect(late.body.code).toBe('invitation_not_open');
  });

  it('wants a person or a group, and not both or neither', async () => {
    const ticket = await assignedTicket('Close the period early');
    const neither = await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ role: 'collaborator' })
      .expect(400);
    expect(neither.body.code).toBe('invite_a_person_or_a_group');
    const both = await api()
      .post(`/v1/tickets/${ticket.key}/participants/invitations`)
      .set(bearer(adminToken))
      .send({ user_id: consultantId, group_id: accountId, role: 'collaborator' })
      .expect(400);
    expect(both.body.code).toBe('invite_a_person_or_a_group');
  });
});
