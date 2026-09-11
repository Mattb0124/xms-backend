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
import { ContainerJobs } from '../src/worker/container-jobs.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Container-case detection (TM-27) end to end: a ticket that has quietly
 * become a project is raised as a TM-11 out-of-scope flag by the sweep, with
 * the reason naming the threshold it crossed, and the account owner (TM-23)
 * is told. The decision stays a person's; the sweep only asks the question.
 */
const ADMIN_EMAIL = 'admin@example.test';
const today = new Date().toISOString().slice(0, 10);

let app: INestApplication;
let worker: INestApplication;
let containers: ContainerJobs;
let adminToken: string;
let adminId: string;
let accountId: string;
let caraId: string;
let settingsVersion: number;

const api = (): request.Agent => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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
  const { WorkerModule } = await import('../src/worker/worker.module.js');
  const apiRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = apiRef.createNestApplication({ bufferLogs: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  const workerRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  worker = workerRef.createNestApplication({ bufferLogs: true });
  await worker.init();
  containers = worker.get(ContainerJobs);

  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  const bootstrapped = await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  adminId = bootstrapped.body.userId;

  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  accountId = account.body.id;
  // Activation establishes the owner (TM-23): the administrator who took it
  // live, which is who the detector will notify.
  await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer', period_hours: 40 })
    .expect(201);

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
  caraId = user.body.id;
  // Cara signs in once: an invited user is not assignable.
  const caraToken = await devToken({ sub: 'dev_cara', email: 'cara@example.test', sid: 'sess_cara' });
  await api().get('/v1/admin/me').set(bearer(caraToken)).expect(200);
  const settings = await api().get(`/v1/admin/accounts/${accountId}/settings`).set(bearer(adminToken)).expect(200);
  settingsVersion = settings.body.version;
});

/**
 * A raw change to a ticket for setup the API has no route for (backdating,
 * forcing a closed state). `acct.tickets` carries a deferred constraint
 * trigger requiring an audit event in the same transaction, which is the
 * platform doing its job, so the helper writes one rather than working
 * around it.
 */
async function rawTicketUpdate(number: string, set: string): Promise<void> {
  await withSuperuser(async (client) => {
    await client.query('begin');
    await client.query(`update acct.tickets set ${set} where number = $1`, [number]);
    await client.query(
      `insert into acct.audit_events (account_id, entity_kind, entity_id, ticket_id, event_type, actor_kind, actor_id, actor_name)
       select account_id, 'ticket', id, id, 'ticket.updated', 'system', 'test-setup', 'Test setup'
         from acct.tickets where number = $1`,
      [number],
    );
    await client.query('commit');
  });
}

const numberOf = (key: string): string => key.replace(/^CS0*/, '');

afterAll(async () => {
  await worker?.close();
  await app?.close();
  await closePools();
});

/** An open ticket with `entries` hours logged against it. */
async function ticketWithTime(description: string, entries: number, assignTo?: string): Promise<string> {
  const ticket = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({ account_id: accountId, type: 'incident', short_description: description, impact: 'high', urgency: 'high' })
    .expect(201);
  let version = 1;
  const moved = await api()
    .post(`/v1/tickets/${ticket.body.key}/transitions`)
    .set(bearer(adminToken))
    .send({ version, to: 'in_progress' })
    .expect(201);
  version = moved.body.version;
  if (assignTo) {
    const assigned = await api()
      .patch(`/v1/tickets/${ticket.body.key}`)
      .set(bearer(adminToken))
      .send({ version, assignee_id: assignTo })
      .expect(200);
    version = assigned.body.version;
  }
  for (let i = 0; i < entries; i += 1) {
    await api()
      .post(`/v1/tickets/${ticket.body.key}/time`)
      .set(bearer(adminToken))
      .send({ performed_on: today, minutes: 60, activity_type: 'analysis' })
      .expect(201);
  }
  return ticket.body.key;
}

const ticketRow = (key: string) =>
  withSuperuser((client) =>
    client.query<{ id: string; out_of_scope: string; container_detected_at: string | null; detail: unknown }>(
      `select id, out_of_scope, container_detected_at, out_of_scope_detail as detail
         from acct.tickets where number = $1`,
      [numberOf(key)],
    ),
  ).then((result) => result.rows[0]);

