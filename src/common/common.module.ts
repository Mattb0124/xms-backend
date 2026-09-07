import { Global, Module } from '@nestjs/common';
import { UnitOfWork } from '../db/unit-of-work.js';
import { AuditService } from './audit/audit.service.js';
import { SecurityEventsService } from './events/security-events.service.js';

/** Cross-cutting services every feature module and the worker use: the unit of work, the audit writer, the security stream. */
@Global()
@Module({
  providers: [UnitOfWork, AuditService, SecurityEventsService],
  exports: [UnitOfWork, AuditService, SecurityEventsService],
})
export class CommonModule {}
