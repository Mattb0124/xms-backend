import {
  Global,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { HealthModule } from '../health/health.module.js';
import { HealthService } from '../health/health.service.js';
import { DbPools } from './pool.js';

/**
 * Provides the role pools to the whole application and registers the
 * database readiness probe. The pools are created from the environment
 * contract; a role without a URL is simply absent (the worker does not
 * need the portal pool, the API does not need the worker pool).
 */
export const DB_POOLS = Symbol('DB_POOLS');

@Global()
@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: DbPools,
      useFactory: (): DbPools => {
        const env = loadEnv();
        return new DbPools({
          app: env.DATABASE_URL_APP,
          portal: env.DATABASE_URL_PORTAL,
          worker: env.DATABASE_URL_WORKER,
        });
      },
    },
  ],
  exports: [DbPools],
})
export class DbModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly pools: DbPools,
    private readonly health: HealthService,
  ) {}

  onModuleInit(): void {
    const role = this.pools.has('app')
      ? 'app'
      : this.pools.has('worker')
        ? 'worker'
        : undefined;
    if (role) {
      this.health.register('database', () => this.pools.ping(role));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pools.end();
  }
}
