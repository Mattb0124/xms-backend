import { Module } from '@nestjs/common';
import { AuthModule } from './common/auth/auth.module.js';
import { CommonModule } from './common/common.module.js';
import { RateLimitModule } from './common/rate-limit/rate-limit.middleware.js';
import { ConnectorsModule } from './modules/connectors/connectors.module.js';
import { CalendarsModule } from './modules/calendars/calendars.module.js';
import { MigrationModule } from './modules/migration/migration.module.js';
import { RosterModule } from './modules/roster/roster.module.js';
import { CapacityModule } from './modules/capacity/capacity.module.js';
import { ReportSchedulesModule } from './modules/reporting/schedules.module.js';
import { ContactsModule } from './modules/portal/contacts.module.js';
import { CsatModule } from './modules/portal/csat.module.js';
import { FormsModule } from './modules/portal/forms.module.js';
import { WebhooksModule } from './modules/integrations/webhooks.module.js';
import { CalendarFeedModule } from './modules/integrations/calendar-feed.module.js';
import { FinanceModule } from './modules/integrations/finance.module.js';
import { CspModule } from './modules/security/csp.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { ContractsModule } from './modules/contracts/contracts.module.js';
import { EngagementsModule } from './modules/contracts/engagements.module.js';
import { ListPreferencesModule } from './modules/me/list-preferences.module.js';
import { WaitingModule } from './modules/me/waiting.module.js';
import { AttachmentsModule } from './modules/attachments/attachments.module.js';
import { EmailModule } from './modules/email/email.module.js';
import { IntegrityModule } from './modules/integrity/integrity.module.js';
import { ConfigurationItemsModule } from './modules/knowledge/configuration-items.module.js';
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { PortalModule } from './modules/portal/portal.module.js';
import { ReportingModule } from './modules/reporting/reporting.module.js';
import { TelemetryModule } from './modules/telemetry/telemetry.module.js';
import { TimeModule } from './modules/time/time.module.js';
import { TicketsModule } from './modules/tickets/tickets.module.js';
import { RoutingModule } from './modules/tickets/routing.module.js';
import { ChangeWindowsModule } from './modules/tickets/change-windows.module.js';

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
    EngagementsModule,
    ListPreferencesModule,
    WaitingModule,
    TicketsModule,
    RoutingModule,
    ChangeWindowsModule,
    PortalModule,
    FormsModule,
    TimeModule,
    KnowledgeModule,
    ConfigurationItemsModule,
    AttachmentsModule,
    EmailModule,
    ReportingModule,
    AiModule,
    IntegrityModule,
    CspModule,
    ConnectorsModule,
    RosterModule,
    CapacityModule,
    ReportSchedulesModule,
    ContactsModule,
    CsatModule,
    WebhooksModule,
    FinanceModule,
    CalendarFeedModule,
    CalendarsModule,
    MigrationModule,
  ],
})
export class AppModule {}
