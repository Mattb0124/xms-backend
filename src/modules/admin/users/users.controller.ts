import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../../common/auth/decorators.js';
import type { Principal } from '../../../common/auth/principal.js';
import { describeCatalog, type Catalog } from '../../../contracts/permissions.js';
import {
  CreateGroupDto,
  CreateRoleDto,
  InviteUserDto,
  ReplaceGranteesDto,
  ReplaceGrantsDto,
  ReplaceMembersDto,
  ReplaceRolesDto,
  UpdateGroupDto,
  UpdateRoleDto,
  UpdateUserDto,
  UsersQueryDto,
} from './users.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@RequirePermission('admin:users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  list(@Query() query: UsersQueryDto) {
    return this.users.list(query);
  }

  @Post('users')
  invite(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: InviteUserDto) {
    return this.users.invite(principal, ctx, dto, 'internal');
  }

  @Get('users/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Patch('users/:id')
  update(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(principal, ctx, id, dto);
  }

  @Put('users/:id/roles')
  roles(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceRolesDto,
  ) {
    return this.users.replaceRoles(principal, ctx, id, dto);
  }

  @Put('users/:id/grants')
  grants(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceGrantsDto,
  ) {
    return this.users.replaceGrants(principal, ctx, id, dto);
  }

  @Get('accounts/:id/grants')
  grantees(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.grantees(id);
  }

  @Put('accounts/:id/grants')
  replaceGrantees(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceGranteesDto,
  ) {
    return this.users.replaceGrantees(principal, ctx, id, dto);
  }

  @Get('accounts/:id/portal-users')
  portalUsers(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.portalUsers(id);
  }

  @Post('accounts/:id/portal-users')
  invitePortalUser(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteUserDto,
  ) {
    return this.users.invite(principal, ctx, dto, 'portal', id);
  }

  @Get('roles')
  listRoles(@Query('catalog') catalog?: string) {
    return this.users.roles(catalog === 'portal' || catalog === 'operator' ? catalog : undefined);
  }

  @Post('roles')
  createRole(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateRoleDto) {
    return this.users.createRole(principal, ctx, dto);
  }

  @Get('roles/:id')
  role(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.role(id);
  }

  @Patch('roles/:id')
  updateRole(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.users.updateRole(principal, ctx, id, dto);
  }

  @Get('permissions')
  permissions(@Query('catalog') catalog?: string) {
    return describeCatalog((catalog === 'portal' ? 'portal' : 'operator') as Catalog);
  }

  @Get('groups')
  groups() {
    return this.users.groups();
  }

  @Post('groups')
  createGroup(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: CreateGroupDto,
  ) {
    return this.users.createGroup(principal, ctx, dto);
  }

  @Get('groups/:id')
  group(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.group(id);
  }

  @Patch('groups/:id')
  updateGroup(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.users.updateGroup(principal, ctx, id, dto);
  }

  @Put('groups/:id/members')
  members(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceMembersDto,
  ) {
    return this.users.replaceMembers(principal, ctx, id, dto);
  }
}

/** Non-admin pickers used by the desk. */
@ApiTags('directory')
@ApiBearerAuth()
@Controller()
@RequirePermission('tickets:view')
export class DirectoryController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  assignable() {
    return this.users.assignable();
  }

  @Get('groups')
  groups() {
    return this.users.groups();
  }
}
