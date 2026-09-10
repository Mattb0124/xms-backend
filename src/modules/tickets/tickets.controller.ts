import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import {
  CreateTicketDto,
  LinkDto,
  ListTicketsQueryDto,
  MessageDto,
  PatchTicketDto,
  ScopeDecisionDto,
  ScopeFlagDto,
  TransitionDto,
  WatchDto,
} from './tickets.dto.js';
import { TicketsService } from './tickets.service.js';

/** Internal realm routes (Ticket Management technical 4). The portal mirror lives in the Client Portal module. */
@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @RequirePermission('tickets:view')
  list(@CurrentPrincipal() principal: Principal, @Query() query: ListTicketsQueryDto) {
    return this.tickets.list(principal, query);
  }

  @Post()
  @RequirePermission('tickets:create')
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateTicketDto) {
    return this.tickets.create(principal, ctx, dto);
  }

  /** Every scope decision on an account in a window, as CSV. */
  @Get('scope-decisions.csv')
  @RequirePermission('contracts:view')
  async exportScopeDecisions(
    @Res() response: Response,
    @CurrentPrincipal() principal: Principal,
    @Query('account_id') accountId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const result = await this.tickets.exportScopeDecisions(principal, accountId, from, to);
    response.setHeader('content-type', 'text/csv; charset=utf-8');
    response.setHeader('content-disposition', `attachment; filename="${result.fileName}"`);
    response.setHeader('x-row-count', String(result.rows));
    response.send(result.body);
  }

  @Get(':key')
  @RequirePermission('tickets:view')
  get(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.tickets.get(principal, key);
  }

  @Patch(':key')
  @RequirePermission('tickets:work')
  patch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: PatchTicketDto,
  ) {
    return this.tickets.patch(principal, ctx, key, dto);
  }

  @Get(':key/transitions')
  @RequirePermission('tickets:view')
  transitions(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.tickets.allowedTransitions(principal, key);
  }

  @Post(':key/transitions')
  @RequirePermission('tickets:work')
  transition(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: TransitionDto,
  ) {
    return this.tickets.transition(principal, ctx, key, dto);
  }

  /**
   * Flagging work as out of scope is part of working the ticket; deciding
   * the flag is the account's commercial answer and has its own permission
   * (TM-11, Ticket Management technical 4).
   */
  @Post(':key/scope')
  @RequirePermission('tickets:work')
  flagScope(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: ScopeFlagDto,
  ) {
    return this.tickets.flagScope(principal, ctx, key, dto);
  }

  @Post(':key/scope/decision')
  @RequirePermission('tickets:approve-scope')
  decideScope(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: ScopeDecisionDto,
  ) {
    return this.tickets.decideScope(principal, ctx, key, dto);
  }

  /** The immutable record behind the flag: who raised it, who decided it, when. */
  @Get(':key/scope/record')
  @RequirePermission('tickets:view')
  scopeRecord(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.tickets.scopeRecord(principal, key);
  }

  @Get(':key/comments')
  @RequirePermission('tickets:view')
  comments(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.tickets.comments(principal, key);
  }

  @Post(':key/comments')
  @RequirePermission('tickets:work')
  addComment(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: MessageDto,
  ) {
    return this.tickets.addComment(principal, ctx, key, dto);
  }

  @Get(':key/work-notes')
  @RequirePermission('tickets:view')
  workNotes(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.tickets.workNotes(principal, key);
  }

  @Post(':key/work-notes')
  @RequirePermission('tickets:work')
  addWorkNote(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: MessageDto,
  ) {
    return this.tickets.addWorkNote(principal, ctx, key, dto);
  }

  @Get(':key/timeline')
  @RequirePermission('tickets:view')
  timeline(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.tickets.timeline(principal, key);
  }

  @Get(':key/links')
  @RequirePermission('tickets:view')
  links(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.tickets.links(principal, key);
  }

  @Post(':key/links')
  @RequirePermission('tickets:work')
  addLink(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: LinkDto,
  ) {
    return this.tickets.addLink(principal, ctx, key, dto.to_ticket_id, dto.type);
  }

  @Delete(':key/links/:linkId')
  @HttpCode(204)
  @RequirePermission('tickets:work')
  removeLink(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.tickets.removeLink(principal, ctx, key, linkId);
  }

  @Put(':key/watchers/me')
  @RequirePermission('tickets:view')
  watch(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body() dto: WatchDto) {
    return this.tickets.watch(principal, key, dto.muted);
  }
}
