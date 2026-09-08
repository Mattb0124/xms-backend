import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  Authenticated,
  CurrentPrincipal,
  RealmOf,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { DbPools } from '../../db/pool.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { computeMeasures } from '../../domain/reporting/measures.js';
import { ConfigService } from '../admin/config/config.service.js';
import type { ConditionSet } from '../tickets/conditions.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import type { Job } from '../../worker/jobs.js';
import type { EventQuery } from './audit-search.js';
import { ReportingRepository } from './reporting.repository.js';
import { packFormat, ReportingService } from './reporting.service.js';
import { CreateSavedQueryDto, RunSavedQueryDto, UpdateSavedQueryDto } from './saved-queries.dto.js';
import { SavedQueriesRepository } from './saved-queries.repository.js';
import { SavedQueriesService } from './saved-queries.service.js';
import { IntegrityCoreModule } from '../integrity/integrity.module.js';

function decodeJson<T>(encoded: string | undefined, code: string): T | undefined {
  if (!encoded) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
  } catch {
    throw new BadRequestException({ code });
  }
}

@ApiTags('reporting')
@ApiBearerAuth()
@Controller()
export class ReportingController {
  constructor(
    private readonly reporting: ReportingService,
    private readonly savedQueries: SavedQueriesService,
  ) {}

  @Get('dashboards/operations')
  @RequirePermission('reports:view-portfolio')
  operations(@CurrentPrincipal() principal: Principal, @Query('days') days?: string) {
    return this.reporting.operations(principal, clampDays(days, 7));
  }

  @Get('dashboards/accounts/:id')
  @RequirePermission('tickets:view')
  account(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('days') days?: string,
    @Query('as_client') asClient?: string,
  ) {
    return this.reporting.account(principal, id, clampDays(days, 7), asClient === 'true');
  }

  @Get('dashboards/security')
  @RequirePermission('audit:read')
  security(@CurrentPrincipal() principal: Principal, @Query('days') days?: string) {
    return this.reporting.securityDashboard(principal, clampDays(days, 7));
  }

  /** The integrity panel of the Security screen: the chain, the archive, the streams and the retention policy. */
  @Get('dashboards/security/integrity')
  @RequirePermission('audit:read')
  integrity(@CurrentPrincipal() principal: Principal) {
    return this.reporting.integrityPanel(principal);
  }

  @Get('dashboards/usage')
  @RequirePermission('analytics:read')
  usage(@CurrentPrincipal() principal: Principal, @Query('days') days?: string) {
    return this.reporting.usageDashboard(principal, clampDays(days, 7));
  }

  @Get('exports/tickets')
  @RequirePermission('tickets:view')
  async exportTickets(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Res() response: Response,
    @Query('format') format?: string,
    @Query('conditions') conditions?: string,
    @Query('account_id') accountId?: string,
  ) {
    const result = await this.reporting.exportTickets(principal, ctx, format === 'csv' ? 'csv' : 'xlsx', {
      conditions: decodeJson<ConditionSet>(conditions, 'bad_conditions'),
      accountIds: accountId ? accountId.split(',') : undefined,
    });
    response.setHeader('content-type', result.contentType);
    response.setHeader('content-disposition', `attachment; filename="${result.fileName}"`);
    response.setHeader('x-row-count', String(result.rows));
    response.send(result.body);
  }

  @Post('audit/search')
  @RequirePermission('audit:read')
  search(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() body: EventQuery) {
    return this.reporting.searchEvents(principal, ctx, body ?? { conditions: [] });
  }

  @Post('audit/export')
  @RequirePermission('audit:export')
  @Header('content-type', 'text/csv; charset=utf-8')
  async exportEvents(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Res() response: Response,
    @Body() body: EventQuery,
  ) {
    const result = await this.reporting.exportEvents(principal, ctx, body ?? { conditions: [] });
    response.setHeader('content-disposition', `attachment; filename="${result.fileName}"`);
    response.send(result.body);
  }

  /**
   * Saved queries (Audit & Analytics 7.1). Every route stands on
   * `audit:read`, the permission the search itself takes; sharing a query
   * additionally needs `audit:export`, which the service checks because it
   * is a property of the body rather than of the route.
   */
  @Get('audit/saved-queries')
  @RequirePermission('audit:read')
  listSavedQueries(@CurrentPrincipal() principal: Principal) {
    return this.savedQueries.list(principal);
  }

  @Post('audit/saved-queries')
  @RequirePermission('audit:read')
  createSavedQuery(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: CreateSavedQueryDto,
  ) {
    return this.savedQueries.create(principal, ctx, dto);
  }

  @Get('audit/saved-queries/:id')
  @RequirePermission('audit:read')
  savedQuery(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.savedQueries.get(principal, id);
  }

  @Patch('audit/saved-queries/:id')
  @RequirePermission('audit:read')
  updateSavedQuery(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSavedQueryDto,
  ) {
    return this.savedQueries.update(principal, ctx, id, dto);
  }

  @Delete('audit/saved-queries/:id')
  @RequirePermission('audit:read')
  deleteSavedQuery(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.savedQueries.remove(principal, ctx, id);
  }

  /** Running one is the inline search with the stored conditions. */
  @Post('audit/saved-queries/:id/run')
  @RequirePermission('audit:read')
  runSavedQuery(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RunSavedQueryDto,
  ) {
    return this.savedQueries.run(principal, ctx, id, dto ?? {});
  }

