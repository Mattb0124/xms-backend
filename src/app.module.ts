import { Module } from '@nestjs/common';
import { AuthModule } from './common/auth/auth.module.js';
import { CommonModule } from './common/common.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { ContractsModule } from './modules/contracts/contracts.module.js';
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { PortalModule } from './modules/portal/portal.module.js';
import { TelemetryModule } from './modules/telemetry/telemetry.module.js';
import { TimeModule } from './modules/time/time.module.js';
import { TicketsModule } from './modules/tickets/tickets.module.js';

/**
 * Root module of the API. Feature modules are added one per spec module
 * (02-modules/<module>/TECHNICAL-SPEC.md) with controller, service, data and
 * dto colocated; the worker imports the same feature modules from
 * worker/worker.module.ts so every business rule exists once.
 */
@Module({
  imports: [
    DbModule,
    CommonModule,
    AuthModule,
    HealthModule,
    TelemetryModule,
    AdminModule,
    ContractsModule,
    TicketsModule,
    PortalModule,
    TimeModule,
    KnowledgeModule,
  ],
})
export class AppModule {}
