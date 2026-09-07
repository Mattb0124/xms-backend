import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Principal } from '../../common/auth/principal.js';
import { loadEnv } from '../../config/env.js';
import { HarnessUnavailableError } from './harness-client.js';

/**
 * Harness session tokens (AI Integration section 2). The design called for
 * exchanging the user's Clerk token at `POST /api/auth/session`; that only
 * works when the harness trusts the XMS Clerk application, which it does
 * not (ADR-03 keeps XMS on its own application). XMS therefore mints the
 * HS256 session token itself with the shared HARNESS_SESSION_SECRET, the
 * same secret the harness uses to mint tokens for MCP servers, with the
 * same claim shape (`type: session`, tenant from `org_slug`). Tokens live
 * eight hours and are cached per user until one hour before expiry; the
 * identity inside is always the calling XMS user, never a service account,
 * so the harness and the XMS MCP server see the same person.
 */
const LIFETIME_SECONDS = 8 * 3600;
const REFRESH_MARGIN_SECONDS = 3600;

@Injectable()
export class SessionTokenService {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  async tokenFor(principal: Pick<Principal, 'userId' | 'email' | 'displayName'>): Promise<string> {
    const env = loadEnv();
    if (!env.HARNESS_SESSION_SECRET) throw new HarnessUnavailableError(0, 'HARNESS_SESSION_SECRET is not configured');
    const now = Math.floor(Date.now() / 1000);
    const cached = this.cache.get(principal.userId);
    if (cached && cached.expiresAt - REFRESH_MARGIN_SECONDS > now) return cached.token;
    const expiresAt = now + LIFETIME_SECONDS;
    const token = await new SignJWT({
      email: principal.email,
      name: principal.displayName,
      org_slug: env.HARNESS_TENANT_SLUG ?? env.CLERK_INTERNAL_ORG_SLUG,
      type: 'session',
      session_id: `xms_${randomUUID()}`,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(principal.userId)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(new TextEncoder().encode(env.HARNESS_SESSION_SECRET));
    this.cache.set(principal.userId, { token, expiresAt });
    return token;
  }

  /** Drops a cached token after the harness rejected it (secret rotation). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
