import { Module } from '@nestjs/common';
import { AuthModule } from '../common/auth/auth.module.js';
import { CommonModule } from '../common/common.module.js';
import { DbModule } from '../db/db.module.js';
import { HealthModule } from '../health/health.module.js';
import { AiCoreModule } from '../modules/ai/ai.module.js';
import { KnowledgeCoreModule } from '../modules/knowledge/knowledge.module.js';
import { ReportingCoreModule } from '../modules/reporting/reporting.module.js';
import { TicketsCoreModule } from '../modules/tickets/tickets.module.js';
import { TimeCoreModule } from '../modules/time/time.module.js';
import { ToolGate } from './gate.js';
import { McpController, ToolRegistry } from './mcp.controller.js';

/**
 * MCP root module (ADR-19), the third entrypoint beside the API and the
 * worker.
 *
 * It imports the same `*CoreModule` providers the worker imports, so a tool
 * answers from the domain code a route answers from, and reaches PostgreSQL
 * through the same pool-per-role and session binding. Tenancy is therefore
 * the same data-layer property here as everywhere else: there is no second
 * query path and nothing in `src/mcp` writes SQL.
 *
 * `AuthModule` is imported rather than the guard being re-registered here: it
 * already binds `APP_GUARD`, and it carries the boot check that refuses to
 * start when a route declares no permission. Importing it therefore gets this
 * entrypoint the same guard AND the same boot-time guarantee the API has,
 * which re-registering the guard by hand would have quietly skipped.
 */
@Module({
  imports: [
    DbModule,
    CommonModule,
    AuthModule,
    HealthModule,
    TicketsCoreModule,
    KnowledgeCoreModule,
    TimeCoreModule,
    AiCoreModule,
    ReportingCoreModule,
  ],
  controllers: [McpController],
  providers: [ToolRegistry, ToolGate],
})
export class McpModule {}
