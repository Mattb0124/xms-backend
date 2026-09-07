import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth/public.decorator.js';
import { HealthService } from './health.service.js';

/**
 * Liveness and readiness (Platform & Operations section 5). Readiness pings
 * the real dependencies once they exist (PostgreSQL, S3, SQS); the AIX
 * static "OK" health check is deliberately not repeated.
 */
@ApiTags('Health')
@Controller({ path: '', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('readyz')
  readiness(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, 'ok' | 'skipped' | 'failed'> }> {
    return this.health.readiness();
  }
}
