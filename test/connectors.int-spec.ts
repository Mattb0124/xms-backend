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
import { HttpSnowClient } from '../src/modules/connectors/snow-client.js';
import { SyncWorker } from '../src/modules/connectors/sync.worker.js';
import { startStandIn, type StandIn } from '../src/tools/servicenow-stand-in.js';
import { closePools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * The connector framework and the ServiceNow ingest against the in-process
 * stand-in (P2.21.2, P2.21.3 cut; SN-01, SN-02, SN-04, SN-07, SN-08,
 * SN-09): onboarding with the credential stored once, validation that
 * refuses an incomplete map, activation as an audit event, ingest-only
 * mode, the watermark poll without duplicates, apply through the ticket
 * service with origin sync, the conflict policy, the state map, journal
 * comments once, dead letters with replay and discard, the kill switch, the
 * automatic trip and the health list.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let standIn: StandIn;
let sync: SyncWorker;
let instanceId = '';
let instanceVersion = 1;
const TABLE = 'sn_customerservice_case';

const FIELD_MAP = [
  { external: 'short_description', xms: 'short_description', direction: 'both' },
  { external: 'description', xms: 'description', direction: 'both' },
  { external: 'contact.email', xms: 'requester_email', direction: 'in' },
  { external: 'contact', xms: 'requester_name', direction: 'in' },
  { external: 'number', xms: 'client_reference', direction: 'in' },
  {
    external: 'impact',
    xms: 'impact',
    direction: 'in',
    transform: { kind: 'lookup', values: { '1': 'high', '2': 'medium', '3': 'low' } },
  },
  {
    external: 'urgency',
    xms: 'urgency',
    direction: 'in',
    transform: { kind: 'lookup', values: { '1': 'high', '2': 'medium', '3': 'low' } },
  },
  { external: 'category', xms: 'category', direction: 'both' },
];

const STATE_MAP = {
  incident: {
    inbound: {
      '1': 'new',
      '10': 'in_progress',
      '18': 'awaiting_client',
      '6': 'resolved',
      '3': 'closed',
      '7': 'cancelled',
    },
    outbound: {
      new: '1',
      assigned: '1',
      in_progress: '10',
      awaiting_client: '18',
      awaiting_third_party: '18',
      resolved: '6',
      closed: '3',
      cancelled: '7',
    },
    accept_inbound: ['cancelled', 'in_progress', 'awaiting_client'],
    fallback: { '1': 'new', '18': 'awaiting_client' },
  },
};

beforeAll(async () => {
  await resetDatabase();
  standIn = await startStandIn({ username: 'xms.integration', password: 'stand-in', profile: 'csm' });
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
    // The ServiceNow stand-in runs on 127.0.0.1; production never delivers to a private address.
    WEBHOOK_ALLOW_PRIVATE: 'true',
  });
  resetEnvForTests();
  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // rawBody: the attachment upload through the local signed URL is a binary
  // body express does not parse.
  app = moduleRef.createNestApplication({ bufferLogs: true, rawBody: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  sync = app.get(SyncWorker);
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
    .send({ name: 'Retainer', model: 'retainer' })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
  await standIn?.close();
  await closePools();
});

function api() {
  return request(app.getHttpServer());
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function refreshVersion(): Promise<void> {
  const list = await api().get(`/v1/accounts/${accountId}/connectors`).set(bearer(adminToken)).expect(200);
  instanceVersion = list.body.find((row: { id: string }) => row.id === instanceId).version;
}

async function forcePoll(): Promise<string> {
  await withSuperuser((client) =>
    client.query(`update acct.connector_instances set next_poll_at = now() where id = $1`, [instanceId]),
  );
  return sync.pollDue();
}

/** Hands every outbox row to the connector handler, the way the dispatcher does in the worker. */
async function drainOutbox(): Promise<void> {
  const rows = await withSuperuser((client) =>
    client.query(
      `select id, account_id, aggregate, aggregate_id, event_type, payload, correlation_id, origin, created_at from sys.outbox order by id`,
    ),
  );
  for (const row of rows.rows)
    await sync.onOutbox({
      id: String(row.id),
      account_id: row.account_id,
      aggregate: row.aggregate,
      aggregate_id: row.aggregate_id,
      event_type: row.event_type,
      payload: row.payload,
      correlation_id: row.correlation_id,
      origin: row.origin,
      created_at: row.created_at,
      attempts: 0,
    });
}

function seedCase(body: Record<string, unknown>, at?: Date) {
  return standIn.seed(
    TABLE,
    {
      contact: { value: 'u1', display_value: 'Pat Client' },
      'contact.email': 'pat.client@brookfield.test',
      impact: '2',
      urgency: '2',
      category: 'finance',
      ...body,
    },
    at,
  );
}

describe('onboarding an instance (SN-08)', () => {
  it('creates the instance with the credential stored once and never returned, as an audit event', async () => {
    const created = await api()
      .post(`/v1/accounts/${accountId}/connectors/servicenow`)
      .set(bearer(adminToken))
      .send({
        name: 'Brookfield CSM',
        base_url: standIn.url,
        auth_kind: 'basic',
        credential: { username: 'xms.integration', password: 'stand-in' },
        profile: 'csm',
        poll_interval_seconds: 60,
      })
      .expect(201);
    instanceId = created.body.id;
    instanceVersion = created.body.version;
    expect(created.body).toMatchObject({
      mode: 'off',
      kill_switch: 'armed',
      health: 'healthy',
      table_name: TABLE,
      has_credential: true,
    });
    expect(created.body.credential_secret_name).toBeUndefined();
    expect(JSON.stringify(created.body)).not.toContain('stand-in');
    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type from acct.audit_events where entity_id = $1 and event_type = 'connector.created'`,
        [instanceId],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    await api()
      .post(`/v1/accounts/${accountId}/connectors/servicenow`)
      .set(bearer(adminToken))
      .send({ name: 'Broken', base_url: standIn.url, auth_kind: 'basic', credential: { username: 'x' } })
      .expect(400);
  });

  it('reads one instance with its account name and queue depths', async () => {
    const one = await api().get(`/v1/connectors/${instanceId}`).set(bearer(adminToken)).expect(200);
    expect(one.body).toMatchObject({
      id: instanceId,
      account_name: 'Brookfield',
      pending_inbox: 0,
      open_dead_letters: 0,
    });
    expect(one.body.credential_secret_name).toBeUndefined();
  });

  it('needs admin:connectors', async () => {
    const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
    const consultant = roles.body.find((row: { name: string }) => row.name === 'Consultant');
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({
        email: 'consultant@example.test',
        first_name: 'Chris',
        last_name: 'Consultant',
        role_ids: [consultant.id],
        account_ids: [accountId],
      })
      .expect(201);
    const token = await devToken({ sub: 'dev_consultant', email: 'consultant@example.test' });
    await api().get(`/v1/accounts/${accountId}/connectors`).set(bearer(token)).expect(403);
    await api().get('/v1/connectors/health').set(bearer(token)).expect(403);
  });

  it('tests the connection and records an invalid credential', async () => {
    const ok = await api().post(`/v1/connectors/${instanceId}/test-connection`).set(bearer(adminToken)).expect(201);
    expect(ok.body).toMatchObject({ ok: true, fields: 13 });
    standIn.fault = { invalidToken: true };
    const bad = await api().post(`/v1/connectors/${instanceId}/test-connection`).set(bearer(adminToken)).expect(201);
    expect(bad.body.ok).toBe(false);
    standIn.fault = {};
    const list = await api().get(`/v1/accounts/${accountId}/connectors`).set(bearer(adminToken)).expect(200);
    expect(list.body[0].credential_state).toBe('invalid');
    await api().post(`/v1/connectors/${instanceId}/test-connection`).set(bearer(adminToken)).expect(201);
  });
});

describe('maps (SN-01, SN-08)', () => {
  let fieldMapId = '';

  it('refuses to activate a field map that fails validation and names the gap', async () => {
    seedCase({ short_description: 'Sample one' });
    seedCase({ short_description: 'Sample two', impact: '9' });
    const draft = await api()
      .post(`/v1/connectors/${instanceId}/field-maps`)
      .set(bearer(adminToken))
      .send({ entries: [{ external: 'short_description', xms: 'short_description', direction: 'both' }, FIELD_MAP[5]] })
      .expect(201);
    fieldMapId = draft.body.id;
    expect(draft.body).toMatchObject({ version: 1, state: 'draft' });
    const samples = await api()
      .post(`/v1/connectors/${instanceId}/samples`)
      .set(bearer(adminToken))
      .send({ map_id: fieldMapId })
      .expect(201);
    expect(samples.body.records).toHaveLength(2);
    expect(samples.body.dictionary.map((row: { name: string }) => row.name)).toContain('contact.email');
    const report = await api()
      .post(`/v1/connectors/${instanceId}/field-maps/${fieldMapId}/validate`)
      .set(bearer(adminToken))
      .expect(201);
    expect(report.body.ok).toBe(false);
    expect(report.body.problems).toEqual(
      expect.arrayContaining([
        'required field requester_email has no inbound entry',
        'entry 1: lookup has no value for 9 seen in the samples and no fallback',
      ]),
    );
    const refused = await api()
      .post(`/v1/connectors/${instanceId}/field-maps/${fieldMapId}/activate`)
      .set(bearer(adminToken))
      .expect(409);
    expect(refused.body.code).toBe('map_not_validated');
  });

  it('activates a validated map as an audit event and retires the previous active version', async () => {
    // Fix the sample with the bad impact so the lookup covers what the samples show.
    for (const record of standIn.records.get(TABLE)!.values()) if (record.impact === '9') record.impact = '3';
    await api()
      .post(`/v1/connectors/${instanceId}/samples`)
      .set(bearer(adminToken))
      .send({ map_id: fieldMapId })
      .expect(201);
    await api()
      .put(`/v1/connectors/${instanceId}/field-maps/${fieldMapId}`)
      .set(bearer(adminToken))
      .send({ entries: FIELD_MAP })
      .expect(200);
    const report = await api()
      .post(`/v1/connectors/${instanceId}/field-maps/${fieldMapId}/validate`)
      .set(bearer(adminToken))
      .expect(201);
    expect(report.body).toMatchObject({ ok: true, problems: [], checked_samples: 2 });
    const active = await api()
      .post(`/v1/connectors/${instanceId}/field-maps/${fieldMapId}/activate`)
      .set(bearer(adminToken))
      .expect(201);
    expect(active.body.state).toBe('active');
    await api()
      .put(`/v1/connectors/${instanceId}/field-maps/${fieldMapId}`)
      .set(bearer(adminToken))
      .send({ entries: [] })
      .expect(409);
    const second = await api()
      .post(`/v1/connectors/${instanceId}/field-maps`)
      .set(bearer(adminToken))
      .send({ entries: FIELD_MAP })
      .expect(201);
    await api()
      .post(`/v1/connectors/${instanceId}/field-maps/${second.body.id}/validate`)
      .set(bearer(adminToken))
      .expect(201);
    await api()
      .post(`/v1/connectors/${instanceId}/field-maps/${second.body.id}/activate`)
      .set(bearer(adminToken))
      .expect(201);
    const maps = await api().get(`/v1/connectors/${instanceId}/field-maps`).set(bearer(adminToken)).expect(200);
    expect(maps.body.map((row: { version: number; state: string }) => `${row.version}:${row.state}`)).toEqual([
      '2:active',
      '1:retired',
    ]);
    const audit = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from acct.audit_events where event_type = 'connector.map.activated'`),
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it('validates and activates a state map against the account state machines', async () => {
    const bad = await api()
      .post(`/v1/connectors/${instanceId}/state-maps`)
      .set(bearer(adminToken))
      .send({ entries: { incident: { inbound: { '1': 'nowhere' }, outbound: {} } } })
      .expect(201);
    const badReport = await api()
      .post(`/v1/connectors/${instanceId}/state-maps/${bad.body.id}/validate`)
      .set(bearer(adminToken))
      .expect(201);
    expect(badReport.body.ok).toBe(false);
    expect(badReport.body.problems).toContain('incident: inbound 1 maps to unknown state nowhere');
    await api()
      .put(`/v1/connectors/${instanceId}/state-maps/${bad.body.id}`)
      .set(bearer(adminToken))
      .send({ entries: STATE_MAP })
      .expect(200);
    const report = await api()
      .post(`/v1/connectors/${instanceId}/state-maps/${bad.body.id}/validate`)
      .set(bearer(adminToken))
      .expect(201);
    expect(report.body.ok).toBe(true);
    await api()
      .post(`/v1/connectors/${instanceId}/state-maps/${bad.body.id}/activate`)
      .set(bearer(adminToken))
      .expect(201);
  });
});

describe('ingest-only mode, poll and apply (SN-01, SN-02, SN-09)', () => {
  let caseA: Record<string, unknown>;
  let ticketAId = '';

  it('moves to ingest_only with a security event, and drops back from bidirectional in one call (SN-09)', async () => {
    await refreshVersion();
    const updated = await api()
      .patch(`/v1/connectors/${instanceId}`)
      .set(bearer(adminToken))
      .send({ version: instanceVersion, mode: 'ingest_only' })
      .expect(200);
    expect(updated.body.mode).toBe('ingest_only');
    instanceVersion = updated.body.version;
    const security = await withSuperuser((client) =>
      client.query(`select attrs from sys.security_events where event_type = 'admin.connector.mode_changed'`),
    );
    expect(security.rows.at(-1)?.attrs).toMatchObject({ from: 'off', to: 'ingest_only' });
    // Both maps are active and the credential has been accepted, so
    // bidirectional is available; dropping back to ingest_only is the
    // documented fallback and loses nothing.
    const promoted = await api()
      .patch(`/v1/connectors/${instanceId}`)
      .set(bearer(adminToken))
      .send({ version: instanceVersion, mode: 'bidirectional' })
      .expect(200);
    expect(promoted.body.mode).toBe('bidirectional');
    const back = await api()
      .patch(`/v1/connectors/${instanceId}`)
      .set(bearer(adminToken))
      .send({ version: promoted.body.version, mode: 'ingest_only' })
      .expect(200);
    expect(back.body.mode).toBe('ingest_only');
    instanceVersion = back.body.version;
  });

  it('polls behind the watermark, writes inbox rows once, and advances only after the page is stored', async () => {
    caseA = seedCase({
      short_description: 'Consolidation fails at step 4',
      description: 'CE-4102 on the close',
      impact: '1',
      urgency: '1',
    });
    standIn.addJournal(String(caseA.sys_id), 'comments', 'Any update on this?');
    seedCase({ short_description: 'Currency wrong for APAC', impact: '3' });
    const first = await forcePoll();
    expect(first).toContain('4 new, 0 duplicate');
    const rows = await withSuperuser((client) =>
      client.query(`select external_id, outcome from sys.inbox order by id`),
    );
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows.every((row) => row.outcome === null)).toBe(true);
    const again = await forcePoll();
    expect(again).toContain('0 new, 0 duplicate');
    // A replayed page (watermark not advanced) is dropped by the inbox key.
    await withSuperuser((client) =>
      client.query(
        `update acct.connector_instances set inbound_watermark = '1970-01-01', inbound_watermark_sys_id = null where id = $1`,
        [instanceId],
      ),
    );
    const replayed = await forcePoll();
    expect(replayed).toContain('0 new, 4 duplicate');
    const runs = await api()
      .get(`/v1/connectors/${instanceId}/runs?direction=poll`)
      .set(bearer(adminToken))
      .expect(200);
    expect(runs.body.length).toBeGreaterThanOrEqual(3);
    expect(runs.body[0].outcome).toBe('success');
  });

  it('applies the inbox as tickets with source sync, the requester from the mapped email, the journal as a comment, and origin sync on the outbox', async () => {
    const outcome = await sync.applyPending();
    expect(outcome).toBe('applied 4, failed 0');
    const tickets = await withSuperuser((client) =>
      client.query(`select t.id, t.short_description, t.source, t.impact, t.urgency, t.priority, t.category, t.external_refs, c.email as requester
                      from acct.tickets t left join acct.contacts c on c.id = t.requester_contact_id order by t.created_at`),
    );
    expect(tickets.rows).toHaveLength(4);
    const ticketA = tickets.rows.find((row) => row.short_description === 'Consolidation fails at step 4')!;
    ticketAId = ticketA.id;
    expect(ticketA).toMatchObject({
      source: 'sync',
      impact: 'high',
      urgency: 'high',
      priority: 'p1',
      category: 'finance',
      requester: 'pat.client@brookfield.test',
    });
    expect(ticketA.external_refs).toMatchObject({
      servicenow: caseA.number,
      servicenow_sys_id: caseA.sys_id,
      client_reference: caseA.number,
    });
    const comments = await withSuperuser((client) =>
      client.query(`select body, source from acct.comments where ticket_id = $1`, [ticketAId]),
    );
    expect(comments.rows).toEqual([{ body: 'Any update on this?', source: 'sync' }]);
    const links = await withSuperuser((client) =>
      client.query(`select external_sys_id, external_number, state from acct.sync_links where ticket_id = $1`, [
        ticketAId,
      ]),
    );
    expect(links.rows).toEqual([{ external_sys_id: caseA.sys_id, external_number: caseA.number, state: 'linked' }]);
    const outbox = await withSuperuser((client) =>
      client.query(`select distinct origin from sys.outbox where aggregate_id = $1`, [ticketAId]),
    );
    expect(outbox.rows).toEqual([{ origin: `sync:${instanceId}` }]);
    const audit = await withSuperuser((client) =>
      client.query(
        `select actor_kind, actor_id from acct.audit_events where ticket_id = $1 and event_type = 'sync.applied'`,
        [ticketAId],
      ),
    );
    expect(audit.rows).toEqual([{ actor_kind: 'system', actor_id: `sync:${instanceId}` }]);
    const card = await api().get(`/v1/tickets/${ticketAId}/sync`).set(bearer(adminToken)).expect(200);
    expect(card.body.links[0]).toMatchObject({
      external_number: caseA.number,
      instance_name: 'Brookfield CSM',
      mode: 'ingest_only',
    });
    expect(card.body.runs[0].outcome).toBe('success');
  });

  it('applies an update per the conflict policy: XMS-owned fields are kept and recorded as a conflict, a new journal entry lands once (SN-04)', async () => {
    const record = standIn.records.get(TABLE)!.get(String(caseA.sys_id))!;
    record.short_description = 'Renamed by the client';
    record.sys_updated_on = '2026-12-31 00:00:00';
    standIn.addJournal(String(caseA.sys_id), 'comments', 'Second question', 'client.user', new Date(Date.now() + 2000));
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    const ticket = await withSuperuser((client) =>
      client.query(`select short_description from acct.tickets where id = $1`, [ticketAId]),
    );
    expect(ticket.rows[0].short_description).toBe('Consolidation fails at step 4');
    const link = await withSuperuser((client) =>
      client.query(`select state, last_conflict from acct.sync_links where ticket_id = $1`, [ticketAId]),
    );
    expect(link.rows[0].state).toBe('conflict');
    expect(link.rows[0].last_conflict.fields).toEqual(['short_description']);
    const comments = await withSuperuser((client) =>
      client.query(`select body from acct.comments where ticket_id = $1 order by created_at`, [ticketAId]),
    );
    expect(comments.rows.map((row) => row.body)).toEqual(['Any update on this?', 'Second question']);
    const runs = await api()
      .get(`/v1/connectors/${instanceId}/runs?direction=in&outcome=skipped_policy`)
      .set(bearer(adminToken))
      .expect(200);
    expect(runs.body).toHaveLength(1);
  });

  it('moves the state through the state map only where accepted and reachable', async () => {
    const record = standIn.records.get(TABLE)!.get(String(caseA.sys_id))!;
    record.state = '6'; // resolved: not accepted inbound
    record.sys_updated_on = '2027-01-01 00:00:01';
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    let state = await withSuperuser((client) =>
      client.query(`select state from acct.tickets where id = $1`, [ticketAId]),
    );
    expect(state.rows[0].state).toBe('new');
    record.state = '7'; // cancelled: accepted and reachable from new
    record.sys_updated_on = '2027-01-01 00:00:02';
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    state = await withSuperuser((client) => client.query(`select state from acct.tickets where id = $1`, [ticketAId]));
    expect(state.rows[0].state).toBe('cancelled');
    const run = await withSuperuser((client) =>
      client.query(
        `select detail from acct.sync_runs where ticket_id = $1 and outcome = 'success' order by created_at desc limit 2`,
        [ticketAId],
      ),
    );
    expect(run.rows[0].detail.state).toEqual({ to: 'cancelled', via: 'direct' });
    expect(run.rows[1].detail.state_skipped).toMatchObject({ reason: 'not_accepted' });
  });
});

describe('dead letters, the kill switch and health (SN-07, SN-09)', () => {
  let letterId = '';

  it('dead-letters a record the map cannot apply, lists it, and discards it with a reason as an audit event', async () => {
    standIn.seed(TABLE, {
      short_description: 'No contact on this one',
      impact: '2',
      urgency: '2',
      sys_updated_on: '2027-01-02 00:00:00',
    });
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 0, failed 1');
    const letters = await api()
      .get(`/v1/connectors/${instanceId}/dead-letters?resolution=open`)
      .set(bearer(adminToken))
      .expect(200);
    expect(letters.body).toHaveLength(1);
    expect(letters.body[0].error).toContain('mapping_incomplete');
    letterId = letters.body[0].id;
    const replay = await api()
      .post(`/v1/connectors/${instanceId}/dead-letters/replay`)
      .set(bearer(adminToken))
      .send({ ids: [letterId], reason: 'retry after the client added a contact' })
      .expect(201);
    expect(replay.body.results).toEqual([{ id: letterId, outcome: 'replayed' }]);
    const reopened = await withSuperuser((client) =>
      client.query(`select applied_at, attempts from sys.inbox where outcome is null`),
    );
    expect(reopened.rows).toHaveLength(1);
    expect(await sync.applyPending()).toBe('applied 0, failed 1');
    const open = await api()
      .get(`/v1/connectors/${instanceId}/dead-letters?resolution=open`)
      .set(bearer(adminToken))
      .expect(200);
    expect(open.body).toHaveLength(1);
    const discard = await api()
      .post(`/v1/connectors/${instanceId}/dead-letters/discard`)
      .set(bearer(adminToken))
      .send({ ids: [open.body[0].id], reason: 'test record without a contact' })
      .expect(201);
    expect(discard.body.results[0].outcome).toBe('discarded');
    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type from acct.audit_events where event_type in ('connector.dead_letter.replayed', 'connector.dead_letter.discarded') order by created_at`,
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'connector.dead_letter.replayed',
      'connector.dead_letter.discarded',
    ]);
  });

  it('tripping the switch stops poll and apply without losing queued work; arming resumes', async () => {
    seedCase({ short_description: 'Queued while tripped', sys_updated_on: '2027-01-03 00:00:00' });
    expect(await forcePoll()).toContain('1 new');
    const tripped = await api()
      .post(`/v1/connectors/${instanceId}/kill-switch`)
      .set(bearer(adminToken))
      .send({ action: 'trip', reason: 'client asked to pause' })
      .expect(201);
    expect(tripped.body).toMatchObject({
      kill_switch: 'tripped',
      health: 'tripped',
      trip_reason: 'client asked to pause',
    });
    expect(await sync.applyPending()).toBe('applied 0, failed 0');
    expect(await forcePoll()).toBe('polled 0');
    const security = await withSuperuser((client) =>
      client.query(
        `select attrs from sys.security_events where event_type = 'admin.connector.kill_switch' order by occurred_at`,
      ),
    );
    expect(security.rows.at(-1)?.attrs).toMatchObject({ action: 'trip', reason: 'client asked to pause' });
    await api()
      .post(`/v1/connectors/${instanceId}/kill-switch`)
      .set(bearer(adminToken))
      .send({ action: 'trip' })
      .expect(400);
    await api()
      .post(`/v1/connectors/${instanceId}/kill-switch`)
      .set(bearer(adminToken))
      .send({ action: 'arm' })
      .expect(201);
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
  });

  it('reports health with the queue depths and trips automatically at the error threshold', async () => {
    const health = await api().get('/v1/connectors/health').set(bearer(adminToken)).expect(200);
    expect(health.body).toHaveLength(1);
    expect(health.body[0]).toMatchObject({
      id: instanceId,
      mode: 'ingest_only',
      pending_inbox: 0,
      open_dead_letters: 0,
    });
    await refreshVersion();
    await api()
      .patch(`/v1/connectors/${instanceId}`)
      .set(bearer(adminToken))
      .send({ version: instanceVersion, error_trip_threshold: { ratio: 0.5, window_minutes: 15, min_attempts: 4 } })
      .expect(200);
    // Thirty failures against the handful of earlier successes in the window pushes the ratio past the threshold.
    standIn.fault = { status: 500, times: 30 };
    for (let index = 0; index < 30; index += 1) expect(await forcePoll()).toContain('failed');
    standIn.fault = {};
    expect(await sync.recomputeHealth()).toBe('health recomputed, tripped 1');
    const after = await api().get(`/v1/accounts/${accountId}/connectors`).set(bearer(adminToken)).expect(200);
    expect(after.body[0]).toMatchObject({ kill_switch: 'tripped', health: 'tripped', tripped_by: 'health' });
    const security = await withSuperuser((client) =>
      client.query(
        `select attrs from sys.security_events where event_type = 'admin.connector.kill_switch' order by occurred_at desc limit 1`,
      ),
    );
    expect(security.rows[0].attrs).toMatchObject({ action: 'trip', automatic: true });
  }, 60_000);
});

/** The linked pair the outbound tests work on: the client case and its XMS ticket. */
let caseB: Record<string, unknown>;
let ticketBId = '';

describe('the outbound queue (SN-03)', () => {
  it('arms the switch, promotes the instance to bidirectional and links a fresh case', async () => {
    await api()
      .post(`/v1/connectors/${instanceId}/kill-switch`)
      .set(bearer(adminToken))
      .send({ action: 'arm' })
      .expect(201);
    await refreshVersion();
    const promoted = await api()
      .patch(`/v1/connectors/${instanceId}`)
      .set(bearer(adminToken))
      .send({ version: instanceVersion, mode: 'bidirectional' })
      .expect(200);
    expect(promoted.body.mode).toBe('bidirectional');
    instanceVersion = promoted.body.version;
    caseB = seedCase({ short_description: 'Outbound subject', sys_updated_on: '2027-02-01 00:00:00' });
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    const link = await withSuperuser((client) =>
      client.query(`select ticket_id from acct.sync_links where external_sys_id = $1`, [caseB.sys_id]),
    );
    ticketBId = link.rows[0].ticket_id;
    expect(ticketBId).toBeTruthy();
  });

  it('never queues the instance its own echo and queues a consultant comment exactly once', async () => {
    // Everything the apply handler wrote for this case carries origin
    // sync:<instance>: the loop guard drops it and records why.
    await drainOutbox();
    const echoed = await withSuperuser((client) =>
      client.query(`select id from acct.sync_outbound where instance_id = $1`, [instanceId]),
    );
    expect(echoed.rows).toHaveLength(0);
    const skipped = await api()
      .get(`/v1/connectors/${instanceId}/runs?direction=out&outcome=skipped_reflection`)
      .set(bearer(adminToken))
      .expect(200);
    expect(skipped.body.length).toBeGreaterThanOrEqual(1);
    expect(skipped.body[0].detail).toMatchObject({ reason: 'own_origin' });

    await api()
      .post(`/v1/tickets/${ticketBId}/comments`)
      .set(bearer(adminToken))
      .send({ body: 'We are on it' })
      .expect(201);
    await drainOutbox();
    // At-least-once dispatch: a redelivered outbox row must not queue twice.
    await drainOutbox();
    const queued = await withSuperuser((client) =>
      client.query(`select event, status, attempts, origin from acct.sync_outbound where instance_id = $1`, [
        instanceId,
      ]),
    );
    expect(queued.rows).toEqual([{ event: 'comment.created', status: 'pending', attempts: 0, origin: 'user' }]);
  });

  it('keeps a work note internal while the instance is not configured to receive one', async () => {
    await api()
      .post(`/v1/tickets/${ticketBId}/work-notes`)
      .set(bearer(adminToken))
      .send({ body: 'Internal: waiting on the platform team' })
      .expect(201);
    await drainOutbox();
    const queued = await withSuperuser((client) =>
      client.query(`select event from acct.sync_outbound where instance_id = $1 order by created_at`, [instanceId]),
    );
    expect(queued.rows.map((row) => row.event)).toEqual(['comment.created']);
    const refused = await api()
      .get(`/v1/connectors/${instanceId}/runs?direction=out&outcome=skipped_policy`)
      .set(bearer(adminToken))
      .expect(200);
    expect(refused.body[0].detail).toMatchObject({ event: 'work_note.created', reason: 'work_notes_off' });
  });

  it('queues a transition, and queues nothing for a ticket with no link on the instance', async () => {
    const unlinked = await api()
      .post('/v1/tickets')
      .set(bearer(adminToken))
      .send({
        account_id: accountId,
        type: 'incident',
        short_description: 'Raised in XMS, not linked to the instance',
        requester_email: 'pat.client@brookfield.test',
      })
      .expect(201);
    const current = await api().get(`/v1/tickets/${ticketBId}`).set(bearer(adminToken)).expect(200);
    await api()
      .post(`/v1/tickets/${ticketBId}/transitions`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, to: 'in_progress' })
      .expect(201);
    await drainOutbox();
    const queued = await withSuperuser((client) =>
      client.query(`select event, ticket_id from acct.sync_outbound where instance_id = $1 order by created_at`, [
        instanceId,
      ]),
    );
    expect(queued.rows.map((row) => row.event)).toContain('ticket.transitioned');
    expect(queued.rows.every((row) => row.ticket_id === ticketBId)).toBe(true);
    expect(unlinked.body.id).toBeTruthy();
  });

  it('leaves the queue alone while the switch is tripped and drains it in order once it is armed', async () => {
    await api()
      .post(`/v1/connectors/${instanceId}/kill-switch`)
      .set(bearer(adminToken))
      .send({ action: 'trip', reason: 'pausing write-back for the change window' })
      .expect(201);
    expect(await sync.deliverPending()).toBe('delivered 0, skipped 0, retried 0, failed 0');
    const held = await withSuperuser((client) =>
      client.query(`select status from acct.sync_outbound where instance_id = $1`, [instanceId]),
    );
    expect(held.rows.every((row) => row.status === 'pending')).toBe(true);
    await api()
      .post(`/v1/connectors/${instanceId}/kill-switch`)
      .set(bearer(adminToken))
      .send({ action: 'arm' })
      .expect(201);
    expect(await sync.deliverPending()).toBe('delivered 2, skipped 0, retried 0, failed 0');
  });

  it('writes the comment into the client journal with the marker, the ticket key and the author', async () => {
    const written = standIn.journal.filter(
      (entry) => entry.element_id === caseB.sys_id && entry.sys_created_by === 'xms.integration',
    );
    expect(written).toHaveLength(1);
    const ticket = await api().get(`/v1/tickets/${ticketBId}`).set(bearer(adminToken)).expect(200);
    expect(String(written[0].value)).toMatch(/^\[XMS:[0-9a-f]{8}\] CS\d{7} .+: We are on it$/);
    expect(String(written[0].value)).toContain(ticket.body.key);
    const links = await withSuperuser((client) =>
      client.query(
        `select xms_kind, direction from acct.sync_journal_links where instance_id = $1 and direction = $2`,
        [instanceId, 'out'],
      ),
    );
    expect(links.rows).toEqual([{ xms_kind: 'comment', direction: 'out' }]);
  });

  it('translates the transition through the state map in reverse and records the run', async () => {
    const record = standIn.records.get(TABLE)!.get(String(caseB.sys_id))!;
    expect(record.state).toBe('10');
    const rows = await withSuperuser((client) =>
      client.query(`select event, status, attempts, sent_at from acct.sync_outbound where instance_id = $1`, [
        instanceId,
      ]),
    );
    expect(rows.rows.every((row) => row.status === 'sent' && row.attempts === 1 && row.sent_at !== null)).toBe(true);
    const runs = await api()
      .get(`/v1/connectors/${instanceId}/runs?direction=out&outcome=success`)
      .set(bearer(adminToken))
      .expect(200);
    expect(runs.body).toHaveLength(2);
    const transition = runs.body.find(
      (run: { detail: { event: string } }) => run.detail.event === 'ticket.transitioned',
    );
    expect(transition.detail.state).toMatchObject({ to: 'in_progress', external: '10' });
  });

  it('records the ServiceNow stamp on the link so the next poll reads our own writes as reflections', async () => {
    const before = await withSuperuser((client) =>
      client.query(`select body from acct.comments where ticket_id = $1`, [ticketBId]),
    );
    const link = await withSuperuser((client) =>
      client.query(
        `select last_outbound_at, last_outbound_hash, last_inbound_sys_updated_on from acct.sync_links where ticket_id = $1`,
        [ticketBId],
      ),
    );
    expect(link.rows[0].last_outbound_at).not.toBeNull();
    expect(link.rows[0].last_outbound_hash).toMatch(/^[0-9a-f]{64}$/);
    // The seeded cases carry stamps far in the future so the earlier tests
    // could order them; our own write carries the real clock, so the poll
    // has to be looking behind it to see the record come back at all.
    await api()
      .post(`/v1/connectors/${instanceId}/watermark`)
      .set(bearer(adminToken))
      .send({ to: '2026-01-01T00:00:00Z' })
      .expect(201);
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 0, failed 0');
    const inbox = await withSuperuser((client) =>
      client.query(`select outcome from sys.inbox order by id desc limit 1`),
    );
    expect(inbox.rows[0].outcome).toBe('dropped_reflection');
    const after = await withSuperuser((client) =>
      client.query(`select body from acct.comments where ticket_id = $1`, [ticketBId]),
    );
    expect(after.rows).toHaveLength(before.rows.length);
  });

  it('retries a 500, dead-letters a 400 with the payload, and a replay puts the row back in the queue', async () => {
    await api()
      .post(`/v1/tickets/${ticketBId}/comments`)
      .set(bearer(adminToken))
      .send({ body: 'The fix ships tonight' })
      .expect(201);
    await drainOutbox();
    standIn.fault = { status: 500, times: 1 };
    expect(await sync.deliverPending()).toBe('delivered 0, skipped 0, retried 1, failed 0');
    const retried = await withSuperuser((client) =>
      client.query(`select status, attempts, last_error from acct.sync_outbound where status = 'pending'`),
    );
    expect(retried.rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(retried.rows[0].last_error).toContain('500');
    // The backoff holds the row until it is due.
    expect(await sync.deliverPending()).toBe('delivered 0, skipped 0, retried 0, failed 0');
    standIn.fault = { status: 400, times: 1 };
    const later = new Date(Date.now() + 3_600_000);
    expect(await sync.deliverPending(later)).toBe('delivered 0, skipped 0, retried 0, failed 1');
    const letters = await api()
      .get(`/v1/connectors/${instanceId}/dead-letters?resolution=open`)
      .set(bearer(adminToken))
      .expect(200);
    expect(letters.body).toHaveLength(1);
    expect(letters.body[0].payload).toMatchObject({ instance_id: instanceId, event: 'comment.created' });
    standIn.fault = {};
    await api()
      .post(`/v1/connectors/${instanceId}/dead-letters/replay`)
      .set(bearer(adminToken))
      .send({ ids: [letters.body[0].id], reason: 'the instance is back' })
      .expect(201);
    expect(await sync.deliverPending()).toBe('delivered 1, skipped 0, retried 0, failed 0');
    const settled = await withSuperuser((client) =>
      client.query(`select status from acct.sync_outbound where instance_id = $1 and status <> 'sent'`, [instanceId]),
    );
    expect(settled.rows).toEqual([]);
  });

  it('counts the outbound queue on the health list and on the instance itself', async () => {
    // Every row of this instance is settled by the test above, so the
    // constructed rows below are the whole queue depth. They carry a
    // correlation id of their own so the later describes see the queue as
    // this one left it.
    const FIXTURE = 'outbound-depth-fixture';
    const seeded = await withSuperuser(async (client) => {
      const template = await client.query<{ account_id: string; ticket_id: string; link_id: string }>(
        `select account_id, ticket_id, link_id from acct.sync_outbound where instance_id = $1 limit 1`,
        [instanceId],
      );
      const row = template.rows[0];
      for (const status of ['pending', 'pending', 'dead_lettered', 'sent']) {
        await client.query(
          `insert into acct.sync_outbound (account_id, instance_id, ticket_id, link_id, event, status, correlation_id)
           values ($1, $2, $3, $4, 'comment.created', $5, $6)`,
          [row.account_id, instanceId, row.ticket_id, row.link_id, status, FIXTURE],
        );
      }
      return row;
    });
    expect(seeded.account_id).toBe(accountId);

    try {
      const health = await api().get('/v1/connectors/health').set(bearer(adminToken)).expect(200);
      expect(health.body).toHaveLength(1);
      // The sent row is neither waiting nor lost, so it counts in neither.
      expect(health.body[0]).toMatchObject({ id: instanceId, pending_outbound: 2, dead_lettered_outbound: 1 });

      const one = await api().get(`/v1/connectors/${instanceId}`).set(bearer(adminToken)).expect(200);
      expect(one.body).toMatchObject({ pending_outbound: 2, dead_lettered_outbound: 1 });
    } finally {
      await withSuperuser((client) =>
        client.query('delete from acct.sync_outbound where correlation_id = $1', [FIXTURE]),
      );
    }

    const drained = await api().get(`/v1/connectors/${instanceId}`).set(bearer(adminToken)).expect(200);
    expect(drained.body).toMatchObject({ pending_outbound: 0, dead_lettered_outbound: 0 });
  });
});

describe('the outbound conflict policy (SN-04)', () => {
  /** Makes the case look changed on the client side since the update the link last knew about. */
  async function clientChanged(value: string, stamp: string, lastKnown = '2026-01-01 00:00:00'): Promise<void> {
    const record = standIn.records.get(TABLE)!.get(String(caseB.sys_id))!;
    record.short_description = value;
    record.sys_updated_on = stamp;
    await withSuperuser((client) =>
      client.query(`update acct.sync_links set last_inbound_sys_updated_on = $2 where ticket_id = $1`, [
        ticketBId,
        lastKnown,
      ]),
    );
  }

  /** Per-link overrides are the documented way to move one field's system of record. */
  async function policyFor(field: string, policy: string): Promise<void> {
    await withSuperuser((client) =>
      client.query(`update acct.sync_links set field_sor_overrides = $2 where ticket_id = $1`, [
        ticketBId,
        JSON.stringify({ [field]: policy }),
      ]),
    );
  }

  async function pushShortDescription(value: string): Promise<void> {
    const current = await api().get(`/v1/tickets/${ticketBId}`).set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/tickets/${ticketBId}`)
      .set(bearer(adminToken))
      .send({ version: current.body.version, short_description: value })
      .expect(200);
    await drainOutbox();
  }

  function subject(): string {
    return String(standIn.records.get(TABLE)!.get(String(caseB.sys_id))!.short_description);
  }

  async function lastOutbound(): Promise<{ status: string; conflict: Record<string, unknown> | null }> {
    const rows = await withSuperuser((client) =>
      client.query(`select status, conflict from acct.sync_outbound order by created_at desc, id desc limit 1`),
    );
    return rows.rows[0];
  }

  it('keeps the XMS value on a field XMS owns and records both sides on the row', async () => {
    await policyFor('short_description', 'xms');
    await clientChanged('Renamed on the client side', '2027-03-01 00:00:00');
    await pushShortDescription('Owned by XMS after intake');
    expect(await sync.deliverPending()).toBe('delivered 1, skipped 0, retried 0, failed 0');
    expect(subject()).toBe('Owned by XMS after intake');
    const row = await lastOutbound();
    expect(row.status).toBe('sent');
    expect(row.conflict).toMatchObject({
      external_changed: true,
      kept: ['short_description'],
      dropped: [],
      external_sys_updated_on: '2027-03-01 00:00:00',
    });
    const audit = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from acct.audit_events where event_type = 'sync.conflict'`),
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('leaves a field the instance owns alone, records the conflict and marks the link', async () => {
    await policyFor('short_description', 'external');
    await clientChanged('The client owns this line', '2027-03-02 00:00:00');
    await pushShortDescription('XMS tried to rename it');
    expect(await sync.deliverPending()).toBe('delivered 0, skipped 1, retried 0, failed 0');
    expect(subject()).toBe('The client owns this line');
    const row = await lastOutbound();
    expect(row.status).toBe('skipped');
    expect(row.conflict).toMatchObject({
      kept: [],
      dropped: [{ field: 'short_description', policy: 'external', reason: 'external_owned' }],
    });
    const link = await withSuperuser((client) =>
      client.query(`select state, last_conflict from acct.sync_links where ticket_id = $1`, [ticketBId]),
    );
    expect(link.rows[0].state).toBe('conflict');
    expect(link.rows[0].last_conflict).toMatchObject({ direction: 'out', fields: ['short_description'] });
    const runs = await api()
      .get(`/v1/connectors/${instanceId}/runs?direction=out&outcome=skipped_policy`)
      .set(bearer(adminToken))
      .expect(200);
    expect(runs.body[0].detail.reason).toBe('policy');
  });

  it('lets the newer side win under newest, in both directions', async () => {
    await policyFor('short_description', 'newest');
    // The client's change is older than the XMS edit that follows it.
    await clientChanged('Client edit from June', '2026-06-01 00:00:00');
    await pushShortDescription('XMS edit, made now');
    expect(await sync.deliverPending()).toBe('delivered 1, skipped 0, retried 0, failed 0');
    expect(subject()).toBe('XMS edit, made now');
    expect((await lastOutbound()).conflict).toMatchObject({ kept: ['short_description'] });
    // The client's change is later than the XMS edit, so it stands.
    await clientChanged('Client edit from the future', '2027-06-01 00:00:00');
    await pushShortDescription('XMS edit that arrives second');
    expect(await sync.deliverPending()).toBe('delivered 0, skipped 1, retried 0, failed 0');
    expect(subject()).toBe('Client edit from the future');
    expect((await lastOutbound()).conflict).toMatchObject({
      dropped: [{ field: 'short_description', policy: 'newest', reason: 'older' }],
    });
  });

  it('never sends a field whose policy is none, contested or not', async () => {
    await policyFor('short_description', 'none');
    await clientChanged('Untouched by XMS', '2027-07-01 00:00:00');
    await pushShortDescription('XMS would have sent this');
    expect(await sync.deliverPending()).toBe('delivered 0, skipped 1, retried 0, failed 0');
    expect(subject()).toBe('Untouched by XMS');
    expect((await lastOutbound()).conflict).toMatchObject({
      dropped: [{ field: 'short_description', policy: 'none', reason: 'none' }],
    });
  });

  it('sends without a contest when the client has not touched the case', async () => {
    await policyFor('short_description', 'external_at_create_then_xms');
    // No client change: the link's last known update is the current stamp.
    const record = standIn.records.get(TABLE)!.get(String(caseB.sys_id))!;
    await withSuperuser((client) =>
      client.query(
        `update acct.sync_links set field_sor_overrides = $2, last_inbound_sys_updated_on = $3, state = 'linked' where ticket_id = $1`,
        [
          ticketBId,
          JSON.stringify({ short_description: 'external_at_create_then_xms' }),
          String(record.sys_updated_on),
        ],
      ),
    );
    await pushShortDescription('The consultant owns the subject after intake');
    expect(await sync.deliverPending()).toBe('delivered 1, skipped 0, retried 0, failed 0');
    expect(subject()).toBe('The consultant owns the subject after intake');
    const row = await lastOutbound();
    expect(row.status).toBe('sent');
    expect(row.conflict).toBeNull();
    const runs = await api()
      .get(`/v1/connectors/${instanceId}/runs?direction=out&outcome=success`)
      .set(bearer(adminToken))
      .expect(200);
    expect(runs.body[0].detail.fields).toEqual(['short_description']);
  });
});

describe('attachments both ways (SN-06)', () => {
  const localPath = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '');

  /** The presign, upload and confirm a consultant's browser performs. */
  async function upload(fileName: string, body: Buffer, visibility: 'public' | 'internal') {
    const presigned = await api()
      .post(`/v1/tickets/${ticketBId}/attachments/presign`)
      .set(bearer(adminToken))
      .send({ file_name: fileName, content_type: 'text/plain', size_bytes: body.length })
      .expect(201);
    await request(app.getHttpServer())
      .put(localPath(presigned.body.upload.url))
      .set('content-type', 'text/plain')
      .send(body)
      .expect(200);
    const confirmed = await api()
      .post(`/v1/tickets/${ticketBId}/attachments/${presigned.body.attachment.id}/confirm`)
      .set(bearer(adminToken))
      .send({ visibility })
      .expect(201);
    return confirmed.body;
  }

  /** Touches the case so the next poll carries it, and its files, again. */
  function touchCase(stamp: string): void {
    standIn.records.get(TABLE)!.get(String(caseB.sys_id))!.sys_updated_on = stamp;
  }

  it('copies a file under the limit into the object store through the scan gate', async () => {
    standIn.addAttachment(String(caseB.sys_id), 'runbook.txt', 'text/plain', Buffer.from('close step 4 by hand'));
    touchCase('2028-01-01 00:00:00');
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    const stored = await withSuperuser((client) =>
      client.query(
        `select file_name, content_type, size_bytes, origin, visibility, scan_state from acct.attachments where ticket_id = $1`,
        [ticketBId],
      ),
    );
    expect(stored.rows).toEqual([
      {
        file_name: 'runbook.txt',
        content_type: 'text/plain',
        size_bytes: '20',
        origin: 'sync',
        visibility: 'public',
        scan_state: 'clean',
      },
    ]);
    const links = await withSuperuser((client) =>
      client.query(`select direction, outcome from acct.sync_attachment_links where ticket_id = $1`, [ticketBId]),
    );
    expect(links.rows).toEqual([{ direction: 'in', outcome: 'copied' }]);
    // A second poll of the same file does not copy it twice.
    touchCase('2028-01-02 00:00:00');
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    const again = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from acct.attachments where ticket_id = $1`, [ticketBId]),
    );
    expect(again.rows[0].n).toBe(1);
  });

  it('turns a file over the limit into a work note rather than a copy', async () => {
    await refreshVersion();
    await api()
      .patch(`/v1/connectors/${instanceId}`)
      .set(bearer(adminToken))
      .send({ version: instanceVersion, attachment_limit_bytes: 16 })
      .expect(200);
    standIn.addAttachment(
      String(caseB.sys_id),
      'trace.log',
      'text/plain',
      Buffer.from('a trace far longer than the limit allows'),
    );
    touchCase('2028-02-01 00:00:00');
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    const links = await withSuperuser((client) =>
      client.query(
        `select outcome from acct.sync_attachment_links where ticket_id = $1 and direction = 'in' order by created_at`,
        [ticketBId],
      ),
    );
    expect(links.rows.map((row) => row.outcome)).toEqual(['copied', 'linked']);
    const notes = await withSuperuser((client) =>
      client.query(`select body from acct.work_notes where ticket_id = $1 order by created_at desc limit 1`, [
        ticketBId,
      ]),
    );
    expect(notes.rows[0].body).toContain('trace.log');
    expect(notes.rows[0].body).toContain('over the 16 byte copy limit');
    await refreshVersion();
    await api()
      .patch(`/v1/connectors/${instanceId}`)
      .set(bearer(adminToken))
      .send({ version: instanceVersion, attachment_limit_bytes: 10485760 })
      .expect(200);
  });

  it('pushes a scanned public file to the case and keeps an internal one internal', async () => {
    const internal = await upload('internal-only.txt', Buffer.from('for the delivery team'), 'internal');
    expect(internal).toMatchObject({ scan_state: 'clean', visibility: 'internal' });
    await drainOutbox();
    const refused = await api()
      .get(`/v1/connectors/${instanceId}/runs?direction=out&outcome=skipped_policy`)
      .set(bearer(adminToken))
      .expect(200);
    expect(refused.body[0].detail).toMatchObject({ event: 'attachment.scanned', reason: 'internal_attachment' });
    const queued = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from acct.sync_outbound where event = 'attachment.scanned'`),
    );
    expect(queued.rows[0].n).toBe(0);

    const shared = await upload('for-the-client.txt', Buffer.from('the workaround, step by step'), 'public');
    expect(shared).toMatchObject({ scan_state: 'clean', visibility: 'public' });
    await drainOutbox();
    expect(await sync.deliverPending()).toBe('delivered 1, skipped 0, retried 0, failed 0');
    const sent = [...standIn.attachments.values()].filter((one) => one.sys_created_by === 'xms.integration');
    expect(sent).toHaveLength(1);
    expect(sent[0].file_name).toBe('for-the-client.txt');
    expect(sent[0].body.toString('utf8')).toBe('the workaround, step by step');
    const links = await withSuperuser((client) =>
      client.query(`select outcome from acct.sync_attachment_links where direction = 'out'`),
    );
    expect(links.rows).toEqual([{ outcome: 'copied' }]);
    // The file we pushed does not come back as a copy of itself.
    touchCase('2028-03-01 00:00:00');
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    const total = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from acct.attachments where ticket_id = $1`, [ticketBId]),
    );
    expect(total.rows[0].n).toBe(3);
  });

  it('quarantines a file whose declared type is not one an attachment may be', async () => {
    // The browser upload path refuses the type outright; the connector has
    // to store what it is handed to keep the run record honest, so the file
    // lands quarantined and is never downloadable.
    standIn.addAttachment(String(caseB.sys_id), 'payload.exe', 'application/x-msdownload', Buffer.from('MZ...'));
    touchCase('2028-04-01 00:00:00');
    expect(await forcePoll()).toContain('1 new');
    expect(await sync.applyPending()).toBe('applied 1, failed 0');
    const stored = await withSuperuser((client) =>
      client.query(
        `select file_name, scan_state, scan_detail from acct.attachments where ticket_id = $1 and file_name = 'payload.exe'`,
        [ticketBId],
      ),
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].scan_state).toBe('quarantined');
    expect(stored.rows[0].scan_detail).toMatchObject({ reason: 'unsupported_type' });
    const rejected = await withSuperuser((client) =>
      client.query(
        `select attrs from sys.security_events where event_type = 'abuse.upload.rejected' and attrs->>'via' = 'sync'`,
      ),
    );
    expect(rejected.rows).toHaveLength(1);
    expect(rejected.rows[0].attrs).toMatchObject({ reason: 'type', contentType: 'application/x-msdownload' });
  });
});

