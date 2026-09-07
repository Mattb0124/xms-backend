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
import { closePools, resetDatabase, urls } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';

/**
 * Skills matrix over the real database (CAP-07): the people lens is a heat
 * map of levels; the account lens reads the technologies an account's
 * active contracts require, names who is at level three or above, flags a
 * single point of failure where exactly one person qualifies and a gap
 * where nobody does, and the flag clears when a second person is raised.
 */
const ADMIN_EMAIL = 'admin@example.test';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let contractId: string;
let contractVersion: number;
let anaId: string;
let benId: string;

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
  const contract = await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer', technology_codes: ['onestream', 'anaplan', 'sap'] })
    .expect(201);
  contractId = contract.body.id;
  contractVersion = contract.body.version;
  expect(contract.body.technology_codes).toEqual(['onestream', 'anaplan', 'sap']);

  for (const skill of [
    { kind: 'technology', code: 'onestream', name: 'OneStream' },
    { kind: 'technology', code: 'anaplan', name: 'Anaplan' },
    { kind: 'process', code: 'close', name: 'Financial close' },
  ])
    await api().post('/v1/roster/skills').set(bearer(adminToken)).send(skill).expect(201);
  const ana = await api()
    .post('/v1/roster/people')
    .set(bearer(adminToken))
    .send({ display_name: 'Ana Costa', email: 'ana@example.test', role: 'architect' })
    .expect(201);
  anaId = ana.body.id;
  const ben = await api()
    .post('/v1/roster/people')
    .set(bearer(adminToken))
    .send({ display_name: 'Ben Park', email: 'ben@example.test', role: 'consultant' })
    .expect(201);
  benId = ben.body.id;
  await api()
    .put(`/v1/roster/people/${anaId}/skills`)
    .set(bearer(adminToken))
    .send({
      skills: [
        { code: 'onestream', level: 4 },
        { code: 'anaplan', level: 3 },
        { code: 'close', level: 2 },
      ],
    })
    .expect(200);
  await api()
    .put(`/v1/roster/people/${benId}/skills`)
    .set(bearer(adminToken))
    .send({
      skills: [
        { code: 'onestream', level: 2 },
        { code: 'anaplan', level: 3 },
      ],
    })
    .expect(200);
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('skills matrix (CAP-07)', () => {
  it('the people lens is a heat map of levels', async () => {
    const view = await api().get('/v1/capacity/skills-matrix?lens=people').set(bearer(adminToken)).expect(200);
    expect(view.body.skills.map((row: { code: string }) => row.code)).toEqual(['close', 'anaplan', 'onestream']);
    const ana = view.body.people.find((row: { id: string }) => row.id === anaId);
    expect(ana.levels).toEqual({ onestream: 4, anaplan: 3, close: 2 });
    const ben = view.body.people.find((row: { id: string }) => row.id === benId);
    expect(ben.levels).toEqual({ onestream: 2, anaplan: 3 });
    await api().get('/v1/capacity/skills-matrix?lens=teams').set(bearer(adminToken)).expect(400);
  });

  it('the account lens names the single point of failure and the gap, and the flag clears when a second person is raised', async () => {
    const view = await api()
      .get(`/v1/capacity/skills-matrix?lens=account&account=${accountId}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(view.body.required_level).toBe(3);
    expect(view.body.accounts).toHaveLength(1);
    const brk = view.body.accounts[0];
    expect(brk).toMatchObject({ key: 'BRK', single_points_of_failure: ['onestream'], gaps: ['sap'] });
    expect(brk.technologies.map((row: { code: string; status: string }) => `${row.code}:${row.status}`)).toEqual([
      'anaplan:ok',
      'onestream:spof',
      'sap:gap',
    ]);
    expect(brk.technologies[1].qualified).toEqual([{ person_id: anaId, display_name: 'Ana Costa' }]);
    await api()
      .put(`/v1/roster/people/${benId}/skills`)
      .set(bearer(adminToken))
      .send({
        skills: [
          { code: 'onestream', level: 3 },
          { code: 'anaplan', level: 3 },
        ],
      })
      .expect(200);
    const after = await api().get('/v1/capacity/skills-matrix?lens=account').set(bearer(adminToken)).expect(200);
    const again = after.body.accounts.find((row: { account_id: string }) => row.account_id === accountId);
    expect(again.single_points_of_failure).toEqual([]);
    expect(again.technologies.find((row: { code: string }) => row.code === 'onestream').qualified).toHaveLength(2);
  });

  it('the required technologies follow the contract and can be changed with the version', async () => {
    const patched = await api()
      .patch(`/v1/accounts/${accountId}/contracts/${contractId}`)
      .set(bearer(adminToken))
      .send({ version: contractVersion, technology_codes: ['onestream', 'onestream'] })
      .expect(200);
    expect(patched.body.technology_codes).toEqual(['onestream']);
    const bad = await api()
      .patch(`/v1/accounts/${accountId}/contracts/${contractId}`)
      .set(bearer(adminToken))
      .send({ version: patched.body.version, technology_codes: ['Bad Code'] })
      .expect(400);
    expect(bad.body.code).toBe('validation_failed');
    const view = await api()
      .get(`/v1/capacity/skills-matrix?lens=account&account=${accountId}`)
      .set(bearer(adminToken))
      .expect(200);
    expect(view.body.accounts[0].technologies.map((row: { code: string }) => row.code)).toEqual(['onestream']);
    expect(view.body.accounts[0].gaps).toEqual([]);
  });
});
