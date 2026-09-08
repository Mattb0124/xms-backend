import {
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import {
  Authenticated,
  CurrentPrincipal,
  RealmOf,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { AdminCoreModule } from '../admin/admin.module.js';
import { AccountsRepository } from '../admin/accounts/accounts.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TicketsRepository } from '../tickets/tickets.repository.js';
import { TicketsService, type PortalTicketView } from '../tickets/tickets.service.js';
import { MessageDto } from '../tickets/tickets.dto.js';

/**
 * The client portal (02-modules/client-portal, P2.16 cut). Every route sits
 * under /v1/portal and accepts portal principals only (the guard's realm
 * check runs before any lookup). Reads use the portal database role, which
 * can only see the public projection; writes go through the same ticket
 * service internal users use, on the app role bound to the one account,
 * with the actor recorded as the portal user.
 */
class PortalCreateTicketDto {
  @IsIn(['incident', 'service_request'])
  type!: 'incident' | 'service_request';

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  short_description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsIn(['high', 'medium', 'low'])
  impact?: 'high' | 'medium' | 'low';

  @IsOptional()
  @IsIn(['high', 'medium', 'low'])
  urgency?: 'high' | 'medium' | 'low';
}

class PortalTransitionDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  to!: string;
}

class PortalListQueryDto {
  @IsOptional()
  @IsIn(['open', 'all', 'mine'])
  scope?: 'open' | 'all' | 'mine';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly tickets: TicketsService,
    private readonly ticketsRepo: TicketsRepository,
    private readonly accounts: AccountsRepository,
  ) {}

  async me(principal: Principal) {
    const [accountId] = principal.accountIds;
    const account = accountId ? await this.uow.operator((tx) => this.accounts.byId(tx, accountId)) : undefined;
    return {
      principal: {
        kind: principal.kind,
        userId: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
        permissions: [...principal.permissions].sort(),
      },
      account: account ? { id: account.id, key: account.key, name: account.name, branding: account.branding } : null,
    };
  }

  /** Own requests unless the portal user may view every request of the account. */
  async list(
    principal: Principal,
    query: PortalListQueryDto,
  ): Promise<{ items: PortalTicketView[]; next_cursor: string | null }> {
    const [accountId] = principal.accountIds;
    if (!accountId) return { items: [], next_cursor: null };
    return this.uow.run(principal, async (tx) => {
      const orgWide = principal.permissions.has('portal:view-org-tickets') && query.scope !== 'mine';
      const contact = await this.ticketsRepo.contactByEmail(tx, accountId, principal.email.toLowerCase());
      if (!orgWide && !contact) return { items: [], next_cursor: null };
      const page = await this.ticketsRepo.list(
        tx,
        {
          accountIds: [accountId],
          open: query.scope !== 'all',
          q: query.q,
          requesterContactId: orgWide ? undefined : contact!.id,
        },
        { limit: 50, sort: 'updated_desc' },
      );
      // One row the view cannot be built for must never empty a client's
      // whole list: the row is left out and named in the log, and the rest
      // of the page answers (REVIEW-frontend 2026-09-08 finding 2).
      const items: PortalTicketView[] = [];
      const failed: string[] = [];
      for (const row of page.rows) {
        try {
          items.push((await this.tickets.get(principal, row.id, tx)) as PortalTicketView);
        } catch (error) {
          failed.push(row.id);
          this.logger.warn(`portal list: ticket ${row.id} left out: ${(error as Error).message}`);
        }
      }
      if (failed.length > 0)
        this.logger.warn(`portal list for account ${accountId}: ${failed.length} of ${page.rows.length} left out`);
      return { items, next_cursor: null };
    });
  }

  async get(principal: Principal, key: string): Promise<PortalTicketView> {
    return this.uow.run(principal, async (tx) => {
      const view = (await this.tickets.get(principal, key, tx)) as PortalTicketView;
      await this.assertVisible(tx, principal, view.id);
      return view;
    });
  }

  async create(principal: Principal, ctx: RequestContext, dto: PortalCreateTicketDto): Promise<PortalTicketView> {
    const [accountId] = principal.accountIds;
    if (!accountId) throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.portalWrite(principal, async (tx) => {
      const contact =
        (await this.ticketsRepo.contactByEmail(tx, accountId, principal.email.toLowerCase())) ??
        (await this.ticketsRepo.insertContact(
          tx,
          accountId,
          principal.email.toLowerCase(),
          principal.displayName,
          principal.userId,
        ));
      const created = await this.tickets.create(
        principal,
        ctx,
        {
          account_id: accountId,
          type: dto.type,
          short_description: dto.short_description,
          description: dto.description,
          category: dto.category,
          impact: dto.impact,
          urgency: dto.urgency,
          requester_email: contact.email,
          requester_name: contact.display_name,
          source: 'internal',
        },
        tx,
      );
      return (await this.tickets.get(principal, created.id, tx)) as PortalTicketView;
    });
  }

  async comment(principal: Principal, ctx: RequestContext, key: string, dto: MessageDto): Promise<unknown> {
    return this.uow.portalWrite(principal, async (tx) => {
      const ticket = await this.ticketsRepo.byNumber(tx, numberOf(key));
      await this.assertVisible(tx, principal, ticket.id);
      return this.tickets.addComment(principal, ctx, ticket.id, dto, tx);
    });
  }

  async timeline(principal: Principal, key: string): Promise<unknown[]> {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.ticketsRepo.byNumber(tx, numberOf(key));
      await this.assertVisible(tx, principal, ticket.id);
      return this.tickets.timeline(principal, ticket.id, tx);
    });
  }

  async transition(
    principal: Principal,
    ctx: RequestContext,
    key: string,
    dto: PortalTransitionDto,
  ): Promise<PortalTicketView> {
    return this.uow.portalWrite(principal, async (tx) => {
      const ticket = await this.ticketsRepo.byNumber(tx, numberOf(key));
      await this.assertVisible(tx, principal, ticket.id);
      return (await this.tickets.transition(
        principal,
        ctx,
        ticket.id,
        { version: dto.version, to: dto.to },
        tx,
      )) as PortalTicketView;
    });
  }

  async transitions(principal: Principal, key: string) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.ticketsRepo.byNumber(tx, numberOf(key));
      await this.assertVisible(tx, principal, ticket.id);
      return this.tickets.allowedTransitions(principal, ticket.id, tx);
    });
  }

  /** A requester sees own requests; portal:view-org-tickets sees the account's. RLS already bounds the account. */
  private async assertVisible(
    tx: Parameters<TicketsRepository['byId']>[0],
    principal: Principal,
    ticketId: string,
  ): Promise<void> {
    if (principal.permissions.has('portal:view-org-tickets')) return;
    const ticket = await this.ticketsRepo.byId(tx, ticketId);
    const contact = ticket.requester_contact_id
      ? await this.ticketsRepo.contactById(tx, ticket.requester_contact_id).catch(() => undefined)
      : undefined;
    if (!contact || contact.email.toLowerCase() !== principal.email.toLowerCase())
      throw new NotFoundException({ code: 'not_found', entity: 'ticket' });
  }
}

