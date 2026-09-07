import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import {
  CreateTicketDto,
  LinkDto,
  ListTicketsQueryDto,
  MessageDto,
  PatchTicketDto,
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
