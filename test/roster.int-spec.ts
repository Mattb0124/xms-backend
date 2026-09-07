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
 * The roster (P2.12.1 cut, CAP-01): import from the sign-in directory is
 * idempotent, a person record round-trips with its calendar, skills and
 * certifications, the list filters by role, group and skill, every write
 * is an operator audit event, and the permissions hold: capacity:view to
 * read, admin:users to create and edit, capacity:manage for calendar,
 * skills and certifications, nothing for the portal. No rate field exists.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let dispatcherToken: string;
let consultantToken: string;
let accountId: string;
let groupId = '';
let personId = '';
let personVersion = 1;

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
  const roles = await api().get('/v1/admin/roles?catalog=operator').set(bearer(adminToken)).expect(200);
  const roleId = (name: string): string => roles.body.find((row: { name: string }) => row.name === name).id;
  const group = await api()
    .post('/v1/admin/groups')
    .set(bearer(adminToken))
    .send({ name: 'OneStream Technical' })
    .expect(201);
  groupId = group.body.id;
  for (const [email, first, role] of [
    ['dev.patel@example.test', 'Dev', 'Dispatcher'],
    ['ana.costa@example.test', 'Ana', 'Consultant'],
    ['ben.okafor@example.test', 'Ben', 'Consultant'],
  ]) {
    await api()
      .post('/v1/admin/users')
      .set(bearer(adminToken))
      .send({ email, first_name: first, last_name: role, role_ids: [roleId(role)], account_ids: [accountId] })
      .expect(201);
  }
  dispatcherToken = await devToken({ sub: 'dev_dispatcher', email: 'dev.patel@example.test' });
  consultantToken = await devToken({ sub: 'dev_consultant', email: 'ana.costa@example.test' });
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

