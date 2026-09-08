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
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Settling a recorded sync conflict by hand (SN-04; render 07's "Accept"
 * and "Keep ours"). The conflicts are written onto the link as the sync
 * worker writes them, so the route is exercised without a poll: what the
 * worker records is asserted in connectors.int-spec, and what the route
 * does with it is asserted here.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let consultantToken: string;
let accountId: string;
let instanceId: string;

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
    .send({ name: 'Retainer', model: 'retainer', period_hours: 40 })
    .expect(201);
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
  consultantToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  const instance = await api()
    .post(`/v1/accounts/${accountId}/connectors/servicenow`)
    .set(bearer(adminToken))
    .send({
      name: 'Brookfield CSM',
      base_url: 'https://brookfield.service-now.test',
      auth_kind: 'basic',
      credential: { username: 'xms.integration', password: 'stand-in' },
      profile: 'csm',
    })
    .expect(201);
  instanceId = instance.body.id;
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function newTicket(body: Record<string, unknown>): Promise<{ id: string; key: string; version: number }> {
  const created = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: accountId, type: 'incident', ...body })
    .expect(201);
  return created.body;
}

/** A link carrying the conflict the worker would have written, without a poll. */
async function linkWithConflict(ticketId: string, conflict: Record<string, unknown>): Promise<string> {
  const sysId = randomUUID().replace(/-/g, '');
  return withSuperuser(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into acct.sync_links
         (account_id, instance_id, ticket_id, external_sys_id, external_number, state, last_conflict)
       values ($1, $2, $3, $4, $5, 'conflict', $6) returning id`,
      [accountId, instanceId, ticketId, sysId, `INC${sysId.slice(0, 7)}`, JSON.stringify(conflict)],
    );
    return inserted.rows[0].id;
  });
}

function inboundConflict(values: Record<string, unknown>): Record<string, unknown> {
  return {
    direction: 'in',
    fields: Object.keys(values),
    values,
    at: '2026-09-04T08:59:00.000Z',
    sys_updated_on: '2026-09-04 08:59:00',
  };
}

async function linkRow(linkId: string): Promise<{ state: string; last_conflict: Record<string, unknown> }> {
  const rows = await withSuperuser((client) =>
    client.query<{ state: string; last_conflict: Record<string, unknown> }>(
      'select state, last_conflict from acct.sync_links where id = $1',
      [linkId],
    ),
  );
  return rows.rows[0];
}

describe('settling a sync conflict by hand (render 07)', () => {
  it('accepts the external value through the ticket update path and records the decision', async () => {
    const ticket = await newTicket({ short_description: 'Consolidation fails', category: 'Consolidation' });
    const linkId = await linkWithConflict(ticket.id, inboundConflict({ category: 'Financial close' }));

    const resolved = await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, field: 'category', choice: 'accept_external' })
      .expect(201);
    expect(resolved.body).toMatchObject({
      link_id: linkId,
      field: 'category',
      choice: 'accept_external',
      link_state: 'linked',
      settled_fields: ['category'],
      outstanding_fields: [],
    });
    expect(resolved.body.ticket_version).toBe(ticket.version + 1);

    // The client's value is on the ticket, written the way any edit is.
    const after = await api().get(`/v1/tickets/${ticket.id}`).set(bearer(adminToken)).expect(200);
    expect(after.body.category).toBe('Financial close');
    expect(after.body.version).toBe(ticket.version + 1);

    // The link says who settled it and what they chose, and leaves conflict.
    const link = await linkRow(linkId);
    expect(link.state).toBe('linked');
    expect(link.last_conflict.resolved).toMatchObject([
      { field: 'category', choice: 'accept_external', by_name: expect.any(String) },
    ]);
    expect(link.last_conflict.values).toEqual({ category: 'Financial close' });

    // The edit and the decision are both on the audit trail.
    const audit = await withSuperuser((client) =>
      client.query<{ event_type: string }>(
        `select event_type from acct.audit_events where ticket_id = $1 order by created_at`,
        [ticket.id],
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toContain('connector.conflict.resolved');
    expect(audit.rows.map((row) => row.event_type)).toContain('ticket.updated');
  });

  it('leaves the ticket alone when ours is kept, and still marks the conflict settled', async () => {
    const ticket = await newTicket({ short_description: 'Owned by XMS after intake' });
    const linkId = await linkWithConflict(ticket.id, inboundConflict({ short_description: 'Renamed by the client' }));

    const resolved = await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, field: 'short_description', choice: 'keep_ours' })
      .expect(201);
    expect(resolved.body).toMatchObject({ choice: 'keep_ours', link_state: 'linked', ticket_version: ticket.version });

    const after = await api().get(`/v1/tickets/${ticket.id}`).set(bearer(adminToken)).expect(200);
    expect(after.body.short_description).toBe('Owned by XMS after intake');
    expect(after.body.version).toBe(ticket.version);

    const link = await linkRow(linkId);
    expect(link.state).toBe('linked');
    expect(link.last_conflict.resolved).toMatchObject([{ field: 'short_description', choice: 'keep_ours' }]);
  });

  it('refuses a field the conflict does not name, a link on another ticket and a reader without the permission', async () => {
    const ticket = await newTicket({ short_description: 'Feed failed overnight', category: 'Interfaces' });
    const other = await newTicket({ short_description: 'Nothing to do with it' });
    const linkId = await linkWithConflict(ticket.id, inboundConflict({ category: 'Integrations' }));

    const unknown = await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, field: 'priority', choice: 'accept_external' })
      .expect(400);
    expect(unknown.body).toMatchObject({ code: 'unknown_conflict_field', field: 'priority', fields: ['category'] });

    // The link belongs to another ticket, so it is not found on this one.
    await api()
      .post(`/v1/tickets/${other.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: other.version, field: 'category', choice: 'accept_external' })
      .expect(404);

    // Settling a conflict is a connector decision, not a queue one.
    await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(consultantToken))
      .send({ version: ticket.version, field: 'category', choice: 'keep_ours' })
      .expect(403);

    // Nothing above touched the ticket or the link.
    const after = await api().get(`/v1/tickets/${ticket.id}`).set(bearer(adminToken)).expect(200);
    expect(after.body.category).toBe('Interfaces');
    expect((await linkRow(linkId)).state).toBe('conflict');
  });

  it('keeps the link in conflict until every field has an answer, and settles none of them twice', async () => {
    const ticket = await newTicket({ short_description: 'Both sides moved', category: 'Consolidation' });
    const linkId = await linkWithConflict(
      ticket.id,
      inboundConflict({ category: 'Financial close', short_description: 'Renamed by the client' }),
    );

    const first = await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, field: 'category', choice: 'accept_external' })
      .expect(201);
    expect(first.body).toMatchObject({ link_state: 'conflict', outstanding_fields: ['short_description'] });

    const again = await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: first.body.ticket_version, field: 'category', choice: 'keep_ours' })
      .expect(409);
    expect(again.body).toMatchObject({ code: 'conflict_already_settled', field: 'category' });

    const second = await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: first.body.ticket_version, field: 'short_description', choice: 'keep_ours' })
      .expect(201);
    expect(second.body).toMatchObject({ link_state: 'linked', outstanding_fields: [] });

    const link = await linkRow(linkId);
    expect((link.last_conflict.resolved as { field: string }[]).map((one) => one.field)).toEqual([
      'category',
      'short_description',
    ]);
    // The Sync card reads the link, so the settled decisions reach the screen.
    const card = await api().get(`/v1/tickets/${ticket.id}/sync`).set(bearer(adminToken)).expect(200);
    expect(card.body.links[0].last_conflict.resolved).toHaveLength(2);
  });

  it('refuses to accept a conflict that kept no external value', async () => {
    const ticket = await newTicket({ short_description: 'Recorded before the values were kept' });
    const linkId = await linkWithConflict(ticket.id, {
      direction: 'in',
      fields: ['category'],
      at: '2026-09-04T08:59:00.000Z',
      sys_updated_on: '2026-09-04 08:59:00',
    });

    const refused = await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, field: 'category', choice: 'accept_external' })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'external_value_unknown', field: 'category' });

    // Keeping ours needs no external value, so it still settles.
    await api()
      .post(`/v1/tickets/${ticket.id}/sync/${linkId}/conflict`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, field: 'category', choice: 'keep_ours' })
      .expect(201);
    expect((await linkRow(linkId)).state).toBe('linked');
  });
});
