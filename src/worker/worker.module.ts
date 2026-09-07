import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { HealthModule } from '../health/health.module.js';

/**
 * Worker root module. Handlers land per Implementation Plan item: outbox
 * dispatcher and inbox apply (P1.5.3), notifications (P1.5.4), attachments
 * scan consumer (P1.6.1), inbound and outbound email (P1.6.3, P1.6.4), the
 * SLA breach sweeper (P2.10.2), snapshots (P2.19.2), report packs (P2.20.1).
 */
@Module({
  imports: [DbModule, HealthModule],
})
export class WorkerModule {}
