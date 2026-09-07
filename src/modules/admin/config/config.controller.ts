import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import {
  CurrentPrincipal,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../../common/auth/decorators.js';
import type { Principal } from '../../../common/auth/principal.js';
import { CONFIG_KINDS, ConfigService, type ConfigKind } from './config.service.js';

class CreateVersionDto {
  @IsObject()
  body!: Record<string, unknown>;
}

function kindOf(value: string): ConfigKind {
  if (!(CONFIG_KINDS as readonly string[]).includes(value))
    throw new BadRequestException({ code: 'unknown_config_kind', kind: value });
  return value as ConfigKind;
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/config')
@RequirePermission('admin:config')
export class AdminConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get(':kind')
  describe(@Param('kind') kind: string, @Query('scope') scope?: string) {
    return this.config.describe(kindOf(kind), scope ?? '*');
  }

  @Post(':kind/versions')
  createDraft(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('kind') kind: string,
    @Query('scope') scope: string | undefined,
    @Body() dto: CreateVersionDto,
  ) {
    return this.config.createDraft(principal, ctx, kindOf(kind), scope ?? '*', dto.body);
  }

  @Post(':kind/versions/:id/activate')
  activate(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.config.activateVersion(principal, ctx, id);
  }
}

/** Account overrides of the catalogs (Accounts & Administration technical 3.4; P2.9.2). */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('accounts/:id/config')
@RequirePermission('admin:config')
export class AccountConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get(':kind')
  describe(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Query('scope') scope?: string,
  ) {
    return this.config.describeForAccount(principal, id, kindOf(kind), scope ?? '*');
  }

  @Put(':kind/override')
  setOverride(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Query('scope') scope: string | undefined,
    @Body() dto: CreateVersionDto,
  ) {
    return this.config.setOverride(principal, ctx, id, kindOf(kind), scope ?? '*', dto.body);
  }

  @Delete(':kind/override')
  @HttpCode(200)
  removeOverride(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Query('scope') scope?: string,
  ) {
    return this.config.removeOverride(principal, ctx, id, kindOf(kind), scope ?? '*');
  }
}
