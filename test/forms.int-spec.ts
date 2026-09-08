import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { resetEnvForTests } from '../src/config/env.js';
import { closePools, resetDatabase, urls } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Per-account request forms (CP-03). An operator authors a form for one
 * account and ticket type, edits it as a draft and publishes it; the client
 * is served the published version and never a draft; a submission is checked
 * against the version it was served, and a form of one account is invisible
 * to the portal user of another.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let patToken: string;
let otherToken: string;
let accountId: string;
let otherAccountId: string;

const SERVICE_FORM = {
  fields: [
    {
      key: 'summary',
      kind: 'short_text',
      label: 'What do you need?',
      required: true,
      maps_to: 'short_description',
    },
    {
      key: 'access_kind',
      kind: 'choice',
      label: 'What kind of access?',
      required: true,
      maps_to: 'custom.access_kind',
      options: [
        { value: 'new_user', label: 'A new user' },
        { value: 'other', label: 'Something else' },
      ],
    },
    {
      key: 'other_detail',
      kind: 'long_text',
      label: 'Tell us what you need',
      required: true,
      maps_to: 'description',
      visible_when: { field: 'access_kind', equals: 'other' },
    },
    { key: 'needed_by', kind: 'date', label: 'Needed by', maps_to: 'custom.needed_by' },
  ],
};

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
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  accountId = await anAccount('BRK', 'Brookfield');
  otherAccountId = await anAccount('NOR', 'Northwind');

  const roles = await api().get('/v1/admin/roles?catalog=portal').set(bearer(adminToken)).expect(200);
  const requester = roles.body.find((role: { name: string }) => role.name === 'Requester');
  await aPortalUser(accountId, 'pat@client.test', 'Pat', requester.id);
  await aPortalUser(otherAccountId, 'nell@northwind.test', 'Nell', requester.id);
  patToken = await devToken({ sub: 'dev_pat', email: 'pat@client.test', org: 'acct-brk', sid: 'sess_pat' });
  otherToken = await devToken({ sub: 'dev_nell', email: 'nell@northwind.test', org: 'acct-nor', sid: 'sess_nell' });
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = (): request.Agent => request(app.getHttpServer());
const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

