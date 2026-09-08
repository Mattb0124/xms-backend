import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import type { Permission } from '../../contracts/permissions.js';
import { StaleVersionError } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { ResolutionDto } from './tickets.dto.js';
import { TicketsService, type TicketView } from './tickets.service.js';

/**
 * Bulk actions on the queue selection (TM-16; Ticket Management functional
 * 5.12, technical 4). One route, one action, a bounded set of ticket keys
 * each carrying the version the caller read, and one outcome per key.
 *
 * Two rules shape the whole thing:
 *
 * - **Every ticket goes through the single-ticket service path.** Nothing
 *   here writes a ticket row, so the audit entries, outbox events, SLA
 *   clocks, close discipline, change-window gate and notifications are the
 *   same ones the record screen produces. A bulk transition that a change
 *   window refuses is refused here for the same reason and with the same
 *   code.
 * - **The request is not one transaction.** Each ticket runs in its own
 *   unit of work, so a refusal on the fourth ticket leaves the first three
 *   applied and the fourth untouched; there is no partial write inside one
 *   ticket, and the per-key outcomes say exactly what happened. One
 *   transaction over a hundred tickets would hold row locks across the
 *   whole batch and let one bad key undo work the desk already saw
 *   succeed, so the answer is the report, not the rollback.
 */
export const BULK_ACTIONS = [
  'assign',
  'set_group',
  'set_priority',
  'transition',
  'close',
  'comment',
  'work_note',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * The permission each action already needs on its single-ticket route. The
 * route itself declares `tickets:work`, the lowest of them, and the service
 * refuses the whole batch when the caller lacks the action's own
 * permission, because a half-applied batch is not a permission decision.
 */
const PERMISSION_BY_ACTION: Record<BulkAction, Permission> = {
  assign: 'tickets:work',
  set_group: 'tickets:work',
  set_priority: 'tickets:override-priority',
  transition: 'tickets:work',
  close: 'tickets:resolve',
  comment: 'tickets:work',
  work_note: 'tickets:work',
};

/**
 * The bound. The specification says "select rows in the queue" without a
 * number; a page of the queue is 200 at most and a hundred tickets is
 * already a minute of clock work behind one request, so a hundred is the
 * simplest defensible cap and it is stated here rather than guessed at by
 * the client.
 */
export const BULK_MAX_TICKETS = 100;

export class BulkTicketRefDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  key!: string;

  @IsInt()
  @Min(1)
  version!: number;
}

export class BulkActionDto {
  @IsIn(BULK_ACTIONS)
  action!: BulkAction;

  /** The bound is enforced in the service so the refusal carries a code. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => BulkTicketRefDto)
  tickets!: BulkTicketRefDto[];

  /** `assign`: null unassigns. */
  @IsOptional()
  @IsUUID('4')
  assignee_id?: string | null;

  /** `set_group`: null clears the assignment group. */
  @IsOptional()
  @IsUUID('4')
  group_id?: string | null;

  @IsOptional()
  @IsIn(['p1', 'p2', 'p3', 'p4'])
  priority?: 'p1' | 'p2' | 'p3' | 'p4';

  /** `transition` and `close`: the state to move to. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  to?: string;

  @IsOptional()
  @IsIn(['awaiting_client', 'awaiting_third_party', 'scheduled_window', 'blocked'])
  pause_reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  change_window_reason?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResolutionDto)
  resolution?: ResolutionDto;

  /** `comment` and `work_note`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  body?: string;
}

export type BulkOutcomeKind = 'ok' | 'version_conflict' | 'refused' | 'not_found';

export interface BulkOutcome {
  readonly key: string;
  readonly outcome: BulkOutcomeKind;
  /** The typed refusal code the single-ticket route would have answered. */
  readonly code?: string;
  /** Whatever else the refusal carried (the allowed states, the window, the missing items). */
  readonly detail?: Record<string, unknown>;
  /** The ticket's version after the action, or the current one on a version conflict. */
  readonly version?: number;
}

export interface BulkResult {
  readonly action: BulkAction;
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: BulkOutcome[];
}

@Injectable()
export class BulkTicketsService {
  private readonly logger = new Logger(BulkTicketsService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly tickets: TicketsService,
  ) {}

