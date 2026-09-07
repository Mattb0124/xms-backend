import {
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  Injectable,
  Logger,
  Module,
  NestInterceptor,
  Post,
  type OnModuleDestroy,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import {
  Authenticated,
  CurrentPrincipal,
  RealmOf,
  RequestCtx,
  type RequestContext,
} from '../../common/auth/decorators.js';
import { actorKindOf, type Principal } from '../../common/auth/principal.js';
import { isUsageEventType, type UsageEventType } from '../../contracts/events.js';
import { DbPools } from '../../db/pool.js';

/**
 * The usage stream (Audit & Analytics 4.2, 5.2, 5.3; P1.5.6). Two producers:
 * the API request interceptor (one `api.request` row per request, templated
 * route, never the raw path) and `POST /v1/telemetry` for the browser. Rows
 * are buffered in memory and flushed every second or at 500 rows; a full
 * buffer is counted in sys.telemetry_buffer_stats, never dropped silently.
 * The worker queue lands with the SQS plumbing; until then the buffer
 * writes straight to rpt.usage_events.
 */
export interface UsageEvent {
  readonly type: UsageEventType;
  readonly occurredAt?: Date;
  readonly accountId?: string | null;
  readonly actorKind: string;
  readonly actorId: string;
  readonly principalKind?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly entityKind?: string;
  readonly entityId?: string;
  readonly outcome?: 'success' | 'denied' | 'failed' | 'withheld';
  readonly attrs: Record<string, unknown>;
  readonly ipHash?: string;
  readonly userAgentFamily?: string;
}

const MAX_BUFFER = 5000;
const FLUSH_ROWS = 500;

@Injectable()
export class UsageEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(UsageEventsService.name);
  private buffer: UsageEvent[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly pools: DbPools) {
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
  }

  record(event: UsageEvent): void {
    if (this.buffer.length >= MAX_BUFFER) {
      this.dropped += 1;
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= FLUSH_ROWS) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0 && this.dropped === 0) return;
    const batch = this.buffer;
    const dropped = this.dropped;
    this.buffer = [];
    this.dropped = 0;
    if (!this.pools.has('app')) return;
    try {
      if (batch.length > 0) {
        const values: unknown[] = [];
        const rows = batch.map((event) => {
          const start = values.length;
          values.push(
            event.occurredAt ?? new Date(),
            event.type,
            event.accountId ?? null,
            event.actorKind,
            event.actorId,
            event.principalKind ?? null,
            event.sessionId ?? null,
            event.requestId ?? null,
            event.entityKind ?? null,
            event.entityId ?? null,
            event.outcome ?? 'success',
            JSON.stringify(event.attrs),
            event.ipHash ?? null,
            event.userAgentFamily ?? null,
          );
          return `(${Array.from({ length: 14 }, (_, index) => `$${start + index + 1}`).join(', ')})`;
        });
        // Bound to every account so account-scoped rows pass the policy;
        // the interceptor stamps only ids the principal already held.
        const accountIds = [
          ...new Set(batch.map((event) => event.accountId).filter((id): id is string => Boolean(id))),
        ];
        const client = await this.pools.get('app').connect();
        try {
          await client.query('begin');
          await client.query("select set_config('xms.account_ids', $1, true)", [`{${accountIds.join(',')}}`]);
          await client.query(
            `insert into rpt.usage_events (occurred_at, event_type, account_id, actor_kind, actor_id, principal_kind, session_id, request_id, entity_kind, entity_id, outcome, attrs, ip_hash, user_agent_family)
             values ${rows.join(', ')}`,
            values,
          );
          await client.query('commit');
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
      if (dropped > 0) {
        await this.pools
          .get('app')
          .query(`insert into sys.telemetry_buffer_stats (source, accepted, dropped) values ('api', $1, $2)`, [
            batch.length,
            dropped,
          ]);
        this.logger.warn(`usage buffer overflow: ${dropped} events dropped`);
      }
    } catch (error) {
      this.logger.error(`usage events not written: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

/** One api.request usage row per request, after the response. */
@Injectable()
export class ApiRequestInterceptor implements NestInterceptor {
  constructor(private readonly usage: UsageEventsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const started = Date.now();
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { principal?: Principal; requestContext?: RequestContext }>();
    const response = http.getResponse<Response>();
    const record = (): void => {
      const principal = request.principal;
      const route = request.route?.path ? `${request.method} ${request.route.path}` : `${request.method} ?`;
      if (route.startsWith('GET /healthz') || route.startsWith('GET /readyz')) return;
      this.usage.record({
        type: 'api.request',
        actorKind: principal ? actorKindOf(principal) : 'anonymous',
        actorId: principal?.userId ?? 'anonymous',
        principalKind: principal?.kind,
        sessionId: principal?.sessionId,
        requestId: request.requestContext?.requestId,
        outcome:
          response.statusCode >= 400
            ? response.statusCode === 401 || response.statusCode === 403
              ? 'denied'
              : 'failed'
            : 'success',
        attrs: { route, method: request.method, status: response.statusCode, latency_ms: Date.now() - started },
        ipHash: request.requestContext?.ipHash,
        userAgentFamily: request.requestContext?.userAgentFamily,
      });
    };
    return next.handle().pipe(
      tap({
        next: () => record(),
        error: () => record(),
      }),
    );
  }
}

class ClientEventDto {
  @IsString()
  @MaxLength(60)
  type!: string;

  @IsOptional()
  @IsISO8601()
  occurred_at?: string;

  @IsOptional()
  @IsUUID('4')
  account_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  request_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  entity_kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  entity_id?: string;

  @IsOptional()
  @IsObject()
  attrs?: Record<string, unknown>;
}

class TelemetryBatchDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ClientEventDto)
  events!: ClientEventDto[];
}

const PORTAL_EVENTS = new Set(['screen.view', 'screen.leave', 'action.completed', 'search.run', 'ui.error.shown']);
const ATTR_KEYS_MAX = 20;

@ApiTags('telemetry')
@ApiBearerAuth()
@Controller('telemetry')
@RealmOf('any')
@Authenticated()
export class TelemetryController {
  constructor(private readonly usage: UsageEventsService) {}

  @Post()
  ingest(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() body: TelemetryBatchDto,
  ): { accepted: number; rejected: number } {
    let accepted = 0;
    let rejected = 0;
    for (const event of body.events) {
      if (!isUsageEventType(event.type) || event.type === 'api.request') {
        rejected += 1;
        continue;
      }
      if (principal.kind === 'portal' && !PORTAL_EVENTS.has(event.type)) {
        rejected += 1;
        continue;
      }
      // Account ids come from the principal, never from the client.
      const accountId =
        event.account_id && principal.accountIds.includes(event.account_id)
          ? event.account_id
          : principal.kind === 'portal'
            ? principal.accountIds[0]
            : null;
      if (event.account_id && !accountId) {
        rejected += 1;
        continue;
      }
      const attrs = sanitiseAttrs(event.attrs ?? {});
      const occurredAt = event.occurred_at ? new Date(event.occurred_at) : undefined;
      if (occurredAt) attrs.client_ts = occurredAt.toISOString();
      this.usage.record({
        type: event.type,
        accountId,
        actorKind: actorKindOf(principal),
        actorId: principal.userId,
        principalKind: principal.kind,
        sessionId: principal.sessionId,
        requestId: event.request_id ?? ctx.requestId,
        entityKind: event.entity_kind,
        entityId: event.entity_id,
        attrs,
        ipHash: ctx.ipHash,
        userAgentFamily: ctx.userAgentFamily,
      });
      accepted += 1;
    }
    return { accepted, rejected };
  }
}

/** Structured facts only: primitives, capped key count, capped string length; no free text blobs. */
function sanitiseAttrs(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, ATTR_KEYS_MAX)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') output[key] = value;
    else if (typeof value === 'string') output[key] = value.slice(0, 120);
  }
  return output;
}

@Module({
  controllers: [TelemetryController],
  providers: [UsageEventsService, { provide: APP_INTERCEPTOR, useClass: ApiRequestInterceptor }],
  exports: [UsageEventsService],
})
export class TelemetryModule {}