function api() {
  return request(app.getHttpServer());
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('import from the directory', () => {
  it('creates a person per active internal user with the role from the directory, and adds nothing twice', async () => {
    // Invited users become active on their first sign-in; the dev token did that for two of them.
    await api().get('/v1/admin/me').set(bearer(dispatcherToken)).expect(200);
    await api().get('/v1/admin/me').set(bearer(consultantToken)).expect(200);
    const first = await api().post('/v1/roster/import').set(bearer(adminToken)).expect(201);
    expect(first.body.created).toBe(3);
    expect(first.body.people.map((row: { email: string; role: string }) => `${row.email}:${row.role}`).sort()).toEqual([
      'admin@example.test:administrator',
      'ana.costa@example.test:consultant',
      'dev.patel@example.test:dispatcher',
    ]);
    const second = await api().post('/v1/roster/import').set(bearer(adminToken)).expect(201);
    expect(second.body.created).toBe(0);
    const audit = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from op.audit_events where event_type = 'roster.person.imported'`),
    );
    expect(audit.rows[0].n).toBe(3);
  });

  it('lists people for capacity:view holders only, with a default calendar and no rate field', async () => {
    const list = await api().get('/v1/roster/people').set(bearer(dispatcherToken)).expect(200);
    expect(list.body).toHaveLength(3);
    expect(Object.keys(list.body[0])).not.toEqual(expect.arrayContaining(['cost_rate', 'bill_rate']));
    await api().get('/v1/roster/people').set(bearer(consultantToken)).expect(403);
    const dev = list.body.find((row: { email: string }) => row.email === 'dev.patel@example.test');
    const record = await api().get(`/v1/roster/people/${dev.id}`).set(bearer(dispatcherToken)).expect(200);
    expect(record.body.calendar).toMatchObject({ working_days: [1, 2, 3, 4, 5], hours_per_day: '8.00' });
    expect(record.body.skills).toEqual([]);
  });
});

describe('a person record', () => {
  it('is created by hand by an administrator and refuses a duplicate email', async () => {
    const created = await api()
      .post('/v1/roster/people')
      .set(bearer(adminToken))
      .send({
        display_name: 'Chloe Martin',
        email: 'Chloe.Martin@example.test',
        role: 'consultant',
        fte_percent: 80,
        time_zone: 'Europe/London',
        country: 'GB',
        assignment_group_ids: [groupId],
      })
      .expect(201);
    personId = created.body.id;
    personVersion = created.body.version;
    expect(created.body).toMatchObject({
      email: 'chloe.martin@example.test',
      fte_percent: '80.00',
      is_active: true,
      user_id: null,
    });
    const duplicate = await api()
      .post('/v1/roster/people')
      .set(bearer(adminToken))
      .send({ display_name: 'Again', email: 'chloe.martin@example.test', role: 'consultant' })
      .expect(400);
    expect(duplicate.body.code).toBe('person_exists');
    await api()
      .post('/v1/roster/people')
      .set(bearer(dispatcherToken))
      .send({ display_name: 'X', email: 'x@example.test', role: 'consultant' })
      .expect(403);
  });

  it('round-trips a patch with the version and audits each field', async () => {
    const patched = await api()
      .patch(`/v1/roster/people/${personId}`)
      .set(bearer(adminToken))
      .send({ version: personVersion, fte_percent: 60, hours_base_per_week: 37.5, start_date: '2026-10-01' })
      .expect(200);
    expect(patched.body).toMatchObject({
      fte_percent: '60.00',
      hours_base_per_week: '37.50',
      start_date: '2026-10-01',
      version: personVersion + 1,
    });
    personVersion = patched.body.version;
    const stale = await api()
      .patch(`/v1/roster/people/${personId}`)
      .set(bearer(adminToken))
      .send({ version: 1, fte_percent: 50 })
      .expect(409);
    expect(stale.body.code).toBe('stale_version');
    const audit = await withSuperuser((client) =>
      client.query(
        `select field from op.audit_events where entity_id = $1 and event_type = 'roster.person.updated' order by field`,
        [personId],
      ),
    );
    expect(audit.rows.map((row) => row.field)).toEqual(['fte_percent', 'hours_base_per_week', 'start_date']);
  });

  it('sets the working calendar with derived hours per day and refuses a backwards day', async () => {
    const calendar = await api()
      .put(`/v1/roster/people/${personId}/calendar`)
      .set(bearer(adminToken))
      .send({ working_days: [1, 2, 3, 4], day_start: '08:00', day_end: '18:00' })
      .expect(200);
    expect(calendar.body).toMatchObject({ working_days: [1, 2, 3, 4], hours_per_day: '10.00' });
    await api()
      .put(`/v1/roster/people/${personId}/calendar`)
      .set(bearer(adminToken))
      .send({ working_days: [1], day_start: '18:00', day_end: '08:00' })
      .expect(400);
    await api()
      .put(`/v1/roster/people/${personId}/calendar`)
      .set(bearer(dispatcherToken))
      .send({ working_days: [1], day_start: '08:00', day_end: '18:00' })
      .expect(403);
  });

  it('manages the skills catalog and a person’s levels, and the list filters by skill, role and group', async () => {
    const onestream = await api()
      .post('/v1/roster/skills')
      .set(bearer(adminToken))
      .send({ kind: 'technology', code: 'onestream', name: 'OneStream' })
      .expect(201);
    await api()
      .post('/v1/roster/skills')
      .set(bearer(adminToken))
      .send({ kind: 'process', code: 'close', name: 'Financial close' })
      .expect(201);
    await api()
      .post('/v1/roster/skills')
      .set(bearer(adminToken))
      .send({ kind: 'process', code: 'close', name: 'Dup' })
      .expect(400);
    const skills = await api()
      .put(`/v1/roster/people/${personId}/skills`)
      .set(bearer(adminToken))
      .send({
        skills: [
          { skill_id: onestream.body.id, level: 4 },
          { code: 'close', level: 2 },
        ],
      })
      .expect(200);
    expect(skills.body.map((row: { code: string; level: number }) => `${row.code}:${row.level}`)).toEqual([
      'close:2',
      'onestream:4',
    ]);
    await api()
      .put(`/v1/roster/people/${personId}/skills`)
      .set(bearer(adminToken))
      .send({ skills: [{ code: 'nope', level: 1 }] })
      .expect(404);
    const bySkill = await api().get('/v1/roster/people?skill=onestream').set(bearer(dispatcherToken)).expect(200);
    expect(bySkill.body.map((row: { id: string }) => row.id)).toEqual([personId]);
    expect(bySkill.body[0].skills).toHaveLength(2);
    const byGroup = await api().get(`/v1/roster/people?group=${groupId}`).set(bearer(dispatcherToken)).expect(200);
    expect(byGroup.body.map((row: { id: string }) => row.id)).toEqual([personId]);
    const byRole = await api().get('/v1/roster/people?role=dispatcher').set(bearer(dispatcherToken)).expect(200);
    expect(byRole.body.map((row: { email: string }) => row.email)).toEqual(['dev.patel@example.test']);
    const catalog = await api().get('/v1/roster/skills').set(bearer(dispatcherToken)).expect(200);
    expect(catalog.body.map((row: { code: string }) => row.code)).toEqual(['close', 'onestream']);
  });

  it('adds and removes certifications with audit, and refuses an expiry before the award', async () => {
    const added = await api()
      .post(`/v1/roster/people/${personId}/certifications`)
      .set(bearer(adminToken))
      .send({
        name: 'OneStream Certified Professional',
        issuer: 'OneStream',
        obtained_on: '2025-03-01',
        expires_on: '2027-03-01',
      })
      .expect(201);
    await api()
      .post(`/v1/roster/people/${personId}/certifications`)
      .set(bearer(adminToken))
      .send({ name: 'Bad', obtained_on: '2025-03-01', expires_on: '2024-01-01' })
      .expect(400);
    const list = await api()
      .get(`/v1/roster/people/${personId}/certifications`)
      .set(bearer(dispatcherToken))
      .expect(200);
    expect(list.body).toHaveLength(1);
    await api()
      .delete(`/v1/roster/people/${personId}/certifications/${added.body.id}`)
      .set(bearer(adminToken))
      .expect(204);
    await api()
      .delete(`/v1/roster/people/${personId}/certifications/${added.body.id}`)
      .set(bearer(adminToken))
      .expect(404);
    const audit = await withSuperuser((client) =>
      client.query(
        `select event_type from op.audit_events where entity_id = $1 and event_type like 'roster.certification.%' order by created_at`,
        [personId],
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'roster.certification.added',
      'roster.certification.removed',
    ]);
  });

  it('deactivates a person and hides them from the default list', async () => {
    await api()
      .patch(`/v1/roster/people/${personId}`)
      .set(bearer(adminToken))
      .send({ version: personVersion, is_active: false })
      .expect(200);
    const active = await api().get('/v1/roster/people').set(bearer(dispatcherToken)).expect(200);
    expect(active.body.map((row: { id: string }) => row.id)).not.toContain(personId);
    const all = await api().get('/v1/roster/people?active=all').set(bearer(dispatcherToken)).expect(200);
    expect(all.body.map((row: { id: string }) => row.id)).toContain(personId);
  });
});
