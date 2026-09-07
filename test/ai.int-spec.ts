import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { HARNESS_CLIENT } from '../src/modules/ai/harness-client.js';
import { closePools, pools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken, HARNESS_SECRET, harnessToken } from './kit/auth.js';
import { FakeHarness, proposal, turn } from './kit/harness.js';

/**
 * The Axel adapter over the real database with an in-process harness
 * (P1.7.1 to P1.7.4 cut; AI-09 to AI-13): the switch policy withholds
 * before anything leaves (switch off, capability off, residency, redaction
 * refusal, harness down), the harness request carries only the allowed
 * fields, a proposal becomes an offered suggestion with provenance, a low
 * confidence is withheld with its payload kept, decisions apply through
 * the ticket service with an AI-actor audit event and refuse a second
 * decision, the data layer refuses an offered row for a disabled account,
 * disabling cascades, the interactive turn relays SSE and records the
 * thread, and accuracy reports counts and the what-if.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let harness: FakeHarness;

beforeAll(async () => {
  await resetDatabase();
  const db = urls();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PORTAL: db.portal,
    DATABASE_URL_WORKER: db.worker,
    AUTH_DEV_SECRET: DEV_SECRET,
    HARNESS_SESSION_SECRET: HARNESS_SECRET,
    HARNESS_BASE_URL: 'http://harness.test',
    HARNESS_ORIGIN: 'http://xms.test',
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
    STORAGE_KIND: 'local',
    STORAGE_LOCAL_ROOT: mkdtempSync(join(tmpdir(), 'xms-store-')),
    MAIL_TRANSPORT: 'file',
  });
  resetEnvForTests();
  const { AppModule } = await import('../src/app.module.js');
  harness = new FakeHarness();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(HARNESS_CLIENT)
    .useValue(harness)
    .compile();
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
    .send({ name: 'Retainer', model: 'retainer' })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

beforeEach(() => harness.reset());

function api() {
  return request(app.getHttpServer());
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createTicket(shortDescription: string, description?: string): Promise<{ id: string; version: number }> {
  const response = await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: shortDescription,
      description,
      requester_email: 'pat@client.test',
      requester_name: 'Pat Client',
    })
    .expect(201);
  return response.body;
}

async function enableAi(extra: Record<string, unknown> = {}): Promise<void> {
  const current = await api().get(`/v1/accounts/${accountId}/ai-settings`).set(bearer(adminToken)).expect(200);
  await api()
    .put(`/v1/accounts/${accountId}/ai-settings`)
    .set(bearer(adminToken))
    .send({ enabled: true, dpa_reference: 'DPA-2026-01', version: current.body.version || undefined, ...extra })
    .expect(200);
}

async function inviteUser(email: string, roleName: string): Promise<void> {
  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const role = (roles.body as { id: string; name: string }[]).find((row) => row.name === roleName);
  if (!role) throw new Error(`role ${roleName} missing`);
  await api()
    .post('/v1/admin/users')
    .set(bearer(adminToken))
    .send({ email, first_name: 'Test', last_name: roleName, role_ids: [role.id], account_ids: [accountId] })
    .expect(201);
}

describe('the AI switch (AI-11, AI-12)', () => {
  it('is off for a new account and withholds a request with switch_off before calling the harness', async () => {
    const settings = await api().get(`/v1/accounts/${accountId}/ai-settings`).set(bearer(adminToken)).expect(200);
    expect(settings.body).toMatchObject({ enabled: false, effective: { on: false, reason: 'switch_off' } });
    expect(settings.body.capabilities.classify).toMatchObject({ enabled: true, threshold: 0.7 });
    const ticket = await createTicket('VPN drops every 20 minutes');
    const response = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(response.body).toMatchObject({ status: 'withheld', withheld_reason: 'switch_off' });
    expect(harness.requests).toHaveLength(0);
    const events = await withSuperuser((client) =>
      client.query(`select outcome, attrs from sys.security_events where event_type = 'ai.suggestion.withheld'`),
    );
    expect(events.rows.at(-1)).toMatchObject({ outcome: 'withheld', attrs: { reason: 'switch_off' } });
  });

  it('refuses to enable without a DPA reference or with an unserved residency', async () => {
    const noDpa = await api()
      .put(`/v1/accounts/${accountId}/ai-settings`)
      .set(bearer(adminToken))
      .send({ enabled: true })
      .expect(400);
    expect(noDpa.body.code).toBe('dpa_required');
    const residency = await api()
      .put(`/v1/accounts/${accountId}/ai-settings`)
      .set(bearer(adminToken))
      .send({ enabled: true, dpa_reference: 'DPA-1', residency_region: 'eu' })
      .expect(400);
    expect(residency.body.code).toBe('residency_unsupported');
    const badCapability = await api()
      .put(`/v1/accounts/${accountId}/ai-settings`)
      .set(bearer(adminToken))
      .send({ capabilities: { classify: { auto_apply: true } } })
      .expect(400);
    expect(badCapability.body.code).toBe('invalid_capabilities');
  });

  it('enables with a DPA reference, audits the flip and raises the security event', async () => {
    await enableAi();
    const settings = await api().get(`/v1/accounts/${accountId}/ai-settings`).set(bearer(adminToken)).expect(200);
    expect(settings.body).toMatchObject({ enabled: true, dpa_reference: 'DPA-2026-01', effective: { on: true } });
    const audit = await withSuperuser((client) =>
      client.query(
        `select field, new_value from acct.audit_events where event_type = 'ai.settings.changed' and field = 'enabled'`,
      ),
    );
    expect(audit.rows).toHaveLength(1);
    const security = await withSuperuser((client) =>
      client.query(`select attrs from sys.security_events where event_type = 'admin.account.ai_switch_changed'`),
    );
    expect(security.rows.at(-1)?.attrs).toMatchObject({ enabled: true });
  });

  it('requires ai:configure to read or change settings', async () => {
    const consultant = await devToken({ sub: 'dev_consultant', email: 'consultant@example.test' });
    await inviteUser('consultant@example.test', 'Consultant');
    await api().get(`/v1/accounts/${accountId}/ai-settings`).set(bearer(consultant)).expect(403);
  });
});

describe('single-shot suggestions (AI-09, AI-10)', () => {
  it('sends only the allowed fields with the minted session token and stores an offered classification', async () => {
    const ticket = await createTicket('VPN drops every 20 minutes', 'Since the 2.4.1 client update, floor 3 only.');
    harness.script = () =>
      turn(
        proposal('The symptoms point to the VPN client.', {
          category: 'Network / VPN',
          ticket_type: 'incident',
          reasons: { category: 'client update correlation' },
          confidence: 0.91,
        }),
        { modelId: 'anthropic.claude-haiku-4-5' },
      );
    const response = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(response.body).toMatchObject({
      status: 'offered',
      capability: 'classify',
      payload: { category: 'Network / VPN', ticket_type: 'incident' },
      confidence: 0.91,
      agent_id: 'xms-triage',
      prompt_version: 'classify/2026-09-07.1',
      model_id: 'anthropic.claude-haiku-4-5',
      explanation: 'The symptoms point to the VPN client.',
    });
    expect(response.body.expires_at).toBeTruthy();
    expect(harness.requests).toHaveLength(1);
    const [sent] = harness.requests;
    expect(sent.agentId).toBe('xms-triage');
    expect(Object.keys(sent.body).sort()).toEqual(['message', 'session_id']);
    expect(sent.body.message).toContain('VPN drops every 20 minutes');
    expect(sent.body.message).toContain('Pat Client');
    // The session token is an HS256 JWT for the calling user, minted with the shared secret.
    const claims = JSON.parse(Buffer.from(sent.token.split('.')[1], 'base64url').toString('utf8'));
    expect(claims).toMatchObject({ type: 'session', email: ADMIN_EMAIL, org_slug: 'hackett' });
    const audit = await withSuperuser((client) =>
      client.query(
        `select actor_kind, actor_id, ai_suggestion_id from acct.audit_events where event_type = 'ai.suggestion.offered' and ticket_id = $1`,
        [ticket.id],
      ),
    );
    expect(audit.rows).toEqual([{ actor_kind: 'ai', actor_id: 'axel', ai_suggestion_id: response.body.id }]);
    const open = await api()
      .get(`/v1/axel/suggestions?target_kind=ticket&target_id=${ticket.id}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(open.body.map((row: { id: string }) => row.id)).toEqual([response.body.id]);
  });

  it('withholds below the threshold and keeps the payload for the what-if', async () => {
    const ticket = await createTicket('Printer on floor 2 jams');
    harness.script = () =>
      turn(proposal('Unsure.', { impact: 'low', urgency: 'low', reason: 'guess', confidence: 0.4 }));
    const response = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'prioritise', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(response.body).toMatchObject({
      status: 'withheld',
      withheld_reason: 'below_threshold',
      confidence: 0.4,
      payload: { impact: 'low' },
    });
    const open = await api()
      .get(`/v1/axel/suggestions?target_kind=ticket&target_id=${ticket.id}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(open.body).toEqual([]);
  });

  it('withholds with schema_error, no_content and unavailable, each after recording why', async () => {
    const ticket = await createTicket('Laptop will not boot');
    harness.script = () => turn(proposal('Here.', { category: 42, confidence: 'high' }));
    const bad = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(bad.body).toMatchObject({ status: 'withheld', withheld_reason: 'schema_error' });
    expect(bad.body.payload.problems.join(' ')).toContain('category');

    harness.script = () => turn('I could not decide.');
    const none = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(none.body).toMatchObject({ status: 'withheld', withheld_reason: 'no_content' });

    harness.unavailable(503, 'maintenance');
    const down = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(down.body).toMatchObject({ status: 'withheld', withheld_reason: 'unavailable' });
    const failed = await withSuperuser((client) =>
      client.query(`select attrs from sys.security_events where event_type = 'ai.turn.failed' and entity_id = $1`, [
        ticket.id,
      ]),
    );
    expect(String(failed.rows[0]?.attrs?.detail)).toContain('503');
  });

  it('redacts credentials before egress and refuses a private key block', async () => {
    const leaky = await createTicket(
      'Cannot reach the API',
      'Using api_key=sk_live_ABCDEF123456 against https://ops:pa55word@api.example.com fails.',
    );
    harness.script = () => turn(proposal('Ok.', { category: 'Integration', confidence: 0.8 }));
    await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: leaky.id })
      .expect(201);
    const sent = harness.requests.at(-1)!.body.message;
    expect(sent).not.toContain('sk_live_ABCDEF123456');
    expect(sent).not.toContain('pa55word');
    expect(sent).toContain('[redacted:credential]');
    const redacted = await withSuperuser((client) =>
      client.query(`select attrs from sys.security_events where event_type = 'ai.egress.redacted' and entity_id = $1`, [
        leaky.id,
      ]),
    );
    expect(redacted.rows[0]?.attrs).toMatchObject({ counts: { credential: 2 }, refused: false });

    const key = await createTicket(
      'Key attached',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    );
    harness.requests.length = 0;
    const response = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: key.id })
      .expect(201);
    expect(response.body).toMatchObject({ status: 'withheld', withheld_reason: 'redaction_refused' });
    expect(harness.requests).toHaveLength(0);
  });

  it('withholds capability_off when the account switched a capability off, without calling the harness', async () => {
    await enableAi({ capabilities: { summarise: { enabled: false } } });
    const ticket = await createTicket('Summarise me');
    const response = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'summarise', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(response.body).toMatchObject({ status: 'withheld', withheld_reason: 'capability_off' });
    expect(harness.requests).toHaveLength(0);
    await enableAi({ capabilities: {} });
  });

  it('proposes duplicates from same-account candidates only and records the merge target', async () => {
    const original = await createTicket('Outlook keeps asking for the password');
    const repeat = await createTicket('Outlook asking for password again and again');
    harness.script = (_agent, body) => {
      expect(body.message).toContain(original.id);
      return turn(
        proposal('Same issue.', {
          candidates: [{ ticket_id: original.id, similarity: 0.93, reason: 'same symptom' }],
          merge_into: original.id,
          confidence: 0.9,
        }),
      );
    };
    const response = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'duplicate', target_kind: 'ticket', target_id: repeat.id })
      .expect(201);
    expect(response.body).toMatchObject({ status: 'offered', payload: { merge_into: original.id } });
  });

  it('rejects an unbuilt capability and an unknown ticket', async () => {
    const ticket = await createTicket('Whatever');
    await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'wsr_narrative', target_kind: 'ticket', target_id: ticket.id })
      .expect(400);
    await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: '00000000-0000-4000-8000-00000000dead' })
      .expect(404);
    expect(harness.requests).toHaveLength(0);
  });
});

describe('decisions (AI-10)', () => {
  async function offered(
    capability: 'classify' | 'prioritise' | 'draft_reply',
    ticketId: string,
    body: Record<string, unknown>,
  ) {
    harness.script = () => turn(proposal('Proposal.', body));
    const response = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability, target_kind: 'ticket', target_id: ticketId })
      .expect(201);
    expect(response.body.status).toBe('offered');
    return response.body as { id: string };
  }

  it('accepting a classification applies the category through the ticket service and links the audit', async () => {
    const ticket = await createTicket('Badge reader broken at the east door');
    const suggestion = await offered('classify', ticket.id, { category: 'Facilities / Access', confidence: 0.88 });
    const decision = await api()
      .post(`/v1/axel/suggestions/${suggestion.id}/decisions`)
      .set(bearer(adminToken))
      .send({ decision: 'accepted' })
      .expect(201);
    const me = await api().get('/v1/admin/me').set(bearer(adminToken)).expect(200);
    expect(decision.body.decision).toMatchObject({ decision: 'accepted', decided_by_id: me.body.principal.userId });
    const after = await api().get(`/v1/tickets/${ticket.id}`).set(bearer(adminToken)).expect(200);
    expect(after.body.category).toBe('Facilities / Access');
    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type, actor_kind, ai_suggestion_id from acct.audit_events where ticket_id = $1 and event_type in ('ticket.updated', 'ai.suggestion.applied') order by created_at`,
        [ticket.id],
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(['ticket.updated', 'ai.suggestion.applied']);
    expect(audit.rows[1]).toMatchObject({ actor_kind: 'ai', ai_suggestion_id: suggestion.id });
    // A second final decision is refused.
    const again = await api()
      .post(`/v1/axel/suggestions/${suggestion.id}/decisions`)
      .set(bearer(adminToken))
      .send({ decision: 'rejected' })
      .expect(409);
    expect(again.body.code).toBe('already_decided');
  });

  it('an edited acceptance applies the edited payload and records the edit distance for text', async () => {
    const ticket = await createTicket('Need the VPN guide');
    const suggestion = await offered('draft_reply', ticket.id, {
      text: 'Hello Pat, here is the guide.',
      tone: 'plain',
    });
    const decision = await api()
      .post(`/v1/axel/suggestions/${suggestion.id}/decisions`)
      .set(bearer(adminToken))
      .send({
        decision: 'edited_accepted',
        applied_payload: { text: 'Hello Pat, here is the VPN guide.', tone: 'plain' },
      })
      .expect(201);
    expect(decision.body.decision).toMatchObject({ decision: 'edited_accepted', edit_distance: 4 });
  });

  it('a prioritisation is refused once the ticket is assigned, and rejected suggestions record the reason', async () => {
    const ticket = await createTicket('Whole floor cannot print');
    const suggestion = await offered('prioritise', ticket.id, {
      impact: 'high',
      urgency: 'high',
      reason: 'floor-wide',
      confidence: 0.95,
    });
    const me = await api().get('/v1/admin/me').set(bearer(adminToken)).expect(200);
    await api()
      .patch(`/v1/tickets/${ticket.id}`)
      .set(bearer(adminToken))
      .send({ version: ticket.version, assignee_id: me.body.principal.userId })
      .expect(200);
    const blocked = await api()
      .post(`/v1/axel/suggestions/${suggestion.id}/decisions`)
      .set(bearer(adminToken))
      .send({ decision: 'accepted' })
      .expect(409);
    expect(blocked.body.code).toBe('target_state');
    const rejected = await api()
      .post(`/v1/axel/suggestions/${suggestion.id}/decisions`)
      .set(bearer(adminToken))
      .send({ decision: 'rejected', reject_reason: 'already_done' })
      .expect(201);
    expect(rejected.body.decision).toMatchObject({ decision: 'rejected', reject_reason: 'already_done' });
    const history = await api()
      .get(`/v1/axel/suggestions?target_kind=ticket&target_id=${ticket.id}&history=true`)
      .set(bearer(adminToken))
      .expect(200);
    expect(history.body[0].decision).toMatchObject({ decision: 'rejected' });
  });

  it('needs the capability permission to decide and records feedback', async () => {
    const ticket = await createTicket('Permission check');
    const suggestion = await offered('classify', ticket.id, { category: 'X', confidence: 0.9 });
    const viewer = await devToken({ sub: 'dev_viewer', email: 'viewer@example.test' });
    await inviteUser('viewer@example.test', 'Finance');
    await api()
      .post(`/v1/axel/suggestions/${suggestion.id}/decisions`)
      .set(bearer(viewer))
      .send({ decision: 'accepted' })
      .expect(403);
    await api()
      .post(`/v1/axel/suggestions/${suggestion.id}/feedback`)
      .set(bearer(adminToken))
      .send({ rating: 4, comment: 'Close enough' })
      .expect(201);
  });

  it('expires open suggestions past their life through the worker job', async () => {
    const ticket = await createTicket('Expiry');
    const suggestion = await offered('classify', ticket.id, { category: 'Y', confidence: 0.9 });
    await withSuperuser((client) =>
      client
        .query(`update acct.ai_suggestions set expires_at = now() - interval '1 minute' where id = $1`, [suggestion.id])
        .catch(async () => {
          // Append-only: move the clock instead by inserting nothing; the job reads expires_at, so use a superuser bypass.
          await client.query(`alter table acct.ai_suggestions disable trigger trg_acct_ai_suggestions_append_only`);
          await client.query(`update acct.ai_suggestions set expires_at = now() - interval '1 minute' where id = $1`, [
            suggestion.id,
          ]);
          await client.query(`alter table acct.ai_suggestions enable trigger trg_acct_ai_suggestions_append_only`);
        }),
    );
    const { SuggestionService } = await import('../src/modules/ai/suggestion.service.js');
    const outcome = await app.get(SuggestionService).expire();
    expect(outcome).toBe('expired 1');
    const late = await api()
      .post(`/v1/axel/suggestions/${suggestion.id}/decisions`)
      .set(bearer(adminToken))
      .send({ decision: 'accepted' })
      .expect(409);
    expect(late.body.code).toBe('expired');
  });
});

describe('the data-layer backstop and the disable cascade (AI-11)', () => {
  it('refuses an offered row for an account whose switch is off, even from the app role', async () => {
    const other = await api()
      .post('/v1/admin/accounts')
      .set(bearer(adminToken))
      .send({ key: 'AUS', name: 'Austin' })
      .expect(201);
    await api().post(`/v1/admin/accounts/${other.body.id}/activate`).set(bearer(adminToken)).expect(201);
    const { withSession } = await import('../src/db/session.js');
    const insert = (status: string) =>
      withSession(pools(), 'app', { binding: { kind: 'operator', accountIds: [other.body.id] } }, (tx) =>
        tx.query(
          `insert into acct.ai_suggestions (account_id, capability, target_kind, target_id, status_initial, withheld_reason, agent_id, prompt_version, requested_by)
           values ($1, 'classify', 'ticket', 'x', $2, $3, 'xms-triage', 'v', 'test')`,
          [other.body.id, status, status === 'withheld' ? 'switch_off' : null],
        ),
      );
    await expect(insert('offered')).rejects.toMatchObject({ code: '42501' });
    await expect(insert('withheld')).resolves.toBeTruthy();
  });

  it('disabling the switch expires every open suggestion in the same transaction', async () => {
    const ticket = await createTicket('Cascade');
    harness.script = () => turn(proposal('Ok.', { category: 'Z', confidence: 0.9 }));
    const suggestion = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(suggestion.body.status).toBe('offered');
    const current = await api().get(`/v1/accounts/${accountId}/ai-settings`).set(bearer(adminToken)).expect(200);
    await api()
      .put(`/v1/accounts/${accountId}/ai-settings`)
      .set(bearer(adminToken))
      .send({ enabled: false, version: current.body.version })
      .expect(200);
    const decisions = await withSuperuser((client) =>
      client.query(
        `select decision, decided_by_id, policy_version from acct.ai_suggestion_decisions where suggestion_id = $1`,
        [suggestion.body.id],
      ),
    );
    expect(decisions.rows).toEqual([{ decision: 'expired', decided_by_id: 'ai_switch', policy_version: 'switch_off' }]);
    const cascade = await withSuperuser((client) =>
      client.query(
        `select count(*)::int as n from acct.audit_events where event_type = 'ai.settings.changed' and field = 'cascade'`,
      ),
    );
    expect(cascade.rows[0].n).toBe(1);
    await enableAi();
  });
});

describe('the interactive turn (P1.7.2)', () => {
  it('relays the harness frames as SSE, records the thread and turns a proposal into a suggestion', async () => {
    const ticket = await createTicket('Panel ticket', 'Some context.');
    harness.script = (_agent, body) => {
      expect(body.opportunity_id).toBe('solution:xms');
      expect(body.thread_id).toBeNull();
      expect(body.message).toContain('Panel ticket');
      return turn(
        proposal('Here is a summary.', {
          capability: 'summarise',
          situation: 'Panel ticket open',
          done: 'nothing',
          waiting_on: 'requester',
          next_step: 'call',
        }),
        { threadId: 'thr_42', streamId: 'stream-77', attachment: true },
      );
    };
    const response = await api()
      .post('/v1/axel/turns')
      .set(bearer(adminToken))
      .send({ agent: 'desk_assistant', message: 'Summarise this for me', ticket_id: ticket.id })
      .expect(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const frames = String(response.text)
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));
    expect(frames.at(-1)).toBe('[DONE]');
    const parsed = frames.slice(0, -1).map((frame) => JSON.parse(frame));
    expect(parsed[0]).toEqual({ type: 'stream_started', stream_id: 'stream-77' });
    expect(parsed.find((frame) => frame.type === 'thread_created')).toEqual({
      type: 'thread_created',
      thread_id: 'thr_42',
    });
    expect(
      parsed
        .filter((frame) => frame.content !== undefined)
        .map((frame) => frame.content)
        .join(''),
    ).toContain('Here is a summary.');
    const attachment = parsed.find((frame) => frame.type === 'attachment');
    expect(attachment).toEqual({ type: 'attachment', filename: 'summary.docx', mimeType: expect.any(String), size: 3 });
    expect(JSON.stringify(parsed)).not.toContain('AAAA');
    const suggestion = parsed.find((frame) => frame.type === 'xms_suggestion');
    expect(suggestion.suggestion).toMatchObject({ capability: 'summarise', status: 'offered', thread_id: 'thr_42' });
    const threads = await api().get(`/v1/axel/threads?ticket=${ticket.id}`).set(bearer(adminToken)).expect(200);
    expect(threads.body).toHaveLength(1);
    expect(threads.body[0]).toMatchObject({ thread_id: 'thr_42', agent_id: 'xms-desk-assistant' });
    // Cancel goes to the harness for the owner only.
    await api().post('/v1/axel/turns/stream-77/cancel').set(bearer(adminToken)).expect(201);
    expect(harness.cancelled).toEqual(['stream-77']);
    await api().post('/v1/axel/turns/stream-unknown/cancel').set(bearer(adminToken)).expect(404);
    const started = await withSuperuser((client) =>
      client.query(
        `select count(*)::int as n from sys.security_events where event_type = 'ai.turn.started' and entity_id = $1`,
        [ticket.id],
      ),
    );
    expect(started.rows[0].n).toBe(1);
  });

  it('answers with an error frame and [DONE] when the harness is unavailable, and when the switch is off', async () => {
    const ticket = await createTicket('Down');
    harness.unavailable(502, 'bad gateway');
    const down = await api()
      .post('/v1/axel/turns')
      .set(bearer(adminToken))
      .send({ agent: 'desk_assistant', message: 'hi', ticket_id: ticket.id })
      .expect(200);
    expect(down.text).toContain('"code":"unavailable"');
    expect(down.text.trim().endsWith('data: [DONE]')).toBe(true);
    const current = await api().get(`/v1/accounts/${accountId}/ai-settings`).set(bearer(adminToken)).expect(200);
    await api()
      .put(`/v1/accounts/${accountId}/ai-settings`)
      .set(bearer(adminToken))
      .send({ enabled: false, version: current.body.version })
      .expect(200);
    harness.reset();
    const off = await api()
      .post('/v1/axel/turns')
      .set(bearer(adminToken))
      .send({ agent: 'desk_assistant', message: 'hi', ticket_id: ticket.id })
      .expect(200);
    expect(off.text).toContain('"code":"withheld"');
    expect(off.text).toContain('switch_off');
    expect(harness.requests).toHaveLength(0);
    await enableAi();
  });
});

describe('proposals from MCP tool calls (AI Integration section 4)', () => {
  it('stores a propose_* payload sent with a harness session token as an offered suggestion', async () => {
    const ticket = await createTicket('MCP proposal');
    const token = await harnessToken({ sub: 'harness_admin', email: ADMIN_EMAIL });
    const response = await api()
      .post('/v1/axel/proposals')
      .set(bearer(token))
      .send({
        capability: 'summarise',
        target_kind: 'ticket',
        target_id: ticket.id,
        thread_id: 'thr_mcp',
        payload: { situation: 'Open', done: 'Nothing', waiting_on: 'Us', next_step: 'Call' },
      })
      .expect(201);
    expect(response.body).toMatchObject({
      status: 'offered',
      capability: 'summarise',
      agent_id: 'xms-desk-assistant',
      prompt_version: 'mcp/summarise',
      thread_id: 'thr_mcp',
    });
    expect(harness.requests).toHaveLength(0);
    const bad = await api()
      .post('/v1/axel/proposals')
      .set(bearer(token))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: ticket.id, payload: { nope: 1 } })
      .expect(201);
    expect(bad.body).toMatchObject({ status: 'withheld', withheld_reason: 'schema_error' });
  });
});

describe('worker intake and accuracy (AI-13)', () => {
  it('runs classify, prioritise and duplicate on ticket.created and is idempotent on replay', async () => {
    await createTicket('Intake ticket sibling', 'Earlier report of the same thing.');
    await createTicket('Intake ticket sibling', 'Earlier report of the same thing.');
    const ticket = await createTicket('Intake ticket', 'Details.');
    harness.script = (agent, body) =>
      body.message.startsWith('Classify')
        ? turn(proposal('c', { category: 'Intake', confidence: 0.9 }))
        : body.message.startsWith('Assess')
          ? turn(proposal('p', { impact: 'medium', urgency: 'low', reason: 'r', confidence: 0.8 }))
          : turn(proposal('d', { candidates: [], merge_into: null, confidence: 0.2 }));
    const { SuggestionService } = await import('../src/modules/ai/suggestion.service.js');
    const service = app.get(SuggestionService);
    const first = await service.intake(accountId, ticket.id);
    expect(first.split(',').sort()).toEqual([
      'classify:offered',
      'duplicate:withheld:below_threshold',
      'prioritise:offered',
    ]);
    const again = await service.intake(accountId, ticket.id);
    expect(again.split(',').sort()).toEqual([
      'classify:exists',
      'duplicate:withheld:below_threshold',
      'prioritise:exists',
    ]);
    const open = await api()
      .get(`/v1/axel/suggestions?target_kind=ticket&target_id=${ticket.id}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(open.body.map((row: { capability: string }) => row.capability).sort()).toEqual(['classify', 'prioritise']);
    expect(open.body.every((row: { requested_by?: string }) => row.requested_by === undefined)).toBe(true);
  });

  it('reports counts per capability and the threshold what-if', async () => {
    const report = await api()
      .get(`/v1/axel/accuracy?account=${accountId}&capability=classify&threshold=0.9`)
      .set(bearer(adminToken))
      .expect(200);
    const classify = report.body.capabilities.find((row: { capability: string }) => row.capability === 'classify');
    expect(classify).toBeDefined();
    expect(classify.offered).toBeGreaterThanOrEqual(4);
    expect(classify.accepted).toBeGreaterThanOrEqual(1);
    expect(classify.withheld).toBeGreaterThanOrEqual(3);
    expect(classify.withheld_reasons.schema_error).toBeGreaterThanOrEqual(1);
    expect(classify.withheld_reasons.no_content).toBe(1);
    expect(classify.acceptance_rate).toBeGreaterThan(0);
    expect(classify.what_if).toMatchObject({ withheld: expect.any(Number) });
    expect(classify.what_if.withheld).toBeGreaterThanOrEqual(1);
  });

  it('exposes and updates the operator defaults with the kill switch', async () => {
    const defaults = await api().get('/v1/axel/config/defaults').set(bearer(adminToken)).expect(200);
    expect(defaults.body.active.body.kill_switch).toBe(false);
    const body = { ...defaults.body.active.body, kill_switch: true };
    await api().put('/v1/axel/config/defaults').set(bearer(adminToken)).send({ body }).expect(200);
    const ticket = await createTicket('Kill switch');
    const response = await api()
      .post('/v1/axel/suggest')
      .set(bearer(adminToken))
      .send({ capability: 'classify', target_kind: 'ticket', target_id: ticket.id })
      .expect(201);
    expect(response.body).toMatchObject({ status: 'withheld', withheld_reason: 'capability_off' });
    await api()
      .put('/v1/axel/config/defaults')
      .set(bearer(adminToken))
      .send({ body: { ...body, kill_switch: false } })
      .expect(200);
    await api()
      .put('/v1/axel/config/defaults')
      .set(bearer(adminToken))
      .send({ body: { kill_switch: 'no' } })
      .expect(400);
  });
});
