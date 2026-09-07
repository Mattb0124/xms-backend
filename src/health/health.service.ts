import { Injectable } from '@nestjs/common';

export type CheckResult = 'ok' | 'skipped' | 'failed';

/**
 * Readiness checks. Each dependency registers a probe when its module lands
 * (P1.3.2 database, P1.2.2 S3 and SQS); until then it reports `skipped` so
 * the endpoint is honest about what it did not verify.
 */
@Injectable()
export class HealthService {
  private readonly probes = new Map<string, () => Promise<void>>();

  register(name: string, probe: () => Promise<void>): void {
    this.probes.set(name, probe);
  }

  async readiness(): Promise<{
    status: 'ok' | 'degraded';
    checks: Record<string, CheckResult>;
  }> {
    const checks: Record<string, CheckResult> = {
      database: 'skipped',
      s3: 'skipped',
      sqs: 'skipped',
    };
    await Promise.all(
      [...this.probes.entries()].map(async ([name, probe]) => {
        try {
          await probe();
          checks[name] = 'ok';
        } catch {
          checks[name] = 'failed';
        }
      }),
    );
    const status = Object.values(checks).includes('failed') ? 'degraded' : 'ok';
    return { status, checks };
  }
}
