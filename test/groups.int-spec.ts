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
 * Assignment groups (TM-08; Accounts & Administration functional 5.6). The
 * catalog and its membership are operator-scoped, because the same CSM,
 * OneStream Technical and Infrastructure teams work every account; the
 * routing defaults that say which group takes which kind of work are the
 * account's own answer and are account-scoped.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let caraToken: string;
let deshToken: string;
let accountId: string;
let caraId: string;
let deshId: string;
let onestreamId: string;
let infraId: string;

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
    .send({ name: 'Support retainer', model: 'retainer', period_hours: 100 })
    .expect(201);

  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const consultant = roles.body.find((role: { name: string }) => role.name === 'Consultant');
  caraId = (
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
      .expect(201)
  ).body.id;
  caraToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  deshId = (
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'desh@example.test',
        first_name: 'Desh',
        last_name: 'Rao',
        role_ids: [consultant.id],
        account_ids: [accountId],
      })
      .expect(201)
  ).body.id;
  deshToken = await devToken({ sub: 'dev_desh', email: 'desh@example.test', sid: 'sess_desh' });

  onestreamId = (
    await api()
      .post('/v1/admin/groups')
      .set(bearer(adminToken))
      .send({ name: 'OneStream Technical', description: 'Platform work', service_line: 'OneStream' })
      .expect(201)
  ).body.id;
  infraId = (await api().post('/v1/admin/groups').set(bearer(adminToken)).send({ name: 'Infrastructure' }).expect(201))
    .body.id;
  await api()
    .put(`/v1/admin/groups/${onestreamId}/members`)
    .set(bearer(adminToken))
    .send({ user_ids: [caraId] })
    .expect(200);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function newTicket(
  description: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; key: string; version: number; group_id: string | null }> {
  const created = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: accountId, type: 'incident', short_description: description, ...extra })
    .expect(201);
  return created.body;
}

