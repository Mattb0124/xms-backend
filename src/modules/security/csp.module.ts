import { Controller, HttpCode, Module, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { RealmOf, RequestCtx, type RequestContext } from '../../common/auth/decorators.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { readRawBody } from '../../common/storage/storage.module.js';

/**
 * The CSP report endpoint (Security & Tenancy section 9; P1.8.1): both web
 * hosts send `report-uri` violations here. Public by design (a browser
 * report carries no token), rate limited by the public policy, body capped
 * and reduced to the directive facts before it becomes an
 * `abuse.csp_violation` security event, so the Security dashboard shows a
 * policy that is too tight or an injection attempt without any page
 * content reaching the log. Accepts the legacy `application/csp-report`
 * shape and the Reporting API `application/reports+json` list.
 */
const MAX_BYTES = 16 * 1024;
const MAX_REPORTS = 10;

export interface CspReport {
  readonly documentUri?: string;
  readonly violatedDirective?: string;
  readonly effectiveDirective?: string;
  readonly blockedUri?: string;
  readonly disposition?: string;
  readonly statusCode?: number;
}

function clip(value: unknown, max = 300): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/** Reduces either report shape to the directive facts; never the sample or the script text. */
export function parseCspReports(body: unknown): CspReport[] {
  const reports: CspReport[] = [];
  const one = (raw: Record<string, unknown>): void => {
    reports.push({
      documentUri: clip(raw['document-uri'] ?? raw.documentURL),
      violatedDirective: clip(raw['violated-directive'] ?? raw.effectiveDirective),
      effectiveDirective: clip(raw['effective-directive'] ?? raw.effectiveDirective),
      blockedUri: clip(raw['blocked-uri'] ?? raw.blockedURL),
      disposition: clip(raw.disposition),
      statusCode: typeof raw['status-code'] === 'number' ? raw['status-code'] : undefined,
    });
  };
  if (Array.isArray(body)) {
    for (const item of body.slice(0, MAX_REPORTS)) {
      const entry = item as { type?: string; body?: Record<string, unknown> };
      if (entry?.type === 'csp-violation' && entry.body && typeof entry.body === 'object') one(entry.body);
    }
  } else if (body && typeof body === 'object') {
    const legacy = (body as { 'csp-report'?: Record<string, unknown> })['csp-report'];
    if (legacy && typeof legacy === 'object') one(legacy);
  }
  return reports.filter((report) => report.violatedDirective || report.effectiveDirective);
}

@ApiTags('security')
@Controller('csp-report')
@RealmOf('any')
export class CspReportController {
  constructor(private readonly security: SecurityEventsService) {}

  @Post()
  @Public('csp-report')
  @HttpCode(204)
  async report(@Req() request: Request, @RequestCtx() ctx: RequestContext): Promise<void> {
    let body: unknown;
    try {
      const raw = await readRawBody(request, request.body, MAX_BYTES);
      body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      return;
    }
    for (const report of parseCspReports(body)) {
      await this.security.write({
        type: 'abuse.csp_violation',
        outcome: 'denied',
        actorKind: 'anonymous',
        actorId: 'anonymous',
        requestId: ctx.requestId,
        entityKind: 'csp',
        entityId: report.effectiveDirective ?? report.violatedDirective ?? 'unknown',
        attrs: {
          document_uri: report.documentUri,
          violated_directive: report.violatedDirective,
          blocked_uri: report.blockedUri,
          disposition: report.disposition,
          status_code: report.statusCode,
        },
        ipHash: ctx.ipHash,
        userAgentFamily: ctx.userAgentFamily,
      });
    }
  }
}

@Module({ controllers: [CspReportController] })
export class CspModule {}
