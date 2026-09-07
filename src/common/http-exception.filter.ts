import { ArgumentsHost, Catch, ConflictException, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { StaleVersionError } from '../db/repository.base.js';
import { LastAdministratorError } from '../domain/identity/last-admin.js';
import type { RequestContext } from './auth/decorators.js';

/**
 * Errors carry codes, never stack traces or internal names, to clients
 * (security definition of done). Data-layer errors are mapped to typed
 * statuses: optimistic version to 409 stale_version, unique violation to
 * 409 conflict, RLS insert refusal to 404 (the row is invisible, not
 * forbidden), anything else to a 500 with the request id for the logs.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<{ requestContext?: RequestContext }>();
    const requestId = request.requestContext?.requestId;

    const mapped = this.map(exception);
    if (mapped.status >= 500) {
      this.logger.error(
        `request ${requestId ?? 'unknown'} failed: ${(exception as Error)?.stack ?? String(exception)}`,
      );
    }
    response.status(mapped.status).json({ ...mapped.body, requestId });
  }

  private map(exception: unknown): { status: number; body: Record<string, unknown> } {
    if (exception instanceof StaleVersionError) {
      return { status: 409, body: { code: 'stale_version', entity: exception.entity, id: exception.id } };
    }
    if (exception instanceof LastAdministratorError) {
      return { status: 409, body: { code: 'last_administrator' } };
    }
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      const body =
        typeof payload === 'string'
          ? { code: codeFor(exception.getStatus()), message: payload }
          : normalise(payload as Record<string, unknown>, exception.getStatus());
      return { status: exception.getStatus(), body };
    }
    const pgCode = (exception as { code?: string })?.code;
    switch (pgCode) {
      case '23505':
        return { status: 409, body: { code: 'conflict', detail: (exception as { constraint?: string }).constraint } };
      case '23503':
        return { status: 404, body: { code: 'not_found' } };
      case '42501':
        return { status: 404, body: { code: 'not_found' } };
      case '23514':
        return { status: 400, body: { code: 'invalid', detail: (exception as { constraint?: string }).constraint } };
      default:
        return { status: 500, body: { code: 'internal_error' } };
    }
  }
}

function normalise(payload: Record<string, unknown>, status: number): Record<string, unknown> {
  if (typeof payload.code === 'string') return payload;
  // class-validator payloads arrive as { message: string[] , error, statusCode }
  if (Array.isArray(payload.message)) {
    return { code: 'validation_failed', details: payload.message };
  }
  return { code: codeFor(status), message: payload.message ?? payload.error };
}

function codeFor(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}

export function conflict(code: string, extra: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({ code, ...extra });
}
