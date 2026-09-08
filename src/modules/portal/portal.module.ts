import {
  BadRequestException,
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
import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
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
import type { Tx } from '../../db/repository.base.js';
import { AdminCoreModule } from '../admin/admin.module.js';
import { AccountsRepository } from '../admin/accounts/accounts.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TicketsRepository } from '../tickets/tickets.repository.js';
import { TicketsService, type PortalTicketView } from '../tickets/tickets.service.js';
import { MessageDto } from '../tickets/tickets.dto.js';
import { FormsCoreModule, FormsRepository, FORM_TICKET_TYPES, type FormTicketType } from './forms.module.js';
import { defaultFormDefinition, validateSubmission, type FormDefinition } from '../../domain/portal/form-schema.js';

/**
 * The client portal (02-modules/client-portal, P2.16 cut). Every route sits
 * under /v1/portal and accepts portal principals only (the guard's realm
 * check runs before any lookup). Reads use the portal database role, which
 * can only see the public projection; writes go through the same ticket
 * service internal users use, on the app role bound to the one account,
 * with the actor recorded as the portal user.
 */
class PortalCreateTicketDto {
  @IsIn(FORM_TICKET_TYPES)
  type!: FormTicketType;

  /**
   * The fixed shape the web form has always posted. Optional now, because a
   * request answering a published form carries its summary in `answers`
   * instead; one of the two must produce a summary.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  short_description?: string;

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

  /**
   * The answers to the form's fields, keyed by field key (CP-03). Required
   * once the account publishes a form for this type, so a required field
   * cannot be skipped by posting the old flat shape instead.
   */
  @IsOptional()
  @IsObject()
  answers?: Record<string, unknown>;
}

/** A request-type card and the form behind it, as the portal renders them. */
export interface PortalFormView {
  ticket_type: FormTicketType;
  name: string;
  description: string;
  form_id: string | null;
  form_version_id: string | null;
  version_no: number | null;
  /** `published` is the account's own form; `default` is the fixed fallback. */
  source: 'published' | 'default';
  definition: FormDefinition;
}

/**
 * The types a client may always raise. Change is offered only where the
 * account has published a form for it (functional 5.2), and Problem and
 * Project Task are internal types a client never creates.
 */
const DEFAULT_PORTAL_TYPES = ['incident', 'service_request'] as const;

const DEFAULT_FORM_NAMES: Record<(typeof DEFAULT_PORTAL_TYPES)[number], { name: string; description: string }> = {
  incident: { name: 'Report a problem', description: 'Something is broken or not working as it should.' },
  service_request: { name: 'Ask for something', description: 'A request for access, a change or a piece of work.' },
};

function defaultFormView(type: (typeof DEFAULT_PORTAL_TYPES)[number]): PortalFormView {
  return {
    ticket_type: type,
    name: DEFAULT_FORM_NAMES[type].name,
    description: DEFAULT_FORM_NAMES[type].description,
    form_id: null,
    form_version_id: null,
    version_no: null,
    source: 'default',
    definition: defaultFormDefinition(type),
  };
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
    private readonly forms: FormsRepository,
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

  /**
   * The request types the account offers, each with the form the client is
   * asked to fill in (CP-03). A type the account has not authored a form for
   * still answers, with the fixed default definition, so the web form keeps
   * working exactly as it did before forms existed.
   */
  async formList(principal: Principal): Promise<{ items: PortalFormView[] }> {
    const [accountId] = principal.accountIds;
    if (!accountId) return { items: [] };
    const published = await this.uow.run(principal, (tx) => this.forms.publishedForAccount(tx, accountId));
    const items = published.map((form): PortalFormView => ({
      ticket_type: form.ticket_type,
      name: form.name,
      description: form.description,
      form_id: form.id,
      form_version_id: form.version_id,
      version_no: form.version_no,
      source: 'published',
      definition: form.definition,
    }));
    for (const type of DEFAULT_PORTAL_TYPES)
      if (!items.some((item) => item.ticket_type === type)) items.push(defaultFormView(type));
    return { items: items.sort((left, right) => left.ticket_type.localeCompare(right.ticket_type)) };
  }

  async form(principal: Principal, type: string): Promise<PortalFormView> {
    if (!(FORM_TICKET_TYPES as readonly string[]).includes(type))
      throw new NotFoundException({ code: 'not_found', entity: 'ticket_form' });
    const { items } = await this.formList(principal);
    const found = items.find((item) => item.ticket_type === type);
    if (!found) throw new NotFoundException({ code: 'not_found', entity: 'ticket_form' });
    return found;
  }

  async create(principal: Principal, ctx: RequestContext, dto: PortalCreateTicketDto): Promise<PortalTicketView> {
    const [accountId] = principal.accountIds;
    if (!accountId) throw new NotFoundException({ code: 'not_found', entity: 'account' });
    return this.uow.portalWrite(principal, async (tx) => {
      const submission = await this.mapSubmission(tx, accountId, dto);
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
          short_description: submission.short_description,
          description: submission.description,
          category: submission.category,
          impact: submission.impact,
          urgency: submission.urgency,
          form_version_id: submission.form_version_id,
          form_data: submission.form_data,
          requester_email: contact.email,
          requester_name: contact.display_name,
          source: 'internal',
        },
        tx,
      );
      return (await this.tickets.get(principal, created.id, tx)) as PortalTicketView;
    });
  }

  /**
   * What the request becomes: the account's published form decides, and the
   * fixed default stands in when it has published none. The answers are
   * checked against the same definition the client was served, so a required
   * field cannot be skipped and a field a condition hid is not stored.
   */
  private async mapSubmission(
    tx: Tx,
    accountId: string,
    dto: PortalCreateTicketDto,
  ): Promise<{
    short_description: string;
    description?: string;
    category?: string;
    impact?: 'high' | 'medium' | 'low';
    urgency?: 'high' | 'medium' | 'low';
    form_version_id: string | null;
    form_data: Record<string, unknown>;
  }> {
    const published = await this.forms.publishedFor(tx, accountId, dto.type);
    if (!published && !DEFAULT_PORTAL_TYPES.includes(dto.type as (typeof DEFAULT_PORTAL_TYPES)[number]))
      throw new BadRequestException({ code: 'type_not_offered', ticket_type: dto.type });
    if (published && dto.answers === undefined)
      throw new BadRequestException({
        code: 'form_answers_required',
        ticket_type: dto.type,
        form_version_id: published.version_id,
      });
    const flat = {
      short_description: dto.short_description,
      description: dto.description,
      category: dto.category,
      impact: dto.impact,
      urgency: dto.urgency,
      form_version_id: published?.version_id ?? null,
      form_data: {} as Record<string, unknown>,
    };
    if (dto.answers === undefined) {
      if (!flat.short_description)
        throw new BadRequestException({
          code: 'invalid_submission',
          problems: [{ field: 'short_description', code: 'required', message: 'a request needs a summary' }],
        });
      return { ...flat, short_description: flat.short_description };
    }
    const definition: FormDefinition = published?.definition ?? defaultFormDefinition(dto.type);
    const { problems, mapped } = validateSubmission(definition, dto.answers);
    if (problems.length > 0) throw new BadRequestException({ code: 'invalid_submission', problems });
    const shortDescription = (mapped.columns.short_description as string | undefined) ?? dto.short_description;
    if (!shortDescription)
      throw new BadRequestException({
        code: 'invalid_submission',
        problems: [{ field: 'short_description', code: 'required', message: 'a request needs a summary' }],
      });
    return {
      short_description: shortDescription,
      description: (mapped.columns.description as string | undefined) ?? dto.description,
      category: (mapped.columns.category as string | undefined) ?? dto.category,
      impact: (mapped.columns.impact as 'high' | 'medium' | 'low' | undefined) ?? dto.impact,
      urgency: (mapped.columns.urgency as 'high' | 'medium' | 'low' | undefined) ?? dto.urgency,
      form_version_id: published?.version_id ?? null,
      form_data: mapped.custom,
    };
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

  @Get('forms')
  @RequirePermission('portal:submit')
  forms(@CurrentPrincipal() principal: Principal) {
    return this.portal.formList(principal);
  }

  @Get('forms/:type')
  @RequirePermission('portal:submit')
  form(@CurrentPrincipal() principal: Principal, @Param('type') type: string) {
    return this.portal.form(principal, type);
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
  imports: [TicketsCoreModule, AdminCoreModule, FormsCoreModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
