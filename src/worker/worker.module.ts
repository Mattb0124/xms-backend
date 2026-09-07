import { Module, type OnModuleInit } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CommonModule } from '../common/common.module.js';
import { StorageCoreModule } from '../common/storage/storage.module.js';
import { AiCoreModule } from '../modules/ai/ai.module.js';
import { SuggestionService } from '../modules/ai/suggestion.service.js';
import { EmailCoreModule } from '../modules/email/email.module.js';
import { EmailService } from '../modules/email/email.service.js';
import { ReportingCoreModule, SnapshotJob } from '../modules/reporting/reporting.module.js';
import { DbModule } from '../db/db.module.js';
import { DbPools } from '../db/pool.js';
import { HealthModule } from '../health/health.module.js';
import { TicketsCoreModule } from '../modules/tickets/tickets.module.js';
import { JobRunner } from './jobs.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import { SlaJobs } from './sla-jobs.js';

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
    AiCoreModule,
  ],
  providers: [
    {
      provide: OutboxDispatcher,
      useFactory: (pools: DbPools): OutboxDispatcher => new OutboxDispatcher(pools),
      inject: [DbPools],
    },
    JobRunner,
    SlaJobs,
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
  ) {}

  onModuleInit(): void {
    this.dispatcher.subscribe(
      'email.outbound',
      (type) => ['comment.created', 'ticket.created', 'ticket.transitioned'].includes(type),
      (row) => this.email.handleOutbox(row),
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
  }
}
