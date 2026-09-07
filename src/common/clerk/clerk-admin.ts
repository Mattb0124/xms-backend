import { Injectable, Logger } from '@nestjs/common';

/**
 * The Clerk Backend API surface XMS uses (Accounts & Administration
 * technical 3.3): invitations for pre-invited users, organisations per
 * account. When no secret key is configured (local development, tests) the
 * adapter records intent and does nothing, and the user row stays
 * `invited` until first sign-in binds the Clerk subject by email.
 */
export interface ClerkAdmin {
  createInvitation(email: string, redirectUrl?: string): Promise<{ id: string } | undefined>;
  ensureOrganisation(slug: string, name: string): Promise<{ id: string } | undefined>;
  revokeSessions(clerkUserId: string): Promise<void>;
}

@Injectable()
export class ClerkAdminClient implements ClerkAdmin {
  private readonly logger = new Logger(ClerkAdminClient.name);

  constructor(
    private readonly secretKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return Boolean(this.secretKey);
  }

  async createInvitation(email: string, redirectUrl?: string): Promise<{ id: string } | undefined> {
    if (!this.secretKey) {
      this.logger.log(`clerk disabled: invitation for ${email} not sent`);
      return undefined;
    }
    const response = await this.call('/v1/invitations', {
      email_address: email,
      redirect_url: redirectUrl,
      notify: true,
    });
    return { id: String(response.id) };
  }

  async ensureOrganisation(slug: string, name: string): Promise<{ id: string } | undefined> {
    if (!this.secretKey) return undefined;
    const response = await this.call('/v1/organizations', { name, slug });
    return { id: String(response.id) };
  }

  async revokeSessions(clerkUserId: string): Promise<void> {
    if (!this.secretKey) return;
    await this.call(`/v1/users/${encodeURIComponent(clerkUserId)}/sessions/revoke_all`, {});
  }

  private async call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`https://api.clerk.com${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Clerk ${path} failed with ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
