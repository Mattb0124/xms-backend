import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { PrincipalRepository } from '../../common/auth/principal.repository.js';
import { Public } from '../../common/auth/public.decorator.js';
import { loadEnv } from '../../config/env.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { writeCalendar, type IcsEvent, type IcsStatus } from '../../domain/integrations/ics.js';
import type { FreezeWindow } from '../../domain/tickets/change-window.js';
import {
  assertCalendarRange,
  ChangeWindowsCoreModule,
  TicketGroupsRepository,
} from '../tickets/change-windows.module.js';

/**
 * The change calendar as a subscribed ICS feed (INT-05; Integrations
 * functional 5.6). Two ways in, one document:
 *
 * - `GET /v1/accounts/{id}/change-calendar.ics` for a signed-in reader
 *   under `tickets:view`, which is what a browser download and a screen
 *   link use.
 * - `GET /v1/calendar-feed/{id}/change-calendar.ics?token=...` for a
 *   calendar client, which cannot carry a bearer header. The token is the
 *   whole credential, so the route is public and sits under the public
 *   rate-limit policy alongside the CSAT survey link.
 *
 * **Why the token is in the query and the record id is in the path.** This
 * is the CSAT one-time-link scheme, already reviewed here: the id names the
 * row so the lookup is a primary key read rather than a search on a
 * secret-shaped column, and the presented token is compared in constant
 * time against the stored SHA-256. An unknown id and a wrong token answer
 * the same 404, so the route never confirms that an id exists. The token
 * goes in the query rather than the path because every calendar client
 * accepts a query string on a subscription URL and because it keeps the
 * secret out of the route pattern the router matches on; neither placement
 * hides it from a proxy log, which is why the token is revocable and says
 * when it was last used.
 *
 * The feed covers every account the token's owner is granted, filtered to
 * one with `account_id` when a person wants a calendar per client. Access
 * is resolved through the same `resolveAccess` the guard uses, so a
 * deactivated user, a revoked grant or a suspended account changes the feed
 * on the next read.
 */
const FEED_PAST_DAYS = 90;
const FEED_FUTURE_DAYS = 365;
const TICKETS_IN_DESCRIPTION = 10;

