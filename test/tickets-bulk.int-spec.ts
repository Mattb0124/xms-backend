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
 * Bulk actions (TM-16; Ticket Management functional 5.12). One route, one
 * action, a bounded set of keys each carrying its version, and one outcome
 * per key. Every ticket runs through the single-ticket service path, so the
 * rules that refuse a change outside its window, a stale version or a close
 * without its discipline refuse it here too, and the batch reports rather
 * than rolls back.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let caraToken: string;
let caraUserId: string;
let accountId: string;
let openWindowId: string;
let frozenWindowId: string;

const hours = (count: number): string => new Date(Date.now() + count * 3_600_000).toISOString();
const days = (count: number): string => new Date(Date.now() + count * 86_400_000).toISOString();

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
    .send({ key: 'BLK', name: 'Bulk Industries' })
    .expect(201);
  accountId = account.body.id;
  await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Support retainer', model: 'retainer', period_hours: 100 })
    .expect(201);

  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  const cara = await api()
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
  caraUserId = cara.body.id;
  caraToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  // An invited user becomes active on their first authenticated request, and only an active internal user is assignable.
  await api().get('/v1/accounts').set(bearer(caraToken)).expect(200);

  openWindowId = await newWindow({ name: 'Tonight', starts_at: hours(-1), ends_at: hours(2) });
  frozenWindowId = await newWindow({
    name: 'Year-end weekend',
    starts_at: days(20),
    ends_at: days(21),
    freeze_windows: [{ starts_at: days(19), ends_at: days(22), reason: 'Year end close' }],
  });
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface Ticket {
  id: string;
  key: string;
  version: number;
  state: string;
}

async function newWindow(body: Record<string, unknown>): Promise<string> {
  const created = await api()
    .post('/v1/ticket-groups')
    .set(bearer(adminToken))
    .send({ account_id: accountId, kind: 'change_window', status: 'active', ...body })
    .expect(201);
  return created.body.id;
}

async function newTicket(short_description: string, extra: Record<string, unknown> = {}): Promise<Ticket> {
  const created = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: accountId, type: 'incident', short_description, ...extra })
    .expect(201);
  return created.body;
}

function move(ticket: Ticket, to: string, extra: Record<string, unknown> = {}) {
  return api()
    .post(`/v1/tickets/${ticket.key}/transitions`)
    .set(bearer(adminToken))
    .send({ version: ticket.version, to, ...extra });
}

/** A change already approved and sitting in the given window, ready to be scheduled. */
async function approvedChange(short_description: string, windowId: string): Promise<Ticket> {
  const created = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: accountId, type: 'change', short_description, ticket_group_id: windowId })
    .expect(201);
  let ticket: Ticket = created.body;
  ticket = (await move(ticket, 'assessment').expect(201)).body;
  ticket = (await move(ticket, 'approved').expect(201)).body;
  return ticket;
}

const bulk = (body: Record<string, unknown>, token = adminToken) =>
  api().post('/v1/tickets/bulk').set(bearer(token)).send(body);

const outcomeOf = (
  body: { results: { key: string; outcome: string; code?: string; version?: number }[] },
  key: string,
) => body.results.find((result) => result.key === key);

