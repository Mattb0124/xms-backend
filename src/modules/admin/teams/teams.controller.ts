import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../../common/auth/decorators.js';
import type { Principal } from '../../../common/auth/principal.js';
import {
  CreateTeamDto,
  SetTeamAccountsDto,
  SetTeamMembersDto,
  TeamsQueryDto,
  UpdateTeamDto,
} from './teams.dto.js';
import { TeamsService } from './teams.service.js';

/**
 * Teams (TM-23). `admin:users` is the permission: a team is people and the
 * accounts they answer for, which is the same administration surface as
 * users, roles, grants and groups.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/teams')
@RequirePermission('admin:users')
export class AdminTeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  list(@Query() query: TeamsQueryDto) {
    return this.teams.list(query);
  }

  @Post()
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateTeamDto) {
    return this.teams.create(principal, ctx, dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.teams.get(id);
  }

  @Patch(':id')
  update(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.teams.update(principal, ctx, id, dto);
  }

  @Put(':id/members')
  setMembers(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTeamMembersDto,
  ) {
    return this.teams.setMembers(principal, ctx, id, dto);
  }

  @Put(':id/accounts')
  setAccounts(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTeamAccountsDto,
  ) {
    return this.teams.setAccounts(principal, ctx, id, dto);
  }
}