  @Get('accounts/:id/reports')
  @RequirePermission('tickets:view')
  runs(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.reporting.runs(principal, id);
  }

  @Post('accounts/:id/reports/wsr')
  @RequirePermission('reports:view-portfolio')
  generate(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reporting.generateWsr(principal, ctx, id);
  }

  /** `?format=pdf` mints the document rendition; anything else mints the deck. */
  @Get('reports/packs/:id')
  @RequirePermission('tickets:view')
  pack(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('format') format?: string,
  ) {
    return this.reporting.pack(principal, ctx, id, packFormat(format));
  }
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal/dashboard')
@RealmOf('portal')
export class PortalDashboardController {
  constructor(private readonly reporting: ReportingService) {}

  @Get()
  @Authenticated()
  dashboard(@CurrentPrincipal() principal: Principal, @Query('days') days?: string) {
    return this.reporting.portalDashboard(principal, clampDays(days, 30));
  }
}

function clampDays(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 365);
}

/** Nightly snapshot job (technical 2.8, cut): one row per measure per account per day, idempotent. */
@Injectable()
export class SnapshotJob {
  constructor(
    private readonly pools: DbPools,
    private readonly uow: UnitOfWork,
    private readonly reporting: ReportingRepository,
    private readonly config: ConfigService,
  ) {}

  job(intervalMs = 15 * 60_000): Job {
    return { name: 'reporting.snapshot', intervalMs, run: () => this.run() };
  }

  async run(reference = new Date()): Promise<string> {
    const accounts = (
      await this.pools
        .get('worker')
        .query<{ id: string }>(`select id from op.accounts where status in ('active', 'onboarding')`)
    ).rows.map((row) => row.id);
    const date = new Date(reference.getTime() - 86_400_000).toISOString().slice(0, 10);
    let written = 0;
    for (const accountId of accounts) {
      await this.uow.worker([accountId], async (tx) => {
        const last = await this.reporting.lastSnapshotDate(tx, accountId);
        if (last && last >= date) return;
        const dayStart = new Date(`${date}T00:00:00Z`);
        const dayEnd = new Date(dayStart.getTime() + 86_400_000);
        const facts = await this.reporting.ticketFacts(tx, [accountId], dayStart);
        const classes = await this.config.resolve<{ items: { key: string; consumes_contract?: boolean }[] }>(
          tx,
          'billable_classes',
          '*',
          accountId,
        );
        const consuming = new Set(classes.body.items.filter((item) => item.consumes_contract).map((item) => item.key));
        const time = await this.reporting.timeFacts(tx, [accountId], date, date, consuming);
        const measures = computeMeasures(facts, time, { start: dayStart, end: dayEnd }, dayEnd);
        const scalar: [string, number | null, number | null, number | null][] = [
          ['open_tickets', measures.open_tickets, null, null],
          ['breached_now', measures.breached_now, null, null],
          ['at_risk_now', measures.at_risk_now, null, null],
          ['unassigned_now', measures.unassigned_now, null, null],
          ['volume_created', measures.volume_created, null, null],
          ['volume_resolved', measures.volume_resolved, null, null],
          [
            'sla_response_attainment',
            measures.sla_response_attainment.value ?? 0,
            measures.sla_response_attainment.numerator,
            measures.sla_response_attainment.denominator,
          ],
          [
            'sla_resolution_attainment',
            measures.sla_resolution_attainment.value ?? 0,
            measures.sla_resolution_attainment.numerator,
            measures.sla_resolution_attainment.denominator,
          ],
          ['mttr_minutes', measures.mttr_minutes ?? 0, null, null],
          [
            'reopen_rate',
            measures.reopen_rate.value ?? 0,
            measures.reopen_rate.numerator,
            measures.reopen_rate.denominator,
          ],
          ['consumption_minutes', measures.consumption_minutes, null, null],
          ['time_logged_minutes', measures.time_logged_minutes, null, null],
        ];
        for (const [measure, value, numerator, denominator] of scalar) {
          await this.reporting.insertSnapshot(
            tx,
            accountId,
            date,
            measure,
            {},
            value ?? 0,
            numerator,
            denominator,
            'scheduled',
          );
          written += 1;
        }
        for (const [bucket, count] of Object.entries(measures.backlog_by_age)) {
          await this.reporting.insertSnapshot(
            tx,
            accountId,
            date,
            'backlog_by_age',
            { bucket },
            count,
            null,
            null,
            'scheduled',
          );
          written += 1;
        }
        for (const [priority, count] of Object.entries(measures.open_by_priority)) {
          await this.reporting.insertSnapshot(
            tx,
            accountId,
            date,
            'open_tickets',
            { priority },
            count,
            null,
            null,
            'scheduled',
          );
          written += 1;
        }
      });
    }
    return `snapshots ${written}`;
  }
}

@Module({
  // The integrity module owns the digest chain and the archive, which the
  // Security screen reads beside the event streams.
  imports: [TicketsCoreModule, IntegrityCoreModule],
  providers: [ReportingRepository, ReportingService, SnapshotJob, SavedQueriesRepository, SavedQueriesService],
  exports: [ReportingService, ReportingRepository, SnapshotJob, SavedQueriesService],
})
export class ReportingCoreModule {}

@Module({
  imports: [ReportingCoreModule],
  controllers: [ReportingController, PortalDashboardController],
  exports: [ReportingCoreModule],
})
export class ReportingModule {}