describe('assignment groups on the ticket', () => {
  it('assigns a ticket to a group, lists by it, and records the change in the audit and the outbox', async () => {
    const ticket = await newTicket('Consolidation run fails');
    expect(ticket.group_id).toBeNull();

    const assigned = await api()
      .patch(`/v1/tickets/${ticket.key}`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, group_id: onestreamId })
      .expect(200);
    expect(assigned.body.group_id).toBe(onestreamId);

    const listed = await api()
      .get(`/v1/tickets?account_id=${accountId}&group_id=${onestreamId}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(listed.body.items.map((item: { key: string }) => item.key)).toContain(ticket.key);

    const audit = await withSuperuser((client) =>
      client.query(
        `select old_value, new_value from acct.audit_events where event_type = 'ticket.group_assigned' and entity_id = $1`,
        [ticket.id],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].new_value).toBe(onestreamId);
    const outbox = await withSuperuser((client) =>
      client.query(`select payload from sys.outbox where event_type = 'ticket.group_assigned' and aggregate_id = $1`, [
        ticket.id,
      ]),
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload).toMatchObject({ group_id: onestreamId, previous_group_id: null });
  });

  it('refuses a retired group and an unknown one', async () => {
    const ticket = await newTicket('Retired group');
    const retired = await api().get(`/v1/admin/groups/${infraId}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/admin/groups/${infraId}`)
      .set(bearer(adminToken))
      .send({ version: retired.body.version, status: 'retired' })
      .expect(200);
    const refused = await api()
      .patch(`/v1/tickets/${ticket.key}`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, group_id: infraId })
      .expect(400);
    expect(refused.body.code).toBe('group_retired');
    // Put it back so the routing rules below can name it.
    const again = await api().get(`/v1/admin/groups/${infraId}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/admin/groups/${infraId}`)
      .set(bearer(adminToken))
      .send({ version: again.body.version, status: 'active' })
      .expect(200);
  });
});

describe('the group queue', () => {
  it('shows a member the tickets of their groups and shows an outsider none of them', async () => {
    const mine = await newTicket('Cash flow rule broken');
    await api()
      .patch(`/v1/tickets/${mine.key}`)
      .set(bearer(adminToken))
      .send({ version: mine.version, group_id: onestreamId })
      .expect(200);
    const theirs = await newTicket('Server patching window');
    await api()
      .patch(`/v1/tickets/${theirs.key}`)
      .set(bearer(adminToken))
      .send({ version: theirs.version, group_id: infraId })
      .expect(200);

    // Cara is in OneStream Technical, so her group queue holds the first and
    // not the second.
    const queue = await api().get('/v1/tickets?my_groups=true&open=true').set(bearer(caraToken)).expect(200);
    const keys = queue.body.items.map((item: { key: string }) => item.key);
    expect(keys).toContain(mine.key);
    expect(keys).not.toContain(theirs.key);

    // Desh belongs to no group: an empty queue, not an unfiltered one.
    const none = await api().get('/v1/tickets?my_groups=true&open=true').set(bearer(deshToken)).expect(200);
    expect(none.body.items).toEqual([]);
  });

  it('carries the group queue in a saved view and shares that view with the group', async () => {
    const view = await api()
      .post('/v1/views')
      .set(bearer(caraToken))
      .send({
        account_id: accountId,
        name: 'My groups',
        share: 'group',
        share_ref: onestreamId,
        definition: { conditions: { conditions: [{ field: 'group_id', op: 'is_mine' }] } },
      })
      .expect(201);

    const listed = await api().get(`/v1/tickets?view=${view.body.id}&open=true`).set(bearer(caraToken)).expect(200);
    for (const item of listed.body.items) expect(item.group_id).toBe(onestreamId);
    expect(listed.body.items.length).toBeGreaterThan(0);

    // The view is shared with the group, so its members see it and a person
    // outside the group does not.
    const hers = await api().get('/v1/views').set(bearer(caraToken)).expect(200);
    expect(hers.body.map((row: { id: string }) => row.id)).toContain(view.body.id);
    const his = await api().get('/v1/views').set(bearer(deshToken)).expect(200);
    expect(his.body.map((row: { id: string }) => row.id)).not.toContain(view.body.id);
  });
});

describe('routing defaults', () => {
  it('dispatches a new ticket to the account default and prefers the rule naming the category', async () => {
    await api()
      .put(`/v1/accounts/${accountId}/routing-rules`)
      .set(bearer(adminToken))
      .send({
        rules: [
          { ticket_type: 'incident', group_id: onestreamId },
          { ticket_type: 'incident', category: 'network', group_id: infraId },
        ],
      })
      .expect(200);

    const plain = await newTicket('Rule fails without a category');
    expect(plain.group_id).toBe(onestreamId);
    const network = await newTicket('Link down', { category: 'network' });
    expect(network.group_id).toBe(infraId);
    // What the caller asks for wins over the default.
    const chosen = await newTicket('Chosen by the dispatcher', { group_id: infraId });
    expect(chosen.group_id).toBe(infraId);

    const audit = await withSuperuser((client) =>
      client.query(
        `select new_value from acct.audit_events where event_type = 'ticket.group_assigned' and entity_id = $1`,
        [plain.id],
      ),
    );
    expect(audit.rows[0].new_value).toBe(onestreamId);
    const outbox = await withSuperuser((client) =>
      client.query(`select payload from sys.outbox where event_type = 'ticket.group_assigned' and aggregate_id = $1`, [
        plain.id,
      ]),
    );
    expect(outbox.rows[0].payload).toMatchObject({ source: 'routing_default' });
  });

  it('replaces the whole set and refuses a rule naming a type outside the vocabulary', async () => {
    const replaced = await api()
      .put(`/v1/accounts/${accountId}/routing-rules`)
      .set(bearer(adminToken))
      .send({ rules: [{ ticket_type: 'change', group_id: infraId }] })
      .expect(200);
    expect(replaced.body).toHaveLength(1);
    expect(replaced.body[0]).toMatchObject({ ticket_type: 'change', category: null, group_name: 'Infrastructure' });
    // The incident rules are gone, so a new incident carries no group.
    const orphan = await newTicket('No rule any more');
    expect(orphan.group_id).toBeNull();

    await api()
      .put(`/v1/accounts/${accountId}/routing-rules`)
      .set(bearer(adminToken))
      .send({ rules: [{ ticket_type: 'question', group_id: infraId }] })
      .expect(400);
  });

  it('keeps the catalog and the routing defaults behind their permissions', async () => {
    // Cara works tickets; she administers neither users nor configuration.
    await api().post('/v1/admin/groups').set(bearer(caraToken)).send({ name: 'Rogue team' }).expect(403);
    await api()
      .put(`/v1/admin/groups/${onestreamId}/members`)
      .set(bearer(caraToken))
      .send({ user_ids: [deshId] })
      .expect(403);
    await api().put(`/v1/accounts/${accountId}/routing-rules`).set(bearer(caraToken)).send({ rules: [] }).expect(403);
    // Reading the pickers is part of seeing the desk.
    await api().get('/v1/groups').set(bearer(caraToken)).expect(200);
    await api().get(`/v1/accounts/${accountId}/routing-rules`).set(bearer(caraToken)).expect(200);
  });
});

describe('group membership', () => {
  it('lists the open tickets a departing member still holds so they can be reassigned', async () => {
    const held = await newTicket('Still on Cara');
    await api()
      .patch(`/v1/tickets/${held.key}`)
      .set(bearer(adminToken))
      .send({ version: held.version, assignee_id: caraId, group_id: onestreamId })
      .expect(200);

    const removed = await api()
      .put(`/v1/admin/groups/${onestreamId}/members`)
      .set(bearer(adminToken))
      .send({ user_ids: [deshId] })
      .expect(200);
    expect(removed.body.members.map((member: { user_id: string }) => member.user_id)).toEqual([deshId]);
    expect(removed.body.reassign.map((row: { key: string }) => row.key)).toContain(held.key);
    expect(removed.body.reassign[0]).toMatchObject({ assignee_id: caraId, account_id: accountId });

    // Cara is out of the group, so her group queue no longer holds its work.
    const queue = await api().get('/v1/tickets?my_groups=true&open=true').set(bearer(caraToken)).expect(200);
    expect(queue.body.items).toEqual([]);
  });
});
