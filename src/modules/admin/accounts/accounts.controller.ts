import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../../common/auth/decorators.js';
import type { Principal } from '../../../common/auth/principal.js';
import { CreateAccountDto, ListQueryDto, UpdateAccountDto, UpdateAccountSettingsDto } from './accounts.dto.js';
import { AccountsService } from './accounts.service.js';

/** Thin: DTO in, one service call, result out (Accounts & Administration technical 4). */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/accounts')
@RequirePermission('admin:accounts')
export class AdminAccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal, @Query() query: ListQueryDto) {
    return this.accounts.list(principal, query);
  }

  @Post()
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateAccountDto) {
    return this.accounts.create(principal, ctx, dto);
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.get(principal, id);
  }

  @Patch(':id')
  update(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountDto,
  ) {
    return this.accounts.update(principal, ctx, id, dto);
  }

  @Post(':id/activate')
  activate(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.transition(principal, ctx, id, 'active');
  }

  @Post(':id/suspend')
  suspend(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.transition(principal, ctx, id, 'suspended');
  }

  @Post(':id/offboard')
  offboard(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.transition(principal, ctx, id, 'offboarding');
  }

  @Get(':id/settings')
  settings(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.settings(principal, id);
  }

  @Put(':id/settings')
  updateSettings(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccountSettingsDto,
  ) {
    return this.accounts.updateSettings(principal, ctx, id, dto);
  }
}

/** Non-admin read: the granted accounts summary for pickers. */
@ApiTags('accounts')
@ApiBearerAuth()
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @RequirePermission('tickets:view')
  granted(@CurrentPrincipal() principal: Principal) {
    return this.accounts.granted(principal);
  }
}
