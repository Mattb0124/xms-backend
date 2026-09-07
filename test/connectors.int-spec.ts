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

  it('moves to ingest_only with a security event and refuses bidirectional in this cut', async () => {
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
    const refused = await api()
      .patch(`/v1/connectors/${instanceId}`)
      .set(bearer(adminToken))
      .send({ version: instanceVersion, mode: 'bidirectional' })
      .expect(409);
    expect(refused.body.code).toBe('mode_unavailable');
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
