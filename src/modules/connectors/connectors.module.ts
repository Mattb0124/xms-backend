import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { join } from 'node:path';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { loadEnv } from '../../config/env.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { ConnectorsRepository } from './connectors.repository.js';
import { ConnectorsService } from './connectors.service.js';
import { LocalSecretsProvider, SECRETS_PROVIDER, type SecretsProvider } from './secrets.js';
import { SnowClientFactory } from './snow-client.factory.js';
import { SyncWorker } from './sync.worker.js';

class CredentialDto {
  @IsOptional() @IsString() @MaxLength(200) username?: string;
  @IsOptional() @IsString() @MaxLength(500) password?: string;
  @IsOptional() @IsString() @MaxLength(200) client_id?: string;
  @IsOptional() @IsString() @MaxLength(500) client_secret?: string;
}

/**
 * A ServiceNow table name is an identifier, never a path. Without this a
 * `table_name` of "incident/../../../api/now/attachment" normalises through
 * `new URL(path, baseUrl)` into a different REST endpoint, and one carrying
 * "?sysparm_fields=..." injects query parameters the client only partly
 * overrides.
 */
export const TABLE_NAME = /^[a-z][a-z0-9_]{0,79}$/;

class CreateInstanceDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsString() @MaxLength(2000) base_url!: string;
  @IsIn(['basic', 'oauth_client_credentials']) auth_kind!: 'basic' | 'oauth_client_credentials';
  @ValidateNested() @Type(() => CredentialDto) credential!: CredentialDto;
  @IsOptional() @Matches(TABLE_NAME) table_name?: string;
  @IsOptional() @IsIn(['csm', 'itsm']) profile?: 'csm' | 'itsm';
  @IsOptional() @IsInt() @Min(10) @Max(86400) poll_interval_seconds?: number;
}

class ThresholdDto {
  @IsNumber() @Min(0) @Max(1) ratio!: number;
  @IsInt() @Min(1) @Max(1440) window_minutes!: number;
  @IsInt() @Min(1) min_attempts!: number;
}

class UpdateInstanceDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsIn(['off', 'ingest_only', 'bidirectional']) mode?: 'off' | 'ingest_only' | 'bidirectional';
  @IsOptional() @IsInt() @Min(10) @Max(86400) poll_interval_seconds?: number;
  @IsOptional() @IsIn(['comments', 'work_notes']) journal_public?: string;
  @IsOptional() @IsBoolean() sync_work_notes?: boolean;
  @IsOptional() @IsInt() @Min(0) attachment_limit_bytes?: number;
  @IsOptional() @IsIn(['link', 'skip']) attachment_over_limit?: 'link' | 'skip';
  @IsOptional() @ValidateNested() @Type(() => ThresholdDto) error_trip_threshold?: ThresholdDto;
  @IsOptional() @Matches(TABLE_NAME) table_name?: string;
}

class MapBodyDto {
  /** Field map: an entries array; state map: an object per ticket type. */
  @IsOptional() entries?: unknown;
}

