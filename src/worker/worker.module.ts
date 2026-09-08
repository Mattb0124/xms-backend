import { Module, type OnModuleInit } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CommonModule } from '../common/common.module.js';
import { StorageCoreModule } from '../common/storage/storage.module.js';
import { AiCoreModule } from '../modules/ai/ai.module.js';
import { SuggestionService } from '../modules/ai/suggestion.service.js';
import { EmailCoreModule } from '../modules/email/email.module.js';
import { ArchiveService, DigestService, IntegrityCoreModule } from '../modules/integrity/integrity.module.js';
import { CalendarsCoreModule } from '../modules/calendars/calendars.module.js';
import { ConnectorsCoreModule } from '../modules/connectors/connectors.module.js';
import { SyncWorker } from '../modules/connectors/sync.worker.js';
import { EmailService } from '../modules/email/email.service.js';
import { ReportingCoreModule, SnapshotJob } from '../modules/reporting/reporting.module.js';
import { ReportSchedulesCoreModule, SchedulesService } from '../modules/reporting/schedules.module.js';
import { CsatCoreModule, CsatService } from '../modules/portal/csat.module.js';
import { WebhooksCoreModule, WebhookDeliveryService } from '../modules/integrations/webhooks.module.js';
import { FinanceCoreModule, FinanceService } from '../modules/integrations/finance.module.js';
import { DbModule } from '../db/db.module.js';
import { DbPools } from '../db/pool.js';
import { HealthModule } from '../health/health.module.js';
import { TicketsCoreModule } from '../modules/tickets/tickets.module.js';
import { EngagementsCoreModule } from '../modules/contracts/engagements.module.js';
import { JobRunner } from './jobs.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { SlaJobs } from './sla-jobs.js';
import { PeriodJobs } from './period-jobs.js';
import { RenewalJobs } from './renewal-jobs.js';
import { RosterJobs } from './roster-jobs.js';

/**
 * Worker root module (ADR-08): the same feature providers as the API, no
 * controllers, no guard needed because nothing but the health endpoints is
 * exposed. Jobs: outbox dispatcher (every second), SLA breach sweeper and
 * at-risk notifier (every five minutes, leased). Notifications delivery,
 * attachments scan, email and snapshots land with their modules.
 */
@Module({
  imports: [
    DiscoveryModule,
    DbModule,
    CommonModule,
    StorageCoreModule,
    HealthModule,
    TicketsCoreModule,
    EmailCoreModule,
    ReportingCoreModule,
    ReportSchedulesCoreModule,
    CsatCoreModule,
    WebhooksCoreModule,
    FinanceCoreModule,
    AiCoreModule,
    IntegrityCoreModule,
    ConnectorsCoreModule,
    CalendarsCoreModule,
    EngagementsCoreModule,
  ],
  providers: [
    {
      provide: OutboxDispatcher,
      useFactory: (pools: DbPools): OutboxDispatcher => new OutboxDispatcher(pools),
      inject: [DbPools],
    },
    JobRunner,
    SlaJobs,
    PeriodJobs,
    RenewalJobs,
    RosterJobs,
  ],
})
export class WorkerModule implements OnModuleInit {
  constructor(
    private readonly runner: JobRunner,
    private readonly sla: SlaJobs,
    private readonly pools: DbPools,
    private readonly dispatcher: OutboxDispatcher,
    private readonly email: EmailService,
    private readonly snapshots: SnapshotJob,
    private readonly suggestions: SuggestionService,
    private readonly digests: DigestService,
    private readonly sync: SyncWorker,
    private readonly periods: PeriodJobs,
    private readonly renewals: RenewalJobs,
    private readonly roster: RosterJobs,
    private readonly archive: ArchiveService,
    private readonly schedules: SchedulesService,
    private readonly csat: CsatService,
    private readonly webhooks: WebhookDeliveryService,
    private readonly finance: FinanceService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.subscribe(
      'email.outbound',
      (type) => ['comment.created', 'ticket.created', 'ticket.transitioned'].includes(type),
      (row) => this.email.handleOutbox(row),
    );
    this.dispatcher.subscribe(
      'portal.csat',
      (type) => type === 'ticket.transitioned',
      (row) => this.csat.onOutbox(row),
    );
    this.dispatcher.subscribe(
      'connector.webhook',
      (type) => this.webhooks.handles(type),
      (row) => this.webhooks.onOutbox(row),
    );
    this.dispatcher.subscribe(
      'connector.finance',
      (type) => type === 'billing_period.locked',
      (row) => this.finance.onOutbox(row),
    );
    this.dispatcher.subscribe(
      'axel.intake',
      (type) => type === 'ticket.created',
      (row) => this.suggestions.intake(row.account_id, row.aggregate_id).then(() => undefined),
    );
    if (!this.pools.has('worker')) return;
    this.runner.schedule(this.sla.sweeper());
    this.runner.schedule(this.sla.atRisk());
    this.runner.schedule(this.snapshots.job());
    this.runner.schedule(this.suggestions.expiryJob());
    this.runner.schedule(this.digests.digestJob());
    this.runner.schedule(this.digests.verifyJob());
    this.runner.schedule(this.sync.pollJob());
    this.runner.schedule(this.sync.applyJob());
    this.runner.schedule(this.sync.healthJob());
    this.runner.schedule(this.periods.autoLock());
    this.runner.schedule(this.renewals.renewalAlerts());
    this.runner.schedule(this.roster.certificationExpiry());
    this.runner.schedule(this.archive.archiveJob());
    this.runner.schedule(this.schedules.scheduleJob());
    this.runner.schedule(this.csat.reminderJob());
    this.runner.schedule(this.webhooks.retryJob());
  }
}
