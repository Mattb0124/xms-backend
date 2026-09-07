import { Module } from '@nestjs/common';
import { AuthModule } from './common/auth/auth.module.js';
import { CommonModule } from './common/common.module.js';
import { RateLimitModule } from './common/rate-limit/rate-limit.middleware.js';
import { ConnectorsModule } from './modules/connectors/connectors.module.js';
import { RosterModule } from './modules/roster/roster.module.js';
import { CspModule } from './modules/security/csp.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { ContractsModule } from './modules/contracts/contracts.module.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { EmailModule } from './modules/email/email.module.js';
import { IntegrityModule } from './modules/integrity/integrity.module.js';
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { PortalModule } from './modules/portal/portal.module.js';
import { ReportingModule } from './modules/reporting/reporting.module.js';
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
    RateLimitModule,
    StorageModule,
    AuthModule,
    HealthModule,
    TelemetryModule,
    AdminModule,
    ContractsModule,
    TicketsModule,
    PortalModule,
    TimeModule,
    KnowledgeModule,
    AttachmentsModule,
    EmailModule,
    ReportingModule,
    AiModule,
    IntegrityModule,
    CspModule,
    ConnectorsModule,
    RosterModule,
  ],
})
export class AppModule {}