class KillSwitchDto {
  @IsIn(['trip', 'arm']) action!: 'trip' | 'arm';
  /** Required to trip (at least three characters); optional to arm. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class WatermarkDto {
  @IsString() to!: string;
  @IsOptional() @IsBoolean() preview?: boolean;
}

class DeadLetterActionDto {
  @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) ids!: string[];
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class SamplesDto {
  @IsOptional() @IsUUID('4') map_id?: string;
}

function kindOf(value: string): 'field' | 'state' {
  if (value === 'field-maps') return 'field';
  if (value === 'state-maps') return 'state';
  throw new NotFoundException({ code: 'not_found', entity: 'route' });
}

@ApiTags('connectors')
@ApiBearerAuth()
@Controller()
@RequirePermission('admin:connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get('accounts/:id/connectors')
  list(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.connectors.list(principal, id);
  }

  @Post('accounts/:id/connectors/servicenow')
  create(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateInstanceDto,
  ) {
    return this.connectors.create(principal, ctx, id, dto);
  }

  @Get('connectors/health')
  health(@CurrentPrincipal() principal: Principal) {
    return this.connectors.health(principal);
  }

  @Get('connectors/:instanceId')
  get(@CurrentPrincipal() principal: Principal, @Param('instanceId', ParseUUIDPipe) instanceId: string) {
    return this.connectors.get(principal, instanceId);
  }

  @Patch('connectors/:instanceId')
  update(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() dto: UpdateInstanceDto,
  ) {
    return this.connectors.update(principal, ctx, instanceId, dto);
  }

  @Post('connectors/:instanceId/test-connection')
  testConnection(@CurrentPrincipal() principal: Principal, @Param('instanceId', ParseUUIDPipe) instanceId: string) {
    return this.connectors.testConnection(principal, instanceId);
  }

  @Post('connectors/:instanceId/samples')
  samples(
    @CurrentPrincipal() principal: Principal,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() dto: SamplesDto,
  ) {
    return this.connectors.samples(principal, instanceId, dto.map_id);
  }

  @Post('connectors/:instanceId/kill-switch')
  killSwitch(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() dto: KillSwitchDto,
  ) {
    if (dto.action === 'trip' && (dto.reason ?? '').trim().length < 3)
      throw new BadRequestException({ code: 'reason_required' });
    return this.connectors.killSwitch(principal, ctx, instanceId, dto.action, dto.reason ?? '');
  }

  @Post('connectors/:instanceId/watermark')
  watermark(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() dto: WatermarkDto,
  ) {
    return this.connectors.watermark(principal, ctx, instanceId, dto);
  }

  @Get('connectors/:instanceId/runs')
  runs(
    @CurrentPrincipal() principal: Principal,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Query('direction') direction?: string,
    @Query('outcome') outcome?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.connectors.runs(principal, instanceId, {
      direction,
      outcome,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('connectors/:instanceId/dead-letters')
  deadLetters(
    @CurrentPrincipal() principal: Principal,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Query('resolution') resolution?: string,
  ) {
    return this.connectors.deadLetters(principal, instanceId, resolution);
  }

  @Post('connectors/:instanceId/dead-letters/replay')
  replay(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() dto: DeadLetterActionDto,
  ) {
    return this.connectors.resolveDeadLetters(principal, ctx, instanceId, dto.ids, 'replay', dto.reason ?? null);
  }

  @Post('connectors/:instanceId/dead-letters/discard')
  discard(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Body() dto: DeadLetterActionDto,
  ) {
    return this.connectors.resolveDeadLetters(principal, ctx, instanceId, dto.ids, 'discard', dto.reason ?? null);
  }

  // Map routes last: `:kind` is generic and must not shadow the named routes above.
  @Get('connectors/:instanceId/:kind')
  maps(
    @CurrentPrincipal() principal: Principal,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Param('kind') kind: string,
  ) {
    return this.connectors.maps(principal, kindOf(kind), instanceId);
  }

  @Post('connectors/:instanceId/:kind')
  createMap(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Param('kind') kind: string,
    @Body() dto: MapBodyDto,
  ) {
    return this.connectors.createMap(principal, ctx, kindOf(kind), instanceId, dto.entries);
  }

  @Put('connectors/:instanceId/:kind/:mapId')
  updateMap(
    @CurrentPrincipal() principal: Principal,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Param('kind') kind: string,
    @Param('mapId', ParseUUIDPipe) mapId: string,
    @Body() dto: MapBodyDto,
  ) {
    return this.connectors.updateMap(principal, kindOf(kind), instanceId, mapId, dto.entries);
  }

  @Post('connectors/:instanceId/:kind/:mapId/validate')
  validateMap(
    @CurrentPrincipal() principal: Principal,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Param('kind') kind: string,
    @Param('mapId', ParseUUIDPipe) mapId: string,
  ) {
    return this.connectors.validateMap(principal, kindOf(kind), instanceId, mapId);
  }

  @Post('connectors/:instanceId/:kind/:mapId/activate')
  activateMap(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('instanceId', ParseUUIDPipe) instanceId: string,
    @Param('kind') kind: string,
    @Param('mapId', ParseUUIDPipe) mapId: string,
  ) {
    return this.connectors.activateMap(principal, ctx, kindOf(kind), instanceId, mapId);
  }
}

@ApiTags('connectors')
@ApiBearerAuth()
@Controller('tickets')
export class TicketSyncController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get(':id/sync')
  @RequirePermission('tickets:view')
  sync(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.connectors.ticketSync(principal, id);
  }
}

export function secretsProviderFromEnv(): SecretsProvider {
  const env = loadEnv();
  return new LocalSecretsProvider(join(env.STORAGE_LOCAL_ROOT));
}

@Module({
  imports: [TicketsCoreModule],
  providers: [
    ConnectorsRepository,
    ConnectorsService,
    SnowClientFactory,
    SyncWorker,
    { provide: SECRETS_PROVIDER, useFactory: secretsProviderFromEnv },
  ],
  exports: [ConnectorsRepository, ConnectorsService, SnowClientFactory, SyncWorker, SECRETS_PROVIDER],
})
export class ConnectorsCoreModule {}

@Module({
  imports: [ConnectorsCoreModule],
  controllers: [ConnectorsController, TicketSyncController],
  exports: [ConnectorsCoreModule],
})
export class ConnectorsModule {}
