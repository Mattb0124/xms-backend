import type { LoggerService, LogLevel } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { RequestContext } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.js';
import type { Env } from '../../config/env.js';

/**
 * Structured logging (Platform & Operations section 5; P1.7.5 cut to the
 * application side): one JSON line per event with the service, version,
 * level and context, so CloudWatch Logs Insights can query by request id,
 * account or actor. Secrets are redacted by path. Nest's own logger is
 * routed through the same pino instance, and the HTTP access line carries
 * the request id from the request context plus the principal once the
 * guard has resolved it.
 */
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.authorization',
  '*.password',
  '*.secret',
  '*.token',
  '*.api_key',
];

export function createLogger(
  env: Pick<Env, 'LOG_LEVEL' | 'APP_VERSION' | 'NODE_ENV'>,
  service: string,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: env.LOG_LEVEL,
      base: { service, version: env.APP_VERSION, env: env.NODE_ENV },
      redact: { paths: REDACT, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

/** Adapts pino to Nest's LoggerService so framework and module logs share one stream. */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('trace', message, context);
  }

  setLogLevels(levels: LogLevel[]): void {
    const lowest = levels.includes('verbose')
      ? 'trace'
      : levels.includes('debug')
        ? 'debug'
        : levels.includes('log')
          ? 'info'
          : levels.includes('warn')
            ? 'warn'
            : 'error';
    this.logger.level = lowest;
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
    message: unknown,
    context?: string,
    trace?: string,
  ): void {
    const fields: Record<string, unknown> = {};
    if (context) fields.context = context;
    if (trace) fields.stack = trace;
    if (message instanceof Error) {
      this.logger[level]({ ...fields, err: message }, message.message);
      return;
    }
    if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, ...(message as Record<string, unknown>) });
      return;
    }
    this.logger[level](fields, String(message));
  }
}

const QUIET = ['/healthz', '/readyz'];

/** One access line per request, after the response, without the health probes. */
export function httpLogger(logger: Logger) {
  return (
    req: Request & { requestContext?: RequestContext; principal?: Principal },
    res: Response,
    next: NextFunction,
  ): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (QUIET.some((path) => req.path.endsWith(path))) return;
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const principal = req.principal;
      const line = {
        request_id: req.requestContext?.requestId,
        method: req.method,
        path: req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : req.path,
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 10) / 10,
        principal_kind: principal?.kind,
        user_id: principal?.userId,
        user_agent: req.requestContext?.userAgentFamily,
      };
      if (res.statusCode >= 500) logger.error(line, 'request failed');
      else if (res.statusCode >= 400) logger.warn(line, 'request denied');
      else logger.info(line, 'request');
    });
    next();
  };
}