function numberOf(key: string): string {
  const match = key.match(/^CS(\d{7,})$/i);
  if (!match) throw new NotFoundException({ code: 'not_found', entity: 'ticket' });
  return String(Number(match[1]));
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
@RealmOf('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('me')
  @Authenticated()
  me(@CurrentPrincipal() principal: Principal) {
    return this.portal.me(principal);
  }

  @Get('tickets')
  @RequirePermission('portal:submit')
  list(@CurrentPrincipal() principal: Principal, @Query() query: PortalListQueryDto) {
    return this.portal.list(principal, query);
  }

  @Post('tickets')
  @RequirePermission('portal:submit')
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: PortalCreateTicketDto,
  ) {
    return this.portal.create(principal, ctx, dto);
  }

  @Get('tickets/:key')
  @RequirePermission('portal:submit')
  get(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.portal.get(principal, key);
  }

  @Get('tickets/:key/timeline')
  @RequirePermission('portal:submit')
  timeline(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.portal.timeline(principal, key);
  }

  @Post('tickets/:key/comments')
  @RequirePermission('portal:submit')
  comment(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: MessageDto,
  ) {
    return this.portal.comment(principal, ctx, key, dto);
  }

  @Get('tickets/:key/transitions')
  @RequirePermission('portal:submit')
  transitions(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.portal.transitions(principal, key);
  }

  @Post('tickets/:key/transitions')
  @RequirePermission('portal:submit')
  transition(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: PortalTransitionDto,
  ) {
    return this.portal.transition(principal, ctx, key, dto);
  }
}

@Module({
  imports: [TicketsCoreModule, AdminCoreModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
