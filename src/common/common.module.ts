import { Global, Module } from '@nestjs/common';
import { UnitOfWork } from '../db/unit-of-work.js';
import { AuditService } from './audit/audit.service.js';

/** Cross-cutting services every feature module uses: the unit of work and the audit writer. */
@Global()
@Module({
  providers: [UnitOfWork, AuditService],
  exports: [UnitOfWork, AuditService],
})
export class CommonModule {}
