import { describe, expect, it } from 'vitest';
import { HealthService } from './health.service.js';

describe('HealthService.readiness', () => {
  it('reports skipped for dependencies with no probe and ok overall', async () => {
    const service = new HealthService();
    const result = await service.readiness();
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ database: 'skipped', s3: 'skipped', sqs: 'skipped' });
  });

  it('reports degraded when any registered probe throws', async () => {
    const service = new HealthService();
    service.register('database', async () => undefined);
    service.register('sqs', async () => {
      throw new Error('queue unreachable');
    });
    const result = await service.readiness();
    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('ok');
    expect(result.checks.sqs).toBe('failed');
    expect(result.checks.s3).toBe('skipped');
  });
});