export interface CalendarFeedTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function hashFeedToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compares a presented token against the stored hash in constant time. */
export function feedTokenMatches(storedHash: string, token: string): boolean {
  const expected = Buffer.from(storedHash, 'utf8');
  const given = Buffer.from(hashFeedToken(token), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

@Injectable()
export class CalendarFeedRepository extends RepositoryBase {
  byId(tx: Tx, id: string): Promise<CalendarFeedTokenRow | undefined> {
    return this.maybeOne<CalendarFeedTokenRow>(
      tx,
      'select * from op.calendar_feed_tokens where id = $1 and revoked_at is null',
      [id],
    );
  }

  insert(tx: Tx, userId: string, tokenHash: string): Promise<CalendarFeedTokenRow> {
    return this.one<CalendarFeedTokenRow>(
      tx,
      'calendar_feed_token',
      'insert into op.calendar_feed_tokens (user_id, token_hash) values ($1, $2) returning *',
      [userId, tokenHash],
    );
  }

  live(tx: Tx, userId: string): Promise<CalendarFeedTokenRow[]> {
    return this.many<CalendarFeedTokenRow>(
      tx,
      'select * from op.calendar_feed_tokens where user_id = $1 and revoked_at is null order by created_at',
      [userId],
    );
  }

  async revokeAll(tx: Tx, userId: string): Promise<number> {
    const result = await tx.query(
      'update op.calendar_feed_tokens set revoked_at = now() where user_id = $1 and revoked_at is null',
      [userId],
    );
    return result.rowCount ?? 0;
  }

  async touch(tx: Tx, id: string): Promise<void> {
    await tx.query('update op.calendar_feed_tokens set last_used_at = now() where id = $1', [id]);
  }
}

export class CalendarFeedQueryDto {
  @IsOptional() @IsUUID('4') account_id?: string;

  @IsOptional() @IsISO8601({ strict: true }) from?: string;

  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

export class TokenCalendarFeedQueryDto extends CalendarFeedQueryDto {
  @IsString() @MaxLength(200) token!: string;
}

export class AccountCalendarFeedQueryDto {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;

  @IsOptional() @IsISO8601({ strict: true }) to?: string;

  /** Reserved for a future "only the windows I am on" feed; the vocabulary is fixed here. */
  @IsOptional() @IsIn(['all']) scope?: 'all';
}

@Injectable()
export class CalendarFeedService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tokens: CalendarFeedRepository,
    private readonly groups: TicketGroupsRepository,
    private readonly principals: PrincipalRepository,
    private readonly audit: AuditService,
  ) {}

  /** Mints a feed for the signed-in person; the token is answered once and never again. */
  async create(
    principal: Principal,
    ctx: RequestContext,
  ): Promise<{ id: string; token: string; url: string; created_at: string }> {
    const token = randomBytes(24).toString('base64url');
    const row = await this.uow.operator(async (tx) => {
      const created = await this.tokens.insert(tx, principal.userId, hashFeedToken(token));
      await this.audit.operator(tx, actorOf(principal), ctx, [
        { entityKind: 'calendar_feed_token', entityId: created.id, eventType: 'created' },
      ]);
      return created;
    });
    return { id: row.id, token, url: feedUrl(row.id, token), created_at: row.created_at };
  }

  /** Revokes every live feed of the signed-in person: one button, no list to reason about. */
  async revoke(principal: Principal, ctx: RequestContext): Promise<void> {
    await this.uow.operator(async (tx) => {
      const live = await this.tokens.live(tx, principal.userId);
      if (live.length === 0) return;
      await this.tokens.revokeAll(tx, principal.userId);
      await this.audit.operator(
        tx,
        actorOf(principal),
        ctx,
        live.map((row) => ({
          entityKind: 'calendar_feed_token',
          entityId: row.id,
          eventType: 'deleted' as const,
        })),
      );
    });
  }

  /** The feed a signed-in reader asks for, one account at a time. */
  async forAccount(principal: Principal, accountId: string, query: AccountCalendarFeedQueryDto): Promise<string> {
    if (!principal.accountIds.includes(accountId))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.document([accountId], query.from, query.to);
  }

  /**
   * The feed a calendar client asks for. The token names the person, and
   * the person's access is resolved fresh on every read, so a revoked
   * grant or a deactivated account takes effect at the next poll.
   */
  async byToken(id: string, query: TokenCalendarFeedQueryDto): Promise<string> {
    const row = await this.uow.operator((tx) => this.tokens.byId(tx, id));
    if (!row || !feedTokenMatches(row.token_hash, query.token))
      throw new NotFoundException({ code: 'not_found', entity: 'calendar_feed' });
    const user = await this.principals.findUserById(row.user_id);
    if (!user || user.kind !== 'internal' || user.status !== 'active')
      throw new NotFoundException({ code: 'not_found', entity: 'calendar_feed' });
    const access = await this.principals.resolveAccess(user);
    const accountIds = query.account_id
      ? access.accountIds.filter((candidate) => candidate === query.account_id)
      : access.accountIds;
    if (accountIds.length === 0) throw new NotFoundException({ code: 'not_found', entity: 'calendar_feed' });
    await this.uow.operator((tx) => this.tokens.touch(tx, id));
    return this.document(accountIds, query.from, query.to);
  }

  /**
   * The document itself. Every window in range becomes one event and every
   * freeze one more, with the window's `version` as the sequence so an edit
   * a subscriber has not seen yet is the higher number.
   */
  private async document(accountIds: string[], from?: string, to?: string): Promise<string> {
    const now = new Date();
    const start = from ?? new Date(now.getTime() - FEED_PAST_DAYS * 86_400_000).toISOString();
    const end = to ?? new Date(now.getTime() + FEED_FUTURE_DAYS * 86_400_000).toISOString();
    assertCalendarRange(start, end, FEED_PAST_DAYS + FEED_FUTURE_DAYS);
    // One transaction and two queries, whatever the number of windows: the
    // member tickets used to be read one window at a time, and each of
    // those opened a transaction of its own.
    const { rows, tickets } = await this.uow.system(accountIds, async (tx) => {
      const windows = await this.groups.feed(tx, accountIds, start, end);
      return {
        rows: windows,
        tickets: await this.groups.ticketsOfMany(
          tx,
          windows.map((window) => window.id),
        ),
      };
    });
    const events: IcsEvent[] = [];
    for (const row of rows) {
      if (!row.starts_at || !row.ends_at) continue;
      const status: IcsStatus =
        row.status === 'cancelled' ? 'CANCELLED' : row.status === 'planned' ? 'TENTATIVE' : 'CONFIRMED';
      // `version` starts at 1 on an untouched record and rises on every
      // edit, so the sequence a subscriber sees is the number of edits.
      const sequence = Math.max(0, row.version - 1);
      const named = (tickets.get(row.id) ?? [])
        .slice(0, TICKETS_IN_DESCRIPTION)
        .map((ticket) => `${ticket.key} ${ticket.short_description}`);
      const total = (tickets.get(row.id) ?? []).length;
      const more = total > named.length ? [`and ${total - named.length} more`] : [];
      events.push({
        uid: `change-window-${row.id}@xms`,
        start: new Date(row.starts_at),
        end: new Date(row.ends_at),
        summary: `${row.account_key}: ${row.name}`,
        description: [row.description, ...named, ...more].filter(Boolean).join('\n') || undefined,
        status,
        sequence,
        lastModified: new Date(row.updated_at),
      });
      const freezes = (row.freeze_windows ?? []) as FreezeWindow[];
      freezes.forEach((freeze, index) => {
        const freezeStart = new Date(freeze.starts_at);
        const freezeEnd = new Date(freeze.ends_at);
        if (Number.isNaN(freezeStart.getTime()) || Number.isNaN(freezeEnd.getTime())) return;
        events.push({
          uid: `change-freeze-${row.id}-${index}@xms`,
          start: freezeStart,
          end: freezeEnd,
          summary: `${row.account_key}: freeze, ${freeze.reason ?? row.name}`,
          description: `Nothing may be scheduled in ${row.name} during this freeze.`,
          status,
          sequence,
          // A freeze is a rule, not an appointment, so it never marks
          // anybody busy.
          transparent: true,
          lastModified: new Date(row.updated_at),
        });
      });
    }
    return writeCalendar(events, { name: 'XMS change calendar', stamp: now });
  }
}

/** The address a calendar client subscribes to, built from the API's own base URL. */
export function feedUrl(id: string, token: string): string {
  const base = loadEnv().API_BASE_URL.replace(/\/$/, '');
  return `${base}/v1/calendar-feed/${id}/change-calendar.ics?token=${encodeURIComponent(token)}`;
}

const ICS_CONTENT_TYPE = 'text/calendar; charset=utf-8';

/**
 * The content type is set on the response only once the document exists, so
 * a refusal is still answered as JSON by the exception filter rather than
 * as a calendar a client would try to parse.
 */
async function asCalendar(response: Response, document: Promise<string>): Promise<string> {
  const body = await document;
  response.type(ICS_CONTENT_TYPE);
  return body;
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('me')
export class CalendarTokenController {
  constructor(private readonly feed: CalendarFeedService) {}

  @Post('calendar-token')
  @RequirePermission('tickets:view')
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext) {
    return this.feed.create(principal, ctx);
  }

  @Delete('calendar-token')
  @HttpCode(204)
  @RequirePermission('tickets:view')
  revoke(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext) {
    return this.feed.revoke(principal, ctx);
  }
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('accounts/:accountId')
export class AccountCalendarFeedController {
  constructor(private readonly feed: CalendarFeedService) {}

  @Get('change-calendar.ics')
  @RequirePermission('tickets:view')
  ics(
    @CurrentPrincipal() principal: Principal,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query() query: AccountCalendarFeedQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    return asCalendar(response, this.feed.forAccount(principal, accountId, query));
  }
}

@ApiTags('integrations')
@Controller('calendar-feed')
export class CalendarFeedController {
  constructor(private readonly feed: CalendarFeedService) {}

  @Get(':id/change-calendar.ics')
  @Public('calendar subscription link; the feed token is the credential')
  ics(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TokenCalendarFeedQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    return asCalendar(response, this.feed.byToken(id, query));
  }
}

@Module({
  imports: [ChangeWindowsCoreModule],
  providers: [CalendarFeedRepository, CalendarFeedService],
  exports: [CalendarFeedRepository, CalendarFeedService],
})
export class CalendarFeedCoreModule {}

@Module({
  imports: [CalendarFeedCoreModule],
  controllers: [CalendarTokenController, AccountCalendarFeedController, CalendarFeedController],
  exports: [CalendarFeedCoreModule],
})
export class CalendarFeedModule {}