describe('bulk actions', () => {
  it('reports one outcome per key when a batch mixes success, a stale version, an unknown key and a closed ticket', async () => {
    const good = await newTicket('Bulk assign me');
    const stale = await newTicket('Someone else moved me');
    const closed = await newTicket('Already gone');
    const cancelled = (await move(closed, 'cancelled').expect(201)).body as Ticket;

    const response = await bulk({
      action: 'assign',
      assignee_id: caraUserId,
      tickets: [
        { key: good.key, version: good.version },
        { key: stale.key, version: stale.version + 5 },
        { key: 'CS9999999', version: 1 },
        { key: cancelled.key, version: cancelled.version },
      ],
    }).expect(201);

    expect(response.body.action).toBe('assign');
    expect(response.body.requested).toBe(4);
    expect(response.body.succeeded).toBe(1);
    expect(response.body.failed).toBe(3);
    expect(outcomeOf(response.body, good.key)).toMatchObject({ outcome: 'ok' });
    expect(outcomeOf(response.body, good.key)?.version).toBeGreaterThan(good.version);
    expect(outcomeOf(response.body, stale.key)).toMatchObject({ outcome: 'version_conflict', code: 'stale_version' });
    expect(outcomeOf(response.body, 'CS9999999')).toMatchObject({ outcome: 'not_found' });
    expect(outcomeOf(response.body, cancelled.key)).toMatchObject({ outcome: 'refused', code: 'ticket_closed' });

    const assigned = await api().get(`/v1/tickets/${good.key}`).set(bearer(adminToken)).expect(200);
    expect(assigned.body.assignee_id).toBe(caraUserId);
    // The refused keys were not touched: no partial write inside one ticket.
    const untouched = await api().get(`/v1/tickets/${stale.key}`).set(bearer(adminToken)).expect(200);
    expect(untouched.body.assignee_id).toBeNull();
    expect(untouched.body.version).toBe(stale.version);
  });

  it('refuses the change-window transition in the batch and applies the rest', async () => {
    const clean = await approvedChange('Cutover the consolidation engine', openWindowId);
    const frozen = await approvedChange('Touch production over year end', frozenWindowId);

    const response = await bulk({
      action: 'transition',
      to: 'scheduled',
      tickets: [
        { key: clean.key, version: clean.version },
        { key: frozen.key, version: frozen.version },
      ],
    }).expect(201);

    expect(response.body.succeeded).toBe(1);
    expect(outcomeOf(response.body, clean.key)).toMatchObject({ outcome: 'ok' });
    const refused = outcomeOf(response.body, frozen.key);
    expect(refused).toMatchObject({ outcome: 'refused', code: 'change_freeze' });

    const scheduled = await api().get(`/v1/tickets/${clean.key}`).set(bearer(adminToken)).expect(200);
    expect(scheduled.body.state).toBe('scheduled');
    const held = await api().get(`/v1/tickets/${frozen.key}`).set(bearer(adminToken)).expect(200);
    expect(held.body.state).toBe('approved');
  });

  it('refuses the whole batch when the caller lacks the permission the action needs', async () => {
    const one = await newTicket('Priority stays where it is');
    const two = await newTicket('And so does this one');

    const refused = await bulk(
      {
        action: 'set_priority',
        priority: 'p1',
        tickets: [
          { key: one.key, version: one.version },
          { key: two.key, version: two.version },
        ],
      },
      caraToken,
    ).expect(403);
    expect(refused.body).toMatchObject({ code: 'forbidden', permission: 'tickets:override-priority' });

    for (const ticket of [one, two]) {
      const after = await api().get(`/v1/tickets/${ticket.key}`).set(bearer(adminToken)).expect(200);
      expect(after.body.version).toBe(ticket.version);
      expect(after.body.priority).not.toBe('p1');
    }
  });

  it('refuses a batch over the bound before it touches a ticket', async () => {
    const one = await newTicket('The only real key in a very long list');
    const tickets = [{ key: one.key, version: one.version }];
    for (let index = 0; index < 100; index += 1) tickets.push({ key: `CS000${1000 + index}`, version: 1 });

    const refused = await bulk({ action: 'assign', assignee_id: caraUserId, tickets }).expect(400);
    expect(refused.body).toMatchObject({ code: 'too_many_tickets', max: 100, given: 101 });

    const after = await api().get(`/v1/tickets/${one.key}`).set(bearer(adminToken)).expect(200);
    expect(after.body.assignee_id).toBeNull();
  });

  it('applies the close discipline to a bulk close and comments under the version the caller read', async () => {
    const ready = await newTicket('Resolve me properly');
    const started = (await move(ready, 'in_progress').expect(201)).body as Ticket;

    const closes = await bulk({
      action: 'close',
      to: 'resolved',
      tickets: [{ key: started.key, version: started.version }],
    }).expect(201);
    expect(outcomeOf(closes.body, started.key)).toMatchObject({ outcome: 'refused', code: 'missing_requirements' });

    const comments = await bulk({
      action: 'comment',
      body: 'Chasing the client for the log bundle.',
      tickets: [
        { key: started.key, version: started.version },
        { key: started.key, version: started.version },
      ],
    }).expect(201);
    // The repeated key is applied once, so a double-click cannot double-post.
    expect(comments.body.requested).toBe(1);
    expect(outcomeOf(comments.body, started.key)).toMatchObject({ outcome: 'ok' });

    const stale = await bulk({
      action: 'comment',
      body: 'And again on the version I no longer hold.',
      tickets: [{ key: started.key, version: started.version - 1 }],
    }).expect(201);
    expect(outcomeOf(stale.body, started.key)).toMatchObject({ outcome: 'version_conflict', code: 'stale_version' });

    const posted = await api().get(`/v1/tickets/${started.key}/comments`).set(bearer(adminToken)).expect(200);
    expect(posted.body).toHaveLength(1);
  });

  it('writes an audit event per affected ticket, not one for the batch', async () => {
    const one = await newTicket('Audited one');
    const two = await newTicket('Audited two');
    await bulk({
      action: 'work_note',
      body: 'Batched note for the desk.',
      tickets: [
        { key: one.key, version: one.version },
        { key: two.key, version: two.version },
      ],
    }).expect(201);

    const events = await withSuperuser((client) =>
      client.query(
        `select ticket_id from acct.audit_events where event_type = 'work_note.created' and ticket_id = any($1::uuid[])`,
        [[one.id, two.id]],
      ),
    );
    expect(events.rows).toHaveLength(2);
  });
});