describe('container-case detection', () => {
  it('does nothing at all on an account that has set no threshold', async () => {
    const key = await ticketWithTime('Untouched by a detector nobody switched on', 6);
    expect(await containers.sweep()).toBe('flagged 0');
    expect((await ticketRow(key)).out_of_scope).toBe('none');
  });

  it('raises the TM-11 flag with the threshold named, and tells the account owner', async () => {
    const key = await ticketWithTime('Monthly close support', 5, caraId);
    const updated = await api()
      .put(`/v1/admin/accounts/${accountId}/settings`)
      .set(bearer(adminToken))
      .send({ version: settingsVersion, container_time_entries: 5 })
      .expect(200);
    settingsVersion = updated.body.version;

    // Two: this ticket, and the one the first test left sitting on six
    // entries. Switching a threshold on catches the backlog it was set for,
    // which is the point of setting it.
    expect(await containers.sweep()).toBe('flagged 2');
    const row = await ticketRow(key);
    expect(row.out_of_scope).toBe('flagged');
    expect(row.container_detected_at).not.toBeNull();
    const detail = row.detail as { reason: string; flagged_by: string; flagged_by_name: string };
    expect(detail.reason).toContain('5 time entries against a threshold of 5');
    // The flag says a detector raised it, not a colleague nobody can ask.
    expect(detail.flagged_by).toBe('container-detection');
    expect(detail.flagged_by_name).toBe('Container detection');

    const audit = await withSuperuser((client) =>
      client.query<{ actor_kind: string; actor_id: string; new_value: { detector: string } }>(
        `select actor_kind, actor_id, new_value from acct.audit_events
          where ticket_id = $1 and event_type = 'ticket.scope_flagged'`,
        [row.id],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'system', actor_id: 'container-detection' });
    expect(audit.rows[0].new_value.detector).toBe('container');

    // A flag is an internal opinion until somebody answers it: the client
    // record of it is written invisible, exactly as a consultant's is.
    const decision = await withSuperuser((client) =>
      client.query<{ event: string; client_visible: boolean; actor_id: string }>(
        `select event, client_visible, actor_id from acct.scope_decisions where ticket_id = $1`,
        [row.id],
      ),
    );
    expect(decision.rows).toEqual([
      expect.objectContaining({ event: 'flagged', client_visible: false, actor_id: 'container-detection' }),
    ]);

    const notified = await withSuperuser((client) =>
      client.query<{ recipient_id: string; type: string }>(
        `select recipient_id, type from acct.notifications where target_id = $1 order by recipient_id`,
        [row.id],
      ),
    );
    const recipients = notified.rows.map((n) => n.recipient_id);
    // The owner is the one TM-27 names; the assignee is told too, because
    // their ticket changed under them.
    expect(recipients).toContain(adminId);
    expect(recipients).toContain(caraId);

    const published = await withSuperuser((client) =>
      client.query(`select 1 from sys.outbox where aggregate_id = $1 and event_type = 'ticket.scope_flagged'`, [
        row.id,
      ]),
    );
    expect(published.rows).toHaveLength(1);
  });

  it('does not raise the same ticket twice, even after a person withdraws the flag', async () => {
    // A second sweep over the same tickets finds nothing: the latch holds.
    expect(await containers.sweep()).toBe('flagged 0');
    const detected = await withSuperuser((client) =>
      client.query<{ id: string; number: string; version: number }>(
        `select id, number, version from acct.tickets where container_detected_at is not null order by number`,
      ),
    );
    expect(detected.rows).toHaveLength(2);
    const key = `CS${detected.rows[0].number.padStart(7, '0')}`;
    await api()
      .post(`/v1/tickets/${key}/scope`)
      .set(bearer(adminToken))
      .send({ version: detected.rows[0].version, out_of_scope: false })
      .expect(201);
    expect((await ticketRow(key)).out_of_scope).toBe('none');
    // The detector does not argue with somebody who has already answered.
    expect(await containers.sweep()).toBe('flagged 0');
    expect((await ticketRow(key)).out_of_scope).toBe('none');
  });

  it('leaves a closed ticket alone however long it ran', async () => {
    const key = await ticketWithTime('Finished long ago', 8);
    await rawTicketUpdate(numberOf(key), `state = 'closed'`);
    expect(await containers.sweep()).toBe('flagged 0');
    expect((await ticketRow(key)).out_of_scope).toBe('none');
  });

  it('fires on elapsed days once that threshold is set', async () => {
    const key = await ticketWithTime('Slow burner', 1);
    await rawTicketUpdate(numberOf(key), `created_at = now() - interval '40 days'`);
    const updated = await api()
      .put(`/v1/admin/accounts/${accountId}/settings`)
      .set(bearer(adminToken))
      .send({ version: settingsVersion, container_time_entries: null, container_elapsed_days: 30 })
      .expect(200);
    settingsVersion = updated.body.version;
    expect(await containers.sweep()).toBe('flagged 1');
    const detail = (await ticketRow(key)).detail as { reason: string };
    expect(detail.reason).toContain('open 40 days against a threshold of 30');
  });

  it('refuses a threshold of zero, which would mean flag everything', async () => {
    const response = await api()
      .put(`/v1/admin/accounts/${accountId}/settings`)
      .set(bearer(adminToken))
      .send({ version: settingsVersion, container_effort_minutes: 0 })
      .expect(400);
    expect(JSON.stringify(response.body)).toContain('container_effort_minutes');
  });
});
