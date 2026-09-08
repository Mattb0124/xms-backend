import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Response } from 'express';
import {
  Authenticated,
  CurrentPrincipal,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { AI_CAPABILITIES, CUT_CAPABILITIES, REJECT_REASONS, type AiCapability } from '../../contracts/ai.js';
import { loadEnv } from '../../config/env.js';
import { ConfigService } from '../admin/config/config.service.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { AiRepository } from './ai.repository.js';
import { AiSettingsService } from './ai-settings.service.js';
import { AxelService } from './axel.service.js';
import { FetchHarnessClient, HARNESS_CLIENT, NoHarnessClient, type HarnessClient } from './harness-client.js';
import { SessionTokenService } from './session-token.service.js';
import { SuggestionService } from './suggestion.service.js';
import { MaxJsonSize } from '../../common/validation/max-json-size.js';

class TurnDto {
  @IsIn(['desk_assistant'])
  agent!: 'desk_assistant';

  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  message!: string;

  @IsUUID('4')
  ticket_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  thread_id?: string;
}

class SuggestDto {
  @IsIn(CUT_CAPABILITIES)
  capability!: AiCapability;

  @IsIn(['ticket'])
  target_kind!: 'ticket';

  @IsUUID('4')
  target_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instruction?: string;
}

class ProposeDto {
  @IsIn(CUT_CAPABILITIES)
  capability!: AiCapability;

  @IsIn(['ticket'])
  target_kind!: 'ticket';

  @IsUUID('4')
  target_id!: string;

  @IsObject()
  @MaxJsonSize()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  agent_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  thread_id?: string;
}

class DecisionDto {
  @IsIn(['accepted', 'edited_accepted', 'rejected'])
  decision!: 'accepted' | 'edited_accepted' | 'rejected';

  @IsOptional()
  @IsObject()
  @MaxJsonSize()
  applied_payload?: Record<string, unknown>;

  @IsOptional()
  @IsIn(REJECT_REASONS)
  reject_reason?: string;
}

class FeedbackDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

class AiSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  dpa_reference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  residency_region?: string;

  @IsOptional()
  @IsIn(['standard', 'strict'])
  redaction_profile?: 'standard' | 'strict';

  @IsOptional()
  @IsIn(['plain', 'formal'])
  draft_tone?: 'plain' | 'formal';

  @IsOptional()
  @IsObject()
  capabilities?: Record<string, Record<string, unknown>>;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  auto_apply_approval_ref?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

class DefaultsDto {
  @IsObject()
  @MaxJsonSize()
  body!: Record<string, unknown>;
}

class AccuracyQueryDto {
  @IsOptional()
  @IsUUID('4')
  account?: string;

  @IsOptional()
  @IsIn(AI_CAPABILITIES)
  capability?: AiCapability;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number;
}

@ApiTags('axel')
@ApiBearerAuth()
@Controller('axel')
export class AxelController {
  constructor(
    private readonly axel: AxelService,
    private readonly suggestions: SuggestionService,
  ) {}

  @Post('turns')
  @HttpCode(200)
  @RequirePermission('ai:use')
  turn(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: TurnDto,
    @Res() response: Response,
  ): Promise<void> {
    return this.axel.turn(principal, ctx, dto, response);
  }

  @Post('turns/:streamId/cancel')
  @RequirePermission('ai:use')
  cancel(@CurrentPrincipal() principal: Principal, @Param('streamId') streamId: string) {
    return this.axel.cancel(principal, streamId);
  }

  @Post('suggest')
  @RequirePermission('ai:use')
  suggest(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: SuggestDto) {
    return this.suggestions.suggest(principal, ctx, dto);
  }

  /** Written by the XMS MCP server's propose_* tools on behalf of the invoking user. */
  @Post('proposals')
  @RequirePermission('ai:use')
  propose(@CurrentPrincipal() principal: Principal, @RequestCtx() ctx: RequestContext, @Body() dto: ProposeDto) {
    return this.suggestions.propose(principal, ctx, dto);
  }

  @Get('suggestions')
  @RequirePermission('tickets:view')
  open(
    @CurrentPrincipal() principal: Principal,
    @Query('target_kind') targetKind: string,
    @Query('target_id') targetId: string,
    @Query('history') history?: string,
  ) {
    const kind = targetKind === 'ticket' ? 'ticket' : 'ticket';
    return history === 'true'
      ? this.suggestions.history(principal, kind, targetId ?? '')
      : this.suggestions.open(principal, kind, targetId ?? '');
  }

  @Post('suggestions/:id/decisions')
  @Authenticated()
  decide(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.suggestions.decide(principal, ctx, id, dto);
  }

  @Post('suggestions/:id/feedback')
  @RequirePermission('ai:use')
  feedback(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FeedbackDto) {
    return this.suggestions.feedback(principal, id, dto);
  }

  @Get('threads')
  @RequirePermission('ai:use')
  threads(@CurrentPrincipal() principal: Principal, @Query('ticket', ParseUUIDPipe) ticketId: string) {
    return this.axel.threads(principal, ticketId);
  }

  @Get('accuracy')
  @RequirePermission('ai:configure')
  accuracy(@CurrentPrincipal() principal: Principal, @Query() query: AccuracyQueryDto) {
    return this.suggestions.accuracy(principal, query);
  }
}

@ApiTags('axel')
@ApiBearerAuth()
@Controller()
export class AiSettingsController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly config: ConfigService,
  ) {}

  @Get('accounts/:id/ai-settings')
  @RequirePermission('ai:configure')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.settings.get(principal, id);
  }

  @Put('accounts/:id/ai-settings')
  @RequirePermission('ai:configure')
  update(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AiSettingsDto,
  ) {
    return this.settings.update(principal, ctx, id, dto);
  }

  @Get('axel/config/defaults')
  @RequirePermission('admin:config')
  defaults() {
    return this.config.describe('ai', '*');
  }

  @Put('axel/config/defaults')
  @RequirePermission('admin:config')
  async setDefaults(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Body() dto: DefaultsDto,
  ) {
    const draft = await this.config.createDraft(principal, ctx, 'ai', '*', dto.body);
    return this.config.activateVersion(principal, ctx, draft.id);
  }
}

export function harnessClientFromEnv(): HarnessClient {
  const env = loadEnv();
  return env.HARNESS_BASE_URL
    ? new FetchHarnessClient(env.HARNESS_BASE_URL, env.HARNESS_ORIGIN)
    : new NoHarnessClient();
}

/** Providers the worker needs: single-shot suggestions, intake, expiry. */
@Module({
  imports: [TicketsCoreModule],
  providers: [
    AiRepository,
    AiSettingsService,
    SessionTokenService,
    SuggestionService,
    { provide: HARNESS_CLIENT, useFactory: harnessClientFromEnv },
  ],
  exports: [AiRepository, AiSettingsService, SessionTokenService, SuggestionService, HARNESS_CLIENT, TicketsCoreModule],
})
export class AiCoreModule {}

@Module({
  imports: [AiCoreModule, TelemetryModule],
  controllers: [AxelController, AiSettingsController],
  providers: [AxelService],
  exports: [AiCoreModule],
})
export class AiModule {}