async function anAccount(key: string, name: string): Promise<string> {
  const account = await api().post('/v1/admin/accounts').set(bearer(adminToken)).send({ key, name }).expect(201);
  await api().post(`/v1/admin/accounts/${account.body.id}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${account.body.id}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Support retainer', model: 'retainer' })
    .expect(201);
  return account.body.id;
}

async function aPortalUser(account: string, email: string, firstName: string, roleId: string): Promise<void> {
  await api()
    .post(`/v1/admin/accounts/${account}/portal-users`)
    .set(bearer(adminToken))
    .send({ email, first_name: firstName, last_name: 'Client', role_ids: [roleId] })
    .expect(201);
}

describe('authoring a request form', () => {
  it('serves the fixed default until the account publishes one, and refuses a definition it could not enforce', async () => {
    const before = await api().get('/v1/portal/forms/service_request').set(bearer(patToken)).expect(200);
    expect(before.body.source).toBe('default');
    expect(before.body.form_version_id).toBeNull();
    expect(before.body.definition.fields.map((field: { key: string }) => field.key)).toContain('short_description');

    const refused = await api()
      .post(`/v1/accounts/${accountId}/forms`)
      .set(bearer(adminToken))
      .send({
        ticket_type: 'service_request',
        name: 'Broken',
        definition: { fields: [{ key: 'a', kind: 'number', label: 'A', maps_to: 'description' }] },
      })
      .expect(400);
    expect(refused.body.code).toBe('invalid_form_definition');
    expect(refused.body.problems[0]).toMatchObject({ field: 'a', code: 'bad_maps_to' });
  });

  it('keeps a draft off the portal until it is published, then serves exactly it', async () => {
    const created = await api()
      .post(`/v1/accounts/${accountId}/forms`)
      .set(bearer(adminToken))
      .send({ ticket_type: 'service_request', name: 'Ask for something', description: 'Access and small changes' })
      .expect(201);
    const formId = created.body.id as string;
    expect(created.body.current_version_id).toBeNull();

    const draft = await api()
      .post(`/v1/accounts/${accountId}/forms/${formId}/versions`)
      .set(bearer(adminToken))
      .send({ definition: SERVICE_FORM })
      .expect(201);
    expect(draft.body.version_no).toBe(2);
    expect(draft.body.published_at).toBeNull();

    // A draft is not the account's form: the portal still sees the default.
    const whileDraft = await api().get('/v1/portal/forms/service_request').set(bearer(patToken)).expect(200);
    expect(whileDraft.body.source).toBe('default');

    const published = await api()
      .post(`/v1/accounts/${accountId}/forms/${formId}/versions/${draft.body.id}/publish`)
      .set(bearer(adminToken))
      .expect(201);
    expect(published.body.current_version_id).toBe(draft.body.id);

    const served = await api().get('/v1/portal/forms/service_request').set(bearer(patToken)).expect(200);
    expect(served.body).toMatchObject({ source: 'published', form_id: formId, form_version_id: draft.body.id });
    expect(served.body.definition).toEqual(SERVICE_FORM);

    // Published is frozen: the edit route refuses it rather than rewriting
    // the contract a request in flight was submitted against.
    const frozen = await api()
      .put(`/v1/accounts/${accountId}/forms/${formId}/versions/${draft.body.id}`)
      .set(bearer(adminToken))
      .send({ definition: SERVICE_FORM })
      .expect(409);
    expect(frozen.body.code).toBe('form_version_published');
  });

  it('shows the account its own forms and shows another account nothing of them', async () => {
    const mine = await api().get(`/v1/accounts/${accountId}/forms`).set(bearer(adminToken)).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].versions).toHaveLength(2);

    const theirs = await api().get(`/v1/accounts/${otherAccountId}/forms`).set(bearer(adminToken)).expect(200);
    expect(theirs.body).toEqual([]);

    const otherPortal = await api().get('/v1/portal/forms').set(bearer(otherToken)).expect(200);
    expect(otherPortal.body.items.every((item: { source: string }) => item.source === 'default')).toBe(true);
    expect(otherPortal.body.items.map((item: { form_id: string | null }) => item.form_id)).toEqual([null, null]);
  });
});

describe('submitting against a published form', () => {
  it('refuses the old flat shape once a form is published, and names a missing required field', async () => {
    const flat = await api()
      .post('/v1/portal/tickets')
      .set(bearer(patToken))
      .send({ type: 'service_request', short_description: 'A laptop please' })
      .expect(400);
    expect(flat.body.code).toBe('form_answers_required');

    const missing = await api()
      .post('/v1/portal/tickets')
      .set(bearer(patToken))
      .send({ type: 'service_request', answers: { summary: 'A laptop please' } })
      .expect(400);
    expect(missing.body.code).toBe('invalid_submission');
    expect(missing.body.problems).toEqual([
      { field: 'access_kind', code: 'required', message: '"What kind of access?" is required' },
    ]);
  });

  it('requires a conditional field only when its condition holds', async () => {
    const hidden = await api()
      .post('/v1/portal/tickets')
      .set(bearer(patToken))
      .send({
        type: 'service_request',
        answers: { summary: 'A new starter', access_kind: 'new_user', needed_by: '2026-10-01' },
      })
      .expect(201);
    expect(hidden.body.short_description).toBe('A new starter');
    expect(hidden.body.form_data).toEqual({ access_kind: 'new_user', needed_by: '2026-10-01' });
    expect(hidden.body.form_version_id).not.toBeNull();

    const shown = await api()
      .post('/v1/portal/tickets')
      .set(bearer(patToken))
      .send({ type: 'service_request', answers: { summary: 'Something else', access_kind: 'other' } })
      .expect(400);
    expect(shown.body.problems).toEqual([
      { field: 'other_detail', code: 'required', message: '"Tell us what you need" is required' },
    ]);

    const answered = await api()
      .post('/v1/portal/tickets')
      .set(bearer(patToken))
      .send({
        type: 'service_request',
        answers: { summary: 'Something else', access_kind: 'other', other_detail: 'A second monitor' },
      })
      .expect(201);
    expect(answered.body.description).toBe('A second monitor');
    expect(answered.body.form_data).toEqual({ access_kind: 'other' });
  });

  it('refuses an answer of the wrong kind and one the form never asked for', async () => {
    const refused = await api()
      .post('/v1/portal/tickets')
      .set(bearer(patToken))
      .send({
        type: 'service_request',
        answers: { summary: 'A laptop', access_kind: 'new_user', needed_by: 'soon', colour: 'blue' },
      })
      .expect(400);
    expect(refused.body.problems.map((problem: { code: string }) => problem.code).sort()).toEqual([
      'bad_value',
      'unknown_field',
    ]);
  });

  it('leaves a type the account offers no form for on the fixed default', async () => {
    const created = await api()
      .post('/v1/portal/tickets')
      .set(bearer(patToken))
      .send({ type: 'incident', short_description: 'The reports stopped running' })
      .expect(201);
    expect(created.body.form_version_id).toBeNull();
    expect(created.body.form_data).toEqual({});

    // Change is an internal type until the account publishes a form for it.
    const refused = await api()
      .post('/v1/portal/tickets')
      .set(bearer(patToken))
      .send({ type: 'change', short_description: 'Move the cutover' })
      .expect(400);
    expect(refused.body.code).toBe('type_not_offered');
  });
});
