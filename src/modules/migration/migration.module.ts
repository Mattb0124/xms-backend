import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { StorageCoreModule } from '../../common/storage/storage.module.js';
import { ConnectorsCoreModule } from '../connectors/connectors.module.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { MigrationRepository } from './migration.repository.js';
import { MigrationService } from './migration.service.js';

class CreateBatchDto {
  @IsUUID('4') account_id!: string;
  @IsUUID('4') instance_id!: string;
  @IsOptional() @IsIn(['case']) object_kind?: 'case';
  @Matches(/^\d{4}-\d{2}-\d{2}$/) opened_from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) opened_to!: string;
  @IsOptional() @IsBoolean() dry_run?: boolean;
  @IsOptional() @IsUUID('4') supersedes_batch_id?: string;
}

class ExplainDto {
  @IsString() @MinLength(3) @MaxLength(2000) explanation!: string;
  @IsInt() @Min(1) version!: number;
}

class SignOffDto {
  @IsInt() @Min(1) version!: number;
}

/**
 * Migration routes (Data Migration technical section 4; P2.22.1 cut):
 * batches, records, reconciliation. Thin: DTO, one service call, response.
 */
@ApiTags('migration')
@ApiBearerAuth()
@Controller('migration')
@RequirePermission('admin:migration')
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  @Get('batches')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('account_id') accountId?: string,
    @Query('object_kind') objectKind?: string,
    @Query('status') status?: string,
  ) {
    return this.migration.list(principal, { account_id: accountId, object_kind: objectKind, status });
  }

  @Post('batches')
  create(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: CreateBatchDto) {
    return this.migration.create(principal, ctx, dto);
  }

  @Get('batches/:id')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.migration.get(principal, id);
  }

  @Post('batches/:id/run')
  run(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.migration.run(principal, ctx, id);
  }

  @Get('batches/:id/records')
  records(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    return this.migration.records(principal, id, { status, q });
  }

  @Get('batches/:id/records/:recordId')
  record(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
  ) {
    return this.migration.record(principal, id, recordId);
  }

  @Get('reconciliation')
  reports(
    @CurrentPrincipal() principal: Principal,
    @Query('account_id', ParseUUIDPipe) accountId: string,
    @Query('scope') scope?: string,
  ) {
    return this.migration.reports(principal, accountId, scope);
  }

  @Post('reconciliation/:id/lines/:line/explain')
  explain(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('line') line: string,
    @Body() dto: ExplainDto,
  ) {
    return this.migration.explain(principal, ctx, id, Number(line), dto);
  }

  @Post('reconciliation/:id/sign-off')
  signOff(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignOffDto,
  ) {
    return this.migration.signOff(principal, ctx, id, dto.version);
  }
}

@Module({
  imports: [ConnectorsCoreModule, TicketsCoreModule, StorageCoreModule],
  providers: [MigrationRepository, MigrationService],
  exports: [MigrationRepository, MigrationService],
})
export class MigrationCoreModule {}

@Module({
  imports: [MigrationCoreModule],
  controllers: [MigrationController],
  exports: [MigrationCoreModule],
})
export class MigrationModule {}