  async apply(principal: Principal, ctx: RequestContext, dto: BulkActionDto): Promise<BulkResult> {
    const permission = PERMISSION_BY_ACTION[dto.action];
    if (!principal.permissions.has(permission)) throw new ForbiddenException({ code: 'forbidden', permission });
    if (dto.tickets.length > BULK_MAX_TICKETS)
      throw new BadRequestException({ code: 'too_many_tickets', max: BULK_MAX_TICKETS, given: dto.tickets.length });
    this.assertShape(dto);

    const seen = new Set<string>();
    const results: BulkOutcome[] = [];
    for (const entry of dto.tickets) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      results.push(await this.one(principal, ctx, dto, entry));
    }
    const succeeded = results.filter((result) => result.outcome === 'ok').length;
    return {
      action: dto.action,
      requested: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    };
  }

  /** The parameter the action cannot run without, refused once for the batch. */
  private assertShape(dto: BulkActionDto): void {
    const missing =
      (dto.action === 'set_priority' && dto.priority === undefined && 'priority') ||
      ((dto.action === 'transition' || dto.action === 'close') && !dto.to && 'to') ||
      ((dto.action === 'comment' || dto.action === 'work_note') && !dto.body && 'body') ||
      (dto.action === 'assign' && dto.assignee_id === undefined && 'assignee_id') ||
      (dto.action === 'set_group' && dto.group_id === undefined && 'group_id');
    if (missing) throw new BadRequestException({ code: 'missing_parameter', action: dto.action, parameter: missing });
  }

  private async one(
    principal: Principal,
    ctx: RequestContext,
    dto: BulkActionDto,
    entry: BulkTicketRefDto,
  ): Promise<BulkOutcome> {
    try {
      const version = await this.run(principal, ctx, dto, entry);
      return { key: entry.key, outcome: 'ok', version };
    } catch (error) {
      return { key: entry.key, ...this.outcomeOf(error) };
    }
  }

  /** Runs the action through the single-ticket path and answers the resulting version. */
  private async run(
    principal: Principal,
    ctx: RequestContext,
    dto: BulkActionDto,
    entry: BulkTicketRefDto,
  ): Promise<number> {
    switch (dto.action) {
      case 'assign': {
        const view = await this.tickets.patch(principal, ctx, entry.key, {
          version: entry.version,
          assignee_id: dto.assignee_id ?? null,
        });
        return view.version;
      }
      case 'set_group': {
        const view = await this.tickets.patch(principal, ctx, entry.key, {
          version: entry.version,
          group_id: dto.group_id ?? null,
        });
        return view.version;
      }
      case 'set_priority': {
        const view = await this.tickets.patch(principal, ctx, entry.key, {
          version: entry.version,
          priority: dto.priority,
        });
        return view.version;
      }
      case 'transition':
      case 'close': {
        const view = (await this.tickets.transition(principal, ctx, entry.key, {
          version: entry.version,
          to: dto.to!,
          pause_reason: dto.pause_reason,
          note: dto.note,
          change_window_reason: dto.change_window_reason,
          resolution: dto.resolution,
        })) as TicketView;
        return view.version;
      }
      // The message routes take no version of their own, so the version the
      // caller read is checked here, inside the same transaction as the
      // write, rather than being quietly ignored on a bulk call.
      case 'comment':
      case 'work_note':
        return this.uow.run(principal, async (tx) => {
          const before = (await this.tickets.get(principal, entry.key, tx)) as TicketView;
          if (before.version !== entry.version)
            throw new StaleVersionErrorWithVersion('ticket', before.id, before.version);
          if (dto.action === 'comment')
            await this.tickets.addComment(principal, ctx, entry.key, { body: dto.body! }, tx);
          else await this.tickets.addWorkNote(principal, ctx, entry.key, { body: dto.body! }, tx);
          const after = (await this.tickets.get(principal, entry.key, tx)) as TicketView;
          return after.version;
        });
    }
  }

  /**
   * The refusal each single-ticket route would have answered, turned into a
   * per-key outcome. Anything not recognised is reported as a refusal with
   * `internal_error` and logged, because losing the outcomes of the tickets
   * that already succeeded would be worse than reporting one opaque key.
   */
  private outcomeOf(error: unknown): Omit<BulkOutcome, 'key'> {
    if (error instanceof StaleVersionErrorWithVersion)
      return { outcome: 'version_conflict', code: 'stale_version', version: error.currentVersion };
    if (error instanceof StaleVersionError) return { outcome: 'version_conflict', code: 'stale_version' };
    if (error instanceof HttpException) {
      const payload = error.getResponse();
      const body = typeof payload === 'string' ? { code: payload } : (payload as Record<string, unknown>);
      const code = typeof body.code === 'string' ? body.code : undefined;
      const { code: _code, ...detail } = body;
      const rest = Object.keys(detail).length > 0 ? (detail as Record<string, unknown>) : undefined;
      if (code === 'stale_version')
        return {
          outcome: 'version_conflict',
          code,
          version: typeof body.version === 'number' ? body.version : undefined,
        };
      if (error.getStatus() === 404) return { outcome: 'not_found', code: code ?? 'not_found', detail: rest };
      return { outcome: 'refused', code: code ?? 'refused', detail: rest };
    }
    this.logger.error(`bulk action failed on one ticket: ${(error as Error)?.stack ?? String(error)}`);
    return { outcome: 'refused', code: 'internal_error' };
  }
}

/** A stale version detected before the write, carrying the version the caller should reload. */
class StaleVersionErrorWithVersion extends StaleVersionError {
  constructor(
    entity: string,
    id: string,
    readonly currentVersion: number,
  ) {
    super(entity, id);
  }
}

/**
 * `POST /v1/tickets/bulk` sits on its own controller so the handler stays a
 * DTO mapping and one service call, and so the bulk service is the only
 * thing it knows about.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class BulkTicketsController {
  constructor(private readonly bulk: BulkTicketsService) {}

  @Post('bulk')
  @RequirePermission('tickets:work')
  apply(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: BulkActionDto,
  ): Promise<BulkResult> {
    return this.bulk.apply(principal, ctx, dto);
  }
}
