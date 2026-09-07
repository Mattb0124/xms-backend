import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { DbPools } from '../src/db/pool.js';
import { UsageEventsService } from '../src/modules/telemetry/telemetry.module.js';
import { OutboxDispatcher } from '../src/worker/outbox-dispatcher.js';
import { closePools, pools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The ticket loop over the real database (P1.5.2, P1.5.3, P1.5.4, P1.5.6
 * done-when): create with the derived priority and SLA clocks; transitions
 * validated against the resolved machine with typed 409s; pause evidence
 * and resume shift; the close discipline refuses an empty resolve; comments
 * stamp the first response; work notes stay internal; notifications
 * collapse; outbox rows dispatch idempotently and poison dead-letters;
 * telemetry drops foreign account ids.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let consultantId: string;
let adminId: string;
let accountId: string;
let otherAccountId: string;

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
    .send({ key: 'OTH', name: 'Other' })
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

describe('create and read', () => {
  let key: string;
  let ticketId: string;

  it('creates a ticket with the derived priority, the initial state and both SLA clocks from the default policy', async () => {
    const response = await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Cube refresh fails',
        description: 'Nightly job failed twice',
        impact: 'high',
        urgency: 'high',
        requester_email: 'Pat@Client.test',
        requester_name: 'Pat Client',
      })
      .expect(201);
    key = response.body.key;
    ticketId = response.body.id;
    expect(key).toMatch(/^CS\d{7}$/);
    expect(response.body).toMatchObject({
      state: 'new',
      state_label: 'New',
      priority: 'p1',
      priority_overridden: false,
      source: 'internal',
      version: 1,
    });
    expect(response.body.requester).toMatchObject({ email: 'pat@client.test', display_name: 'Pat Client' });
    expect(response.body.sla.response).toMatchObject({ targetMinutes: 30, paused: false, breached: false, met: false });
    expect(response.body.sla.resolution).toMatchObject({ targetMinutes: 240 });
    expect(response.body.sla.response.remainingMinutes).toBeGreaterThanOrEqual(29);
    const audit = await withSuperuser((client) =>
      client.query(`select event_type from acct.audit_events where ticket_id = $1 order by created_at`, [ticketId]),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(['ticket.created']);
    const outbox = await withSuperuser((client) =>
      client.query(`select event_type from sys.outbox where aggregate_id = $1`, [ticketId]),
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual(['ticket.created']);
  });

  it('refuses a ticket on an account the principal is not granted with 404, never 403', async () => {
    await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({ account_id: otherAccountId, type: 'incident', short_description: 'Probe' })
      .expect(404);
  });

  it('reads the ticket by key and by id, lists it, and hides it from a consultant without a grant', async () => {
    const byKey = await api().get(`/v1/tickets/${key}`).set(bearer(consultantToken)).expect(200);
    expect(byKey.body.id).toBe(ticketId);
    await api().get(`/v1/tickets/${ticketId}`).set(bearer(consultantToken)).expect(200);
    const list = await api().get('/v1/tickets?open=true').set(bearer(consultantToken)).expect(200);
    expect(list.body.items.map((item: { key: string }) => item.key)).toEqual([key]);
    expect(list.body.stats).toMatchObject({ open: 1, unassigned: 1, p1: 1 });
    // A ticket on the other account exists but is invisible to the consultant.
    const foreign = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({ account_id: otherAccountId, type: 'service_request', short_description: 'Foreign' })
      .expect(201);
    await api().get(`/v1/tickets/${foreign.body.key}`).set(bearer(consultantToken)).expect(404);
    const adminList = await api().get('/v1/tickets?open=true').set(bearer(adminToken)).expect(200);
    expect(adminList.body.items).toHaveLength(2);
    const searched = await api().get('/v1/tickets?q=cube').set(bearer(adminToken)).expect(200);
    expect(searched.body.items.map((item: { key: string }) => item.key)).toEqual([key]);
    const byKeySearch = await api().get(`/v1/tickets?q=${key}`).set(bearer(adminToken)).expect(200);
    expect(byKeySearch.body.items).toHaveLength(1);
  });

  it('lists the allowed transitions for the state', async () => {
    const response = await api().get(`/v1/tickets/${key}/transitions`).set(bearer(consultantToken)).expect(200);
    expect(response.body.from).toBe('new');
    expect(response.body.transitions.map((transition: { to: string }) => transition.to)).toEqual([
      'assigned',
      'in_progress',
      'cancelled',
    ]);
  });

  it('refuses an invalid transition and a stale version with typed 409 bodies', async () => {
    const invalid = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 1, to: 'resolved' })
      .expect(409);
    expect(invalid.body).toMatchObject({ code: 'invalid_transition', from: 'new', to: 'resolved' });
    const stale = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 7, to: 'in_progress' })
      .expect(409);
    expect(stale.body).toMatchObject({ code: 'stale_version', version: 1 });
  });

  it('moves to In progress, which meets the response clock', async () => {
    const response = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 1, to: 'in_progress' })
      .expect(201);
    expect(response.body).toMatchObject({ state: 'in_progress', version: 2 });
    expect(response.body.first_response_at).not.toBeNull();
    expect(response.body.sla.response.met).toBe(true);
    expect(response.body.sla.resolution.met).toBe(false);
    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type, field, old_value, new_value from acct.audit_events where ticket_id = $1 and event_type = 'ticket.transition'`,
        [ticketId],
      ),
    );
    expect(audit.rows).toEqual([
      { event_type: 'ticket.transition', field: 'state', old_value: 'new', new_value: 'in_progress' },
    ]);
  });

  it('requires a pause reason to enter Awaiting client, then records the pause as evidence and freezes the clocks', async () => {
    const missing = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 2, to: 'awaiting_client' })
      .expect(409);
    expect(missing.body).toEqual(expect.objectContaining({ code: 'missing_requirements', items: ['pause_reason'] }));
    const paused = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 2, to: 'awaiting_client', pause_reason: 'awaiting_client', note: 'Waiting for the log export' })
      .expect(201);
    expect(paused.body.sla.resolution.paused).toBe(true);
    const pauses = await withSuperuser((client) =>
      client.query(`select reason, note, ended_at from acct.sla_pauses where ticket_id = $1`, [ticketId]),
    );
    expect(pauses.rows).toEqual([{ reason: 'awaiting_client', note: 'Waiting for the log export', ended_at: null }]);
    const resumed = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 3, to: 'in_progress' })
      .expect(201);
    expect(resumed.body.sla.resolution.paused).toBe(false);
    const ended = await withSuperuser((client) =>
      client.query(`select ended_at, excluded_minutes, ended_by from acct.sla_pauses where ticket_id = $1`, [ticketId]),
    );
    expect(ended.rows[0].ended_at).not.toBeNull();
    expect(ended.rows[0].excluded_minutes).toBe(0);
    expect(ended.rows[0].ended_by).toBe(consultantId);
    await expect(
      withSuperuser((client) => client.query(`delete from acct.sla_pauses where ticket_id = $1`, [ticketId])),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('refuses to resolve without the close discipline and lists every missing item', async () => {
    const response = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 4, to: 'resolved' })
      .expect(409);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'missing_requirements',
        items: ['resolution_code', 'resolution_notes', 'solution_link', 'time_logged'],
      }),
    );
    const unknown = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({
        version: 4,
        to: 'resolved',
        resolution: { code: 'magic', notes: 'x', solution_candidate: true, time_exemption_reason: 'x' },
      })
      .expect(409);
    expect(unknown.body.items).toEqual(['unknown_resolution_code']);
  });

  it('resolves with a code, notes, an article candidate and a time exemption, then closes', async () => {
    const resolved = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({
        version: 4,
        to: 'resolved',
        resolution: {
          code: 'fixed',
          notes: 'Rebuilt the cube',
          solution_candidate: true,
          time_exemption_reason: 'Fixed by vendor',
        },
      })
      .expect(201);
    expect(resolved.body.resolved_at).not.toBeNull();
    expect(resolved.body.resolution).toMatchObject({ code: 'fixed', solution_candidate: true });
    expect(resolved.body.sla.resolution.met).toBe(true);
    const closed = await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(consultantToken))
      .send({ version: 5, to: 'closed' })
      .expect(201);
    expect(closed.body.closed_at).not.toBeNull();
    await api()
      .patch(`/v1/tickets/${key}`)
      .set(bearer(consultantToken))
      .send({ version: 6, category: 'x' })
      .expect(409);
  });
});

describe('properties, comments, work notes, notifications', () => {
  let key: string;
  let ticketId: string;

  it('creates a P3 ticket and re-derives the priority when impact changes, restamping the clocks', async () => {
    const created = await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Report slow',
        impact: 'medium',
        urgency: 'medium',
      })
      .expect(201);
    key = created.body.key;
    ticketId = created.body.id;
    expect(created.body.priority).toBe('p3');
    expect(created.body.sla.response.targetMinutes).toBe(240);
    const patched = await api()
      .patch(`/v1/tickets/${key}`)
      .set(bearer(consultantToken))
      .send({ version: 1, impact: 'high', urgency: 'high' })
      .expect(200);
    expect(patched.body.priority).toBe('p1');
    expect(patched.body.sla.response.targetMinutes).toBe(30);
    expect(patched.body.sla.response.remainingMinutes).toBeLessThanOrEqual(30);
  });

  it('refuses a direct priority without the override permission and audits an override with the matrix value', async () => {
    const denied = await api()
      .patch(`/v1/tickets/${key}`)
      .set(bearer(consultantToken))
      .send({ version: 2, priority: 'p4' })
      .expect(403);
    expect(denied.body.permission).toBe('tickets:override-priority');
    const overridden = await api()
      .patch(`/v1/tickets/${key}`)
      .set(bearer(adminToken))
      .send({ version: 2, priority: 'p4' })
      .expect(200);
    expect(overridden.body).toMatchObject({ priority: 'p4', priority_overridden: true });
    const audit = await withSuperuser((client) =>
      client.query(
        `select old_value, new_value from acct.audit_events where ticket_id = $1 and event_type = 'ticket.priority_overridden'`,
        [ticketId],
      ),
    );
    expect(audit.rows).toEqual([{ old_value: 'p1', new_value: 'p4' }]);
  });

  it('assigns the ticket with a notification that collapses on repeat', async () => {
    await api()
      .patch(`/v1/tickets/${key}`)
      .set(bearer(consultantToken))
      .send({ version: 3, assignee_id: adminId })
      .expect(200);
    const first = await api().get('/v1/notifications/unread-count').set(bearer(adminToken)).expect(200);
    expect(first.body.count).toBe(1);
    await api()
      .patch(`/v1/tickets/${key}`)
      .set(bearer(consultantToken))
      .send({ version: 4, assignee_id: null })
      .expect(200);
    await api()
      .patch(`/v1/tickets/${key}`)
      .set(bearer(consultantToken))
      .send({ version: 5, assignee_id: adminId })
      .expect(200);
    const feed = await api().get('/v1/notifications').set(bearer(adminToken)).expect(200);
    const assigned = feed.body.filter((row: { type: string }) => row.type === 'ticket.assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0].count).toBe(2);
    await api().patch(`/v1/notifications/${assigned[0].id}/read`).set(bearer(adminToken)).expect(200);
    const after = await api().get('/v1/notifications/unread-count').set(bearer(adminToken)).expect(200);
    expect(after.body.count).toBe(0);
    // Another user cannot read or mark this notification.
    await api().patch(`/v1/notifications/${assigned[0].id}/read`).set(bearer(consultantToken)).expect(404);
  });

  it('a public comment by an operator stamps the first response and meets the response clock', async () => {
    const comment = await api()
      .post(`/v1/tickets/${key}/comments`)
      .set(bearer(consultantToken))
      .send({ body: 'We are looking at it now' })
      .expect(201);
    expect(comment.body.is_first_response).toBe(true);
    const ticket = await api().get(`/v1/tickets/${key}`).set(bearer(consultantToken)).expect(200);
    expect(ticket.body.first_response_at).not.toBeNull();
    expect(ticket.body.sla.response.met).toBe(true);
    const second = await api()
      .post(`/v1/tickets/${key}/comments`)
      .set(bearer(consultantToken))
      .send({ body: 'Update' })
      .expect(201);
    expect(second.body.is_first_response).toBe(false);
  });

  it('work notes are a separate table, visible on the internal timeline only', async () => {
    await api()
      .post(`/v1/tickets/${key}/work-notes`)
      .set(bearer(consultantToken))
      .send({ body: 'Internal: client admin is slow to respond' })
      .expect(201);
    const timeline = await api().get(`/v1/tickets/${key}/timeline`).set(bearer(consultantToken)).expect(200);
    const kinds = timeline.body.map((item: { kind: string }) => item.kind);
    expect(kinds).toContain('work_note');
    expect(kinds).toContain('comment');
    expect(kinds).toContain('audit');
    const publicTimeline = await withSuperuser((client) =>
      client.query(`select kind from acct.ticket_timeline_public where ticket_id = $1 order by created_at`, [ticketId]),
    );
    expect(publicTimeline.rows.map((row) => row.kind)).toEqual(['comment', 'comment']);
    const workNotesVisibleToPortal = await withSuperuser((client) =>
      client.query(
        `select count(*)::int as n from information_schema.role_table_grants where grantee = 'xms_portal' and table_name = 'work_notes'`,
      ),
    );
    expect(workNotesVisibleToPortal.rows[0].n).toBe(0);
  });

  it('links two tickets and rejects a cycle', async () => {
    const other = await api()
      .post('/v1/tickets')
      .set(bearer(consultantToken))
      .send({ account_id: accountId, type: 'problem', short_description: 'Root cause' })
      .expect(201);
    const links = await api()
      .post(`/v1/tickets/${key}/links`)
      .set(bearer(consultantToken))
      .send({ to_ticket_id: other.body.id, type: 'blocks' })
      .expect(201);
    expect(links.body).toHaveLength(1);
    expect(links.body[0]).toMatchObject({ type: 'blocks', direction: 'out', ticket: { key: other.body.key } });
    const cycle = await api()
      .post(`/v1/tickets/${other.body.key}/links`)
      .set(bearer(consultantToken))
      .send({ to_ticket_id: ticketId, type: 'blocks' })
      .expect(409);
    expect(cycle.body.code).toBe('link_cycle');
  });
});

describe('outbox dispatcher', () => {
  it('dispatches every pending row once, retries a failing handler and dead-letters after five attempts', async () => {
    const dispatcher = new OutboxDispatcher(pools(), 1000, false);
    const seen: string[] = [];
    dispatcher.subscribe(
      'recorder',
      () => true,
      async (row) => {
        seen.push(row.event_type);
      },
    );
    dispatcher.subscribe(
      'poison',
      (type) => type === 'ticket.created',
      async (row) => {
        if (row.payload.type === 'problem') throw new Error('cannot handle problems');
      },
    );
    const pending = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from sys.outbox where dispatched_at is null`),
    );
    expect(pending.rows[0].n).toBeGreaterThan(5);
    const processed = await dispatcher.tick();
    expect(processed).toBe(pending.rows[0].n);
    const remaining = await withSuperuser((client) =>
      client.query(`select event_type, attempts, last_error from sys.outbox where dispatched_at is null`),
    );
    expect(remaining.rows).toHaveLength(1);
    expect(remaining.rows[0]).toMatchObject({
      event_type: 'ticket.created',
      attempts: 1,
      last_error: 'poison: cannot handle problems',
    });
    for (let attempt = 0; attempt < 4; attempt += 1) await dispatcher.tick();
    const dead = await withSuperuser((client) => client.query(`select queue, error, attempts from sys.dead_letters`));
    expect(dead.rows).toEqual([{ queue: 'outbox', error: 'poison: cannot handle problems', attempts: 5 }]);
    const afterAll_ = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from sys.outbox where dispatched_at is null`),
    );
    expect(afterAll_.rows[0].n).toBe(0);
    expect(seen.filter((type) => type === 'ticket.created').length).toBeGreaterThanOrEqual(4);
  });
});

describe('usage events', () => {
  it('accepts catalog events with the principal stamped, drops foreign account ids, and records api.request rows', async () => {
    const response = await api()
      .post('/v1/telemetry')
      .set(bearer(consultantToken))
      .send({
        events: [
          {
            type: 'screen.view',
            account_id: accountId,
            attrs: { screen: 'queue', view_name: 'mine', junk: { nested: true } },
          },
          { type: 'action.completed', attrs: { action: 'ticket.create', duration_ms: 4200 } },
          { type: 'screen.view', account_id: otherAccountId, attrs: { screen: 'queue' } },
          { type: 'api.request', attrs: {} },
          { type: 'nonsense', attrs: {} },
        ],
      })
      .expect(201);
    expect(response.body).toEqual({ accepted: 2, rejected: 3 });
    await app.get(UsageEventsService).flush();
    const rows = await withSuperuser((client) =>
      client.query(
        `select event_type, account_id, actor_id, principal_kind, attrs from rpt.usage_events where actor_id = $1 and event_type <> 'api.request' order by occurred_at`,
        [consultantId],
      ),
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      event_type: 'screen.view',
      account_id: accountId,
      principal_kind: 'internal',
      attrs: { screen: 'queue', view_name: 'mine' },
    });
    expect(rows.rows[0].attrs.junk).toBeUndefined();
    const apiRows = await withSuperuser((client) =>
      client.query(`select attrs from rpt.usage_events where event_type = 'api.request' and actor_id = $1 limit 1`, [
        consultantId,
      ]),
    );
    expect(apiRows.rows[0].attrs.route).toMatch(/^POST \/v1\/tickets|^GET \/v1\/tickets|^POST \/v1\/telemetry|^PATCH/);
    expect(apiRows.rows[0].attrs.route).not.toContain('CS0');
    await expect(
      withSuperuser((client) => client.query(`delete from rpt.usage_events where actor_id = $1`, [consultantId])),
    ).rejects.toMatchObject({ code: '23001' });
    expect(app.get(DbPools)).toBeDefined();
  });
});