describe('the outbound queue routes and the Sync card (SN-07, SN-09)', () => {
  let secondId = '';
  let secondVersion = 1;

  it('lists the queue, filters by status and refuses an unknown one', async () => {
    const all = await api().get(`/v1/connectors/${instanceId}/outbound`).set(bearer(adminToken)).expect(200);
    expect(all.body.length).toBeGreaterThan(0);
    expect(all.body[0]).toMatchObject({ instance_id: instanceId, ticket_key: expect.stringMatching(/^CS\d{7}$/) });
    const sent = await api()
      .get(`/v1/connectors/${instanceId}/outbound?status=sent`)
      .set(bearer(adminToken))
      .expect(200);
    expect(sent.body.every((row: { status: string }) => row.status === 'sent')).toBe(true);
    expect(sent.body.length).toBeLessThan(all.body.length);
    const bad = await api()
      .get(`/v1/connectors/${instanceId}/outbound?status=nowhere`)
      .set(bearer(adminToken))
      .expect(400);
    expect(bad.body.code).toBe('bad_status');
    const token = await devToken({ sub: 'dev_consultant', email: 'consultant@example.test' });
    await api().get(`/v1/connectors/${instanceId}/outbound`).set(bearer(token)).expect(403);
  });

  it('requeues one settled row as an audit event and says so when it is already queued', async () => {
    const skipped = await api()
      .get(`/v1/connectors/${instanceId}/outbound?status=skipped`)
      .set(bearer(adminToken))
      .expect(200);
    const target = skipped.body[0];
    expect(target).toBeTruthy();
    const requeued = await api()
      .post(`/v1/connectors/${instanceId}/outbound/${target.id}/retry`)
      .set(bearer(adminToken))
      .expect(201);
    expect(requeued.body).toEqual({ id: target.id, outcome: 'requeued' });
    const again = await api()
      .post(`/v1/connectors/${instanceId}/outbound/${target.id}/retry`)
      .set(bearer(adminToken))
      .expect(201);
    expect(again.body.outcome).toBe('already_pending');
    const audit = await withSuperuser((client) =>
      client.query(`select new_value from acct.audit_events where event_type = 'connector.outbound.retried'`),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].new_value).toMatchObject({ instance_id: instanceId, outbound_id: target.id });
  });

  it('shows the outbound state on the ticket Sync card', async () => {
    const card = await api().get(`/v1/tickets/${ticketBId}/sync`).set(bearer(adminToken)).expect(200);
    expect(card.body.links).toHaveLength(1);
    expect(card.body.links[0]).toMatchObject({ instance_name: 'Brookfield CSM', mode: 'bidirectional' });
    expect(card.body.links[0].outbound).toMatchObject({ pending: 1, failed: 0 });
    expect(card.body.links[0].outbound.last_pushed_at).not.toBeNull();
  });

  it('refuses bidirectional until both maps are active and the credential has been accepted', async () => {
    const created = await api()
      .post(`/v1/accounts/${accountId}/connectors/servicenow`)
      .set(bearer(adminToken))
      .send({
        name: 'Brookfield CSM sandbox',
        base_url: standIn.url,
        auth_kind: 'basic',
        credential: { username: 'xms.integration', password: 'stand-in' },
        profile: 'csm',
      })
      .expect(201);
    secondId = created.body.id;
    secondVersion = created.body.version;
    const noFieldMap = await api()
      .patch(`/v1/connectors/${secondId}`)
      .set(bearer(adminToken))
      .send({ version: secondVersion, mode: 'bidirectional' })
      .expect(409);
    expect(noFieldMap.body.code).toBe('no_active_field_map');

    const fieldMap = await api()
      .post(`/v1/connectors/${secondId}/field-maps`)
      .set(bearer(adminToken))
      .send({ entries: FIELD_MAP })
      .expect(201);
    await api()
      .post(`/v1/connectors/${secondId}/field-maps/${fieldMap.body.id}/validate`)
      .set(bearer(adminToken))
      .expect(201);
    await api()
      .post(`/v1/connectors/${secondId}/field-maps/${fieldMap.body.id}/activate`)
      .set(bearer(adminToken))
      .expect(201);
    secondVersion += 1;
    const noStateMap = await api()
      .patch(`/v1/connectors/${secondId}`)
      .set(bearer(adminToken))
      .send({ version: secondVersion, mode: 'bidirectional' })
      .expect(409);
    expect(noStateMap.body.code).toBe('no_active_state_map');

    const stateMap = await api()
      .post(`/v1/connectors/${secondId}/state-maps`)
      .set(bearer(adminToken))
      .send({ entries: STATE_MAP })
      .expect(201);
    await api()
      .post(`/v1/connectors/${secondId}/state-maps/${stateMap.body.id}/validate`)
      .set(bearer(adminToken))
      .expect(201);
    await api()
      .post(`/v1/connectors/${secondId}/state-maps/${stateMap.body.id}/activate`)
      .set(bearer(adminToken))
      .expect(201);
    secondVersion += 1;
    const untested = await api()
      .patch(`/v1/connectors/${secondId}`)
      .set(bearer(adminToken))
      .send({ version: secondVersion, mode: 'bidirectional' })
      .expect(409);
    expect(untested.body).toMatchObject({ code: 'credential_not_valid', credential_state: 'unknown' });

    await api().post(`/v1/connectors/${secondId}/test-connection`).set(bearer(adminToken)).expect(201);
    const promoted = await api()
      .patch(`/v1/connectors/${secondId}`)
      .set(bearer(adminToken))
      .send({ version: secondVersion, mode: 'bidirectional' })
      .expect(200);
    expect(promoted.body.mode).toBe('bidirectional');
    // Ingest-only remains reachable without any of that.
    const ingest = await api()
      .patch(`/v1/connectors/${secondId}`)
      .set(bearer(adminToken))
      .send({ version: promoted.body.version, mode: 'ingest_only' })
      .expect(200);
    expect(ingest.body.mode).toBe('ingest_only');
  });
});

