import { INestApplication, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';

describe('health (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /healthz answers ok without a version prefix', () => {
    return request(app.getHttpServer()).get('/healthz').expect(200).expect({ status: 'ok' });
  });

  it('GET /readyz reports every dependency honestly', async () => {
    const response = await request(app.getHttpServer()).get('/readyz').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.checks).toEqual({
      database: 'skipped',
      s3: 'skipped',
      sqs: 'skipped',
    });
  });
});
