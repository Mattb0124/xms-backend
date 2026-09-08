import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentPrincipal, RequestCtx, RequirePermission, type RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { Public } from '../../common/auth/public.decorator.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { readCappedText } from '../../common/http/outbound.js';
import { loadEnv } from '../../config/env.js';
import { AttachmentsCoreModule } from '../attachments/attachments.module.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { EmailRepository } from './email.repository.js';
import { EmailService } from './email.service.js';
import { verifySnsMessage, type SnsMessage } from './sns-signature.js';

class CreateAliasDto {
  @IsEmail()
  @MaxLength(254)
  address!: string;

  @IsOptional()
  @IsIn(['canonical', 'alias'])
  kind?: string;

  @IsOptional()
  @IsIn(['incident', 'service_request', 'change', 'problem', 'project_task'])
  default_ticket_type?: string;
}

class DecideDto {
  @IsIn(['create_contact_and_ticket', 'create_ticket_once', 'discard', 'mark_spam'])
  decision!: string;
}

class IngestDto {
  /** The raw RFC 5322 message, base64 when `encoding` is base64. */
  @IsString()
  raw!: string;

  @IsOptional()
  @IsIn(['utf8', 'base64'])
  encoding?: 'utf8' | 'base64';
}

@ApiTags('email')
@ApiBearerAuth()
@Controller()
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @Get('admin/accounts/:id/aliases')
  @RequirePermission('admin:accounts')
  aliases(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.email.aliases(principal, id);
  }

  @Post('admin/accounts/:id/aliases')
  @RequirePermission('admin:accounts')
  createAlias(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAliasDto,
  ) {
    return this.email.createAlias(principal, ctx, id, dto);
  }

  @Post('admin/aliases/:id/enable')
  @RequirePermission('admin:accounts')
  enableAlias(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.email.setAliasState(principal, ctx, id, true);
  }

  @Post('admin/aliases/:id/disable')
  @RequirePermission('admin:accounts')
  disableAlias(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.email.setAliasState(principal, ctx, id, false);
  }

  @Get('quarantine')
  @RequirePermission('tickets:work')
  quarantine(@CurrentPrincipal() principal: Principal, @Query('state') state?: string) {
    return this.email.quarantine(principal, state === 'decided' ? 'decided' : 'open');
  }

  @Post('quarantine/:id/decide')
  @RequirePermission('tickets:work')
  decide(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideDto,
  ) {
    return this.email.decide(principal, ctx, id, dto.decision);
  }

  @Get('tickets/:key/email')
  @RequirePermission('tickets:view')
  thread(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.email.thread(principal, key);
  }

  @Get('email/inbound/:id/raw')
  @RequirePermission('tickets:view')
  raw(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.email.rawUrl(principal, ctx, id);
  }

  /** Development and test intake in place of the SES receipt rule; refused in production. */
  @Post('dev/email/inbound')
  @RequirePermission('admin:connectors')
  ingest(@Body() dto: IngestDto) {
    if (loadEnv().NODE_ENV === 'production') throw new ForbiddenException({ code: 'not_in_production' });
    const raw = Buffer.from(dto.raw, dto.encoding === 'base64' ? 'base64' : 'utf8');
    if (raw.length > 25 * 1024 * 1024) throw new BadRequestException({ code: 'too_large' });
    return this.email.processInbound(raw);
  }
}

/** SES events arrive through an SNS topic; the message signature is the credential. */
@Injectable()
export class SesWebhookService {
  constructor(
    private readonly email: EmailService,
    private readonly security: SecurityEventsService,
  ) {}

  private readonly certificates = new Map<string, string>();

  /** The URL is pinned to an AWS SNS host; the fetch is still bounded in time and in size, and cached per URL. */
  fetchCert: (url: string) => Promise<string> = async (url) => {
    const cached = this.certificates.get(url);
    if (cached) return cached;
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`certificate fetch failed with ${response.status}`);
    const pem = await readCappedText(response, 64 * 1024);
    if (this.certificates.size > 20) this.certificates.clear();
    this.certificates.set(url, pem);
    return pem;
  };

  trustUrl?: (url: string) => boolean;

  async handle(body: unknown, requestId: string | undefined): Promise<{ ok: true; matched?: boolean; state?: string }> {
    const message = body as SnsMessage;
    const valid =
      message &&
      typeof message.Message === 'string' &&
      (await verifySnsMessage(message, this.fetchCert, { trustUrl: this.trustUrl }));
    if (!valid) {
      await this.security.write({
        type: 'abuse.webhook.bad_signature',
        outcome: 'denied',
        actorKind: 'anonymous',
        requestId,
        attrs: { webhook: 'ses' },
      });
      throw new UnauthorizedException({ code: 'bad_signature' });
    }
    // The signature proves AWS sent it, not that we asked for it: anyone
    // can create a topic in their own account and subscribe this endpoint.
    const allowed = loadEnv().SES_SNS_TOPIC_ARNS;
    if (!message.TopicArn || !allowed.includes(message.TopicArn)) {
      await this.security.write({
        type: 'abuse.webhook.bad_signature',
        outcome: 'denied',
        actorKind: 'anonymous',
        requestId,
        attrs: { webhook: 'ses', reason: allowed.length === 0 ? 'no_topic_allowlist' : 'unknown_topic' },
      });
      throw new UnauthorizedException({ code: 'unknown_topic' });
    }
    if (message.Type === 'SubscriptionConfirmation') {
      // Confirmation is a deliberate administrator action (visit SubscribeURL); never auto-confirm.
      await this.security.write({
        type: 'admin.connector.mode_changed',
        outcome: 'withheld',
        actorKind: 'system',
        actorId: 'sns',
        requestId,
        attrs: { webhook: 'ses', subscription: 'confirmation_received' },
      });
      return { ok: true };
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(message.Message) as Record<string, unknown>;
    } catch {
      throw new BadRequestException({ code: 'bad_event' });
    }
    const applied = await this.email.applyDeliveryEvent(event as never);
    return { ok: true, ...applied };
  }
}

@ApiTags('webhooks')
@Controller('webhooks')
export class SesWebhookController {
  constructor(private readonly webhook: SesWebhookService) {}

  @Post('ses')
  @Public('SES event webhook: the SNS message signature is the credential, verified before any read')
  ses(@Body() body: unknown, @Headers('x-request-id') requestId?: string) {
    return this.webhook.handle(body, requestId);
  }
}

@Module({
  imports: [TicketsCoreModule, AttachmentsCoreModule],
  providers: [EmailRepository, EmailService, SesWebhookService],
  exports: [EmailService, EmailRepository, SesWebhookService],
})
export class EmailCoreModule {}

@Module({
  imports: [EmailCoreModule],
  controllers: [EmailController, SesWebhookController],
  exports: [EmailCoreModule],
})
export class EmailModule {}