/**
 * The download cap (review 2026-09-09 finding 3). The instance chooses both
 * the size of the answer and whether it declares one, and the worker that
 * reads it also runs every other account's sync, so an oversized body has to
 * be refused while it is still on the wire rather than after it has been
 * bought into the heap.
 */
describe('the attachment download cap', () => {
  const client = () =>
    new HttpSnowClient(standIn.url, { kind: 'basic', username: 'xms.integration', password: 'stand-in' });

  it('refuses a body over the cap and one that declares no length', async () => {
    const record = standIn.seed(TABLE, { short_description: 'A case with a file' });
    const file = standIn.addAttachment(String(record.sys_id), 'small.txt', 'text/plain', Buffer.from('inside'));

    // Inside the cap, declared: read as it always was.
    expect((await client().downloadAttachment(file.sys_id, 4096)).toString()).toBe('inside');

    // Declared and over: refused on the header.
    standIn.fault = { attachmentBytes: 64 * 1024 };
    await expect(client().downloadAttachment(file.sys_id, 4096)).rejects.toThrow(/over the 4096 byte limit/);

    // No content-length at all: the old pre-check read this as zero bytes
    // and let the whole body through.
    standIn.fault = { attachmentBytes: 64 * 1024, attachmentWithoutLength: true };
    await expect(client().downloadAttachment(file.sys_id, 4096)).rejects.toThrow(/over the 4096 byte limit/);

    // Undeclared but inside the cap is still served.
    standIn.fault = { attachmentWithoutLength: true };
    expect((await client().downloadAttachment(file.sys_id, 4096)).toString()).toBe('inside');
    standIn.fault = {};
  });
});
