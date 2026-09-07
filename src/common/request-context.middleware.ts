import { createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { RequestContext } from './auth/decorators.js';

/**
 * Attaches the request id (honouring an inbound `x-request-id` from the
 * load balancer), a daily-salted IP hash and a reduced user agent family
 * to every request, and echoes the id on the response so the browser's
 * telemetry can correlate its next event (Audit & Analytics 3, 5.2).
 */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.header('x-request-id');
  const requestId =
    inbound && /^[A-Za-z0-9._-]{8,128}$/.test(inbound) ? inbound : randomUUID();
  const context: RequestContext = {
    requestId,
    ipHash: hashIp(req.ip),
    userAgentFamily: userAgentFamily(req.header('user-agent')),
  };
  (req as Request & { requestContext: RequestContext }).requestContext =
    context;
  res.setHeader('x-request-id', requestId);
  next();
}

function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.IP_HASH_SALT ?? 'local';
  return createHash('sha256')
    .update(`${salt}:${day}:${ip}`)
    .digest('hex')
    .slice(0, 32);
}

const FAMILIES: [RegExp, string][] = [
  [/Edg\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/Version\/(\d+).*Safari/, 'Safari'],
  [/curl\/(\d+)/, 'curl'],
  [/node/i, 'node'],
];

export function userAgentFamily(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  for (const [pattern, family] of FAMILIES) {
    const match = header.match(pattern);
    if (match) return match[1] ? `${family} ${match[1]}` : family;
  }
  return 'other';
}
