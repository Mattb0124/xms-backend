import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { MAX_CALENDAR_DAYS } from '../src/modules/tickets/change-windows.module.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Change windows (TM-10, TM-18; Ticket Management functional 5.9 and 5.13).
 * A Change must belong to a change window before it can be Scheduled; a
 * window frozen over its own span, or a clash with another change on the
 * same configuration item, is a warning that must be acknowledged with a
 * reason; and the state the machine marks as deploying may only be entered
 * inside the window, or with `tickets:override-change-window` and a reason.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let caraToken: string;
let accountId: string;
let otherAccountId: string;
let openWindowId: string;
let futureWindowId: string;
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

  accountId = await newAccount('BRK', 'Brookfield');
  otherAccountId = await newAccount('ACM', 'Acme');

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
      account_ids: [accountId],
    })
    .expect(201);
  caraToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });

  openWindowId = await newWindow({ name: 'Tonight', starts_at: hours(-1), ends_at: hours(2) });
  futureWindowId = await newWindow({ name: 'Azure Files cutover', starts_at: days(10), ends_at: days(11) });
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

async function newAccount(key: string, name: string): Promise<string> {
  const account = await api().post('/v1/admin/accounts').set(bearer(adminToken)).send({ key, name }).expect(201);
  await api().post(`/v1/admin/accounts/${account.body.id}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${account.body.id}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Support retainer', model: 'retainer', period_hours: 100 })
    .expect(201);
  return account.body.id;
}

async function newWindow(body: Record<string, unknown>, account = accountId): Promise<string> {
  const created = await api()
    .post('/v1/ticket-groups')
    .set(bearer(adminToken))
    .send({ account_id: account, kind: 'change_window', status: 'active', ...body })
    .expect(201);
  return created.body.id;
}

interface Ticket {
  id: string;
  key: string;
  version: number;
}

async function newChange(description: string, groupId?: string): Promise<Ticket> {
  const created = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({
      account_id: accountId,
      type: 'change',
      short_description: description,
      ...(groupId ? { ticket_group_id: groupId } : {}),
    })
    .expect(201);
  return created.body;
}

function move(ticket: Ticket, to: string, extra: Record<string, unknown> = {}, token = adminToken) {
  return api()
    .post(`/v1/tickets/${ticket.key}/transitions`)
    .set(bearer(token))
    .send({ version: ticket.version, to, ...extra });
}

/** Straight to Approved, which is where the change window rules begin. */
async function approved(description: string, groupId?: string): Promise<Ticket> {
  let ticket = await newChange(description, groupId);
  ticket = (await move(ticket, 'assessment').expect(201)).body;
  ticket = (await move(ticket, 'approved').expect(201)).body;
  return ticket;
}

/** The API does not expose the configuration item yet; the tests set it directly. */
async function setConfigurationItem(ticketId: string, itemId: string): Promise<void> {
  await withSuperuser(async (client) => {
    await client.query('begin');
    await client.query(`select set_config('xms.audited', 'true', true)`);
    await client.query('update acct.tickets set configuration_item_id = $1 where id = $2', [itemId, ticketId]);
    await client.query('commit');
  });
}

const outboxOf = (ticketId: string, eventType: string) =>
  withSuperuser((client) =>
    client.query<{ payload: Record<string, unknown> }>(
      `select payload from sys.outbox where aggregate_id = $1 and event_type = $2`,
      [ticketId, eventType],
    ),
  ).then((result) => result.rows);

const auditOf = (ticketId: string, eventType: string) =>
  withSuperuser((client) =>
    client.query(`select new_value from acct.audit_events where entity_id = $1 and event_type = $2`, [
      ticketId,
      eventType,
    ]),
  ).then((result) => result.rows);

describe('the window a change belongs to', () => {
  it('refuses Scheduled without a change window and allows it once the change is in one', async () => {
    const ticket = await approved('Upgrade the consolidation engine');
    const refused = await move(ticket, 'scheduled').expect(409);
    expect(refused.body.code).toBe('missing_requirements');
    expect(refused.body.items).toEqual(['change_window']);

    const grouped = await api()
      .patch(`/v1/tickets/${ticket.key}`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, ticket_group_id: openWindowId })
      .expect(200);
    expect(grouped.body.ticket_group_id).toBe(openWindowId);
    expect(await auditOf(ticket.id, 'ticket.grouped')).toHaveLength(1);

    const scheduled = await move({ ...ticket, version: grouped.body.version }, 'scheduled').expect(201);
    expect(scheduled.body.state).toBe('scheduled');
  });

  it('refuses a window on another account and a cancelled one', async () => {
    const foreign = await newWindow({ name: 'Acme window', starts_at: hours(-1), ends_at: hours(2) }, otherAccountId);
    const ticket = await newChange('Foreign window');
    const refused = await api()
      .patch(`/v1/tickets/${ticket.key}`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, ticket_group_id: foreign })
      .expect(404);
    expect(refused.body.code).toBe('not_found');

    const doomed = await newWindow({ name: 'Called off', starts_at: days(30), ends_at: days(31) });
    const record = await api().get(`/v1/ticket-groups/${doomed}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/ticket-groups/${doomed}`)
      .set(bearer(adminToken))
      .send({ version: record.body.version, status: 'cancelled' })
      .expect(200);
    const cancelled = await api()
      .patch(`/v1/tickets/${ticket.key}`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, ticket_group_id: doomed })
      .expect(400);
    expect(cancelled.body.code).toBe('ticket_group_cancelled');
  });

  it('refuses a change window without both ends and a freeze that ends before it starts', async () => {
    const noSchedule = await api()
      .post('/v1/ticket-groups')
      .set(bearer(adminToken))
      .send({ account_id: accountId, kind: 'change_window', name: 'No schedule' })
      .expect(400);
    expect(noSchedule.body.code).toBe('invalid_schedule');
    expect(noSchedule.body.problems).toContain('a change window needs a start and an end');

    // A project may exist before it is scheduled.
    await api()
      .post('/v1/ticket-groups')
      .set(bearer(adminToken))
      .send({ account_id: accountId, kind: 'project', name: 'Migration programme' })
      .expect(201);

    const backwards = await api()
      .post('/v1/ticket-groups')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        kind: 'change_window',
        name: 'Backwards freeze',
        starts_at: days(40),
        ends_at: days(41),
        freeze_windows: [{ starts_at: days(41), ends_at: days(40) }],
      })
      .expect(400);
    expect(backwards.body.problems).toContain('freeze 0: ends_at must be after starts_at');
  });
});

describe('freezes and clashes when scheduling (TM-18)', () => {
  it('refuses a schedule inside a freeze window and lets a reason acknowledge it', async () => {
    const ticket = await approved('Patch the reporting node', frozenWindowId);
    const refused = await move(ticket, 'scheduled').expect(409);
    expect(refused.body.code).toBe('change_freeze');
    expect(refused.body.freeze).toMatchObject({ reason: 'Year end close' });

    const acknowledged = await move(ticket, 'scheduled', {
      change_window_reason: 'Client asked for it in writing; the freeze is waived for this change.',
    }).expect(201);
    expect(acknowledged.body.state).toBe('scheduled');
    const audit = await auditOf(ticket.id, 'ticket.change_window_acknowledged');
    expect(audit).toHaveLength(1);
    expect(audit[0].new_value).toMatchObject({ reason: expect.stringContaining('in writing') });
  });

  it('refuses a second change on the same configuration item in an overlapping window', async () => {
    const item = randomUUID();
    const first = await approved('First on the file server', openWindowId);
    await setConfigurationItem(first.id, item);
    const scheduled = await move(first, 'scheduled').expect(201);
    expect(scheduled.body.state).toBe('scheduled');

    const second = await approved('Second on the file server', openWindowId);
    await setConfigurationItem(second.id, item);
    const refused = await move(second, 'scheduled').expect(409);
    expect(refused.body.code).toBe('change_conflict');
    expect(refused.body.conflicts.map((row: { key: string }) => row.key)).toContain(first.key);

    const acknowledged = await move(second, 'scheduled', {
      change_window_reason: 'Both changes are the same engineer working the same evening.',
    }).expect(201);
    expect(acknowledged.body.state).toBe('scheduled');
    const audit = await auditOf(second.id, 'ticket.change_window_acknowledged');
    expect(audit[0].new_value).toMatchObject({ conflicts: [first.key] });
  });
});

describe('implementing inside the window', () => {
  it('allows implementation inside the window and refuses it outside without an override', async () => {
    const inside = await approved('Inside the window tonight', openWindowId);
    const scheduledInside = (await move(inside, 'scheduled').expect(201)).body;
    const implementing = await move({ ...inside, version: scheduledInside.version }, 'implementing').expect(201);
    expect(implementing.body.state).toBe('implementing');

    const outside = await approved('Ten days away', futureWindowId);
    const scheduledOutside = (await move(outside, 'scheduled').expect(201)).body;
    const refused = await move({ ...outside, version: scheduledOutside.version }, 'implementing').expect(409);
    expect(refused.body.code).toBe('outside_change_window');
    expect(refused.body).toMatchObject({
      window: 'Azure Files cutover',
      permission: 'tickets:override-change-window',
    });

    // A reason without the permission is still a refusal.
    const withoutPermission = await move(
      { ...outside, version: scheduledOutside.version },
      'implementing',
      { change_window_reason: 'The client is waiting.' },
      caraToken,
    ).expect(409);
    expect(withoutPermission.body.code).toBe('outside_change_window');

    // The permission plus a reason gets through, and the override is audited.
    const overridden = await move({ ...outside, version: scheduledOutside.version }, 'implementing', {
      change_window_reason: 'P1 incident forced the change forward; the client approved by phone.',
    }).expect(201);
    expect(overridden.body.state).toBe('implementing');
    const audit = await auditOf(outside.id, 'ticket.change_window_overridden');
    expect(audit).toHaveLength(1);
    expect(audit[0].new_value).toMatchObject({ window: 'Azure Files cutover' });

    // An override of a freeze is announced, not only recorded: the
    // connector, the notification fan-out and any client alerting all read
    // the outbox, and the audit table is not a thing they query.
    const published = await outboxOf(outside.id, 'ticket.change_window_overridden');
    expect(published).toHaveLength(1);
    expect(published[0].payload).toMatchObject({
      window: 'Azure Files cutover',
      reason: 'P1 incident forced the change forward; the client approved by phone.',
      window_id: futureWindowId,
    });
  });

  it('publishes the acknowledgement of a freeze as well as auditing it', async () => {
    const ticket = await approved('Scheduled across the year-end freeze', frozenWindowId);
    const bare = await move(ticket, 'scheduled').expect(409);
    expect(bare.body.code).toBe('change_freeze');
    const acknowledged = await move(ticket, 'scheduled', {
      change_window_reason: 'Regulatory deadline; the client accepted the risk in writing.',
    }).expect(201);
    expect(acknowledged.body.state).toBe('scheduled');

    expect(await auditOf(ticket.id, 'ticket.change_window_acknowledged')).toHaveLength(1);
    const published = await outboxOf(ticket.id, 'ticket.change_window_acknowledged');
    expect(published).toHaveLength(1);
    expect(published[0].payload).toMatchObject({
      reason: 'Regulatory deadline; the client accepted the risk in writing.',
      window_id: frozenWindowId,
    });
  });
});

describe('who owns the schedule of a change window', () => {
  /**
   * The deploy gate refuses a change outside its window unless the caller
   * holds `tickets:override-change-window`, and it reads a row that used to
   * be editable by any `tickets:work` holder. A consultant who could clear
   * the freeze and widen the span would never need the permission at all.
   */
  it('refuses a tickets:work principal the freeze, the span and a new window', async () => {
    const windowId = await newWindow({
      name: 'Payroll freeze',
      starts_at: days(30),
      ends_at: days(31),
      freeze_windows: [{ starts_at: days(29), ends_at: days(32), reason: 'Payroll run' }],
    });
    const current = await api().get(`/v1/ticket-groups/${windowId}`).set(bearer(adminToken)).expect(200);

    const cleared = await api()
      .patch(`/v1/ticket-groups/${windowId}`)
      .set(bearer(caraToken))
      .send({ version: current.body.version, freeze_windows: [] })
      .expect(403);
    expect(cleared.body).toMatchObject({ code: 'forbidden', permission: 'tickets:override-change-window' });

    await api()
      .patch(`/v1/ticket-groups/${windowId}`)
      .set(bearer(caraToken))
      .send({ version: current.body.version, starts_at: days(1), ends_at: days(40) })
      .expect(403);

    await api()
      .post('/v1/ticket-groups')
      .set(bearer(caraToken))
      .send({
        account_id: accountId,
        kind: 'change_window',
        status: 'active',
        name: 'A window of my own',
        starts_at: hours(-1),
        ends_at: hours(2),
      })
      .expect(403);

    // The same principal still owns projects and the parts of a window that
    // do not decide when a change may ship.
    const project = await api()
      .post('/v1/ticket-groups')
      .set(bearer(caraToken))
      .send({ account_id: accountId, kind: 'project', name: 'Migration wave 2' })
      .expect(201);
    await api()
      .patch(`/v1/ticket-groups/${windowId}`)
      .set(bearer(caraToken))
      .send({ version: current.body.version, description: 'Owned by Finance' })
      .expect(200);
    expect(project.body.kind).toBe('project');
  });

  it('makes an override name its reason and records the freeze on both sides', async () => {
    const windowId = await newWindow({
      name: 'Quarter close',
      starts_at: days(40),
      ends_at: days(41),
      freeze_windows: [{ starts_at: days(39), ends_at: days(42), reason: 'Quarter close' }],
    });
    const current = await api().get(`/v1/ticket-groups/${windowId}`).set(bearer(adminToken)).expect(200);

    const bare = await api()
      .patch(`/v1/ticket-groups/${windowId}`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, freeze_windows: [] })
      .expect(400);
    expect(bare.body.code).toBe('reason_required');

    const patched = await api()
      .patch(`/v1/ticket-groups/${windowId}`)
      .set(bearer(adminToken))
      .send({
        version: current.body.version,
        freeze_windows: [],
        change_window_reason: 'Client asked for the security patch inside the freeze',
      })
      .expect(200);
    expect(patched.body.freeze_windows).toEqual([]);

    const audit = await withSuperuser((client) =>
      client.query(
        `select old_value, new_value from acct.audit_events where entity_id = $1 and event_type = 'updated' order by created_at desc limit 1`,
        [windowId],
      ),
    ).then((result) => result.rows[0]);
    expect(audit.old_value.freeze_windows).toHaveLength(1);
    expect(audit.new_value.freeze_windows).toEqual([]);
    expect(audit.new_value.change_window_reason).toContain('security patch');

    const published = await withSuperuser((client) =>
      client.query(
        `select payload from sys.outbox where aggregate_id = $1 and event_type = 'ticket_group.freeze_changed'`,
        [windowId],
      ),
    ).then((result) => result.rows);
    expect(published).toHaveLength(1);
    expect(published[0].payload.was).toHaveLength(1);
    expect(published[0].payload.freeze_windows).toEqual([]);
    expect(published[0].payload.reason).toContain('security patch');
  });
});

describe('the change calendar', () => {
  it('answers whether an instant is inside a window and lists the windows of a range', async () => {
    const now = await api().get(`/v1/change-calendar/at?account_id=${accountId}`).set(bearer(adminToken)).expect(200);
    expect(now.body.inside).toBe(true);
    expect(now.body.windows.map((row: { name: string }) => row.name)).toEqual(['Tonight']);

    const later = await api()
      .get(`/v1/change-calendar/at?account_id=${accountId}&at=${encodeURIComponent(days(5))}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(later.body).toMatchObject({ inside: false, windows: [] });

    // Inside the year-end window, but frozen, so not open for work.
    const frozen = await api()
      .get(`/v1/change-calendar/at?account_id=${accountId}&at=${encodeURIComponent(days(20.5))}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(frozen.body).toMatchObject({ inside: false, frozen: true });
    expect(frozen.body.windows[0].freeze).toMatchObject({ reason: 'Year end close' });

    const calendar = await api()
      .get(
        `/v1/change-calendar?account_id=${accountId}&from=${encodeURIComponent(hours(-2))}&to=${encodeURIComponent(days(30))}`,
      )
      .set(bearer(adminToken))
      .expect(200);
    const names = calendar.body.windows.map((row: { name: string }) => row.name);
    expect(names).toContain('Tonight');
    expect(names).toContain('Azure Files cutover');
    const tonight = calendar.body.windows.find((row: { name: string }) => row.name === 'Tonight');
    expect(tonight.tickets.length).toBeGreaterThan(0);

    // The tickets of every window on the page come from one query, so the
    // read costs the same whether the page holds one window or many.
    for (const window of calendar.body.windows) expect(Array.isArray(window.tickets)).toBe(true);

    // A range wider than a calendar is ever read at is refused rather than
    // returning every change window ever recorded.
    const wide = await api()
      .get('/v1/change-calendar?from=1900-01-01T00:00:00.000Z&to=2999-12-31T00:00:00.000Z')
      .set(bearer(adminToken))
      .expect(400);
    expect(wide.body).toMatchObject({ code: 'range_too_wide', max_days: MAX_CALENDAR_DAYS });

    // A year is inside the cap, and a backwards range is its own refusal.
    await api()
      .get(`/v1/change-calendar?from=${encodeURIComponent(days(-300))}&to=${encodeURIComponent(days(60))}`)
      .set(bearer(adminToken))
      .expect(200);
    const backwards = await api()
      .get(`/v1/change-calendar?from=${encodeURIComponent(days(10))}&to=${encodeURIComponent(days(1))}`)
      .set(bearer(adminToken))
      .expect(400);
    expect(backwards.body.code).toBe('invalid_range');

    // Another account's window is never in the answer.
    const foreign = await api()
      .get(`/v1/change-calendar/at?account_id=${otherAccountId}&at=${encodeURIComponent(days(5))}`)
      .set(bearer(caraToken))
      .expect(404);
    expect(foreign.body.code).toBe('not_found');
  });
});
