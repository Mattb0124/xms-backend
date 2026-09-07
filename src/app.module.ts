import { Module } from '@nestjs/common';
import { AuthModule } from './common/auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Root module of the API. Feature modules are added one per spec module
 * (02-modules/<module>/TECHNICAL-SPEC.md) with controller, service, data and
 * dto colocated; the worker imports the same feature modules from
 * worker/worker.module.ts so every business rule exists once.
 */
@Module({
  imports: [DbModule, AuthModule, HealthModule],
})
export class AppModule {}
