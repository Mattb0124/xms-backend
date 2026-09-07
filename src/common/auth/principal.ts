import type { Permission } from '../../contracts/permissions.js';
import type { AccountBinding } from '../../db/session.js';

/**
 * The one identity object every handler receives (Security & Tenancy 2.2).
 * Resolved once per request by the guard from a verified token and the
 * operator tables; never from a header, a body or a query string.
 */
export type PrincipalKind = 'internal' | 'portal' | 'api_client' | 'harness';

export interface Principal {
  readonly kind: PrincipalKind;
  /** op.users.id */
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  /** Accounts the principal may see. Portal principals have exactly one. */
  readonly accountIds: readonly string[];
  /** Transitive closure of the role permissions (and API client scopes). */
  readonly permissions: ReadonlySet<Permission>;
  /** Clerk session id, harness session id or the API client id. */
  readonly sessionId?: string;
  readonly tokenType: 'clerk' | 'clerk_agents' | 'harness' | 'api_key' | 'dev';
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
}

export function actorKindOf(principal: Principal): 'user' | 'portal_user' | 'api_client' {
  switch (principal.kind) {
    case 'portal':
      return 'portal_user';
    case 'api_client':
      return 'api_client';
    default:
      return 'user';
  }
}

/** The database binding derived from the principal; the only input to withSession. */
export function bindingOf(principal: Principal): AccountBinding {
  if (principal.kind === 'portal') {
    const [accountId] = principal.accountIds;
    if (!accountId) return { kind: 'none' };
    return { kind: 'portal', accountId };
  }
  return { kind: 'operator', accountIds: [...principal.accountIds] };
}

/** The database role a principal's unit of work runs under. */
export function dbRoleOf(principal: Principal): 'app' | 'portal' {
  return principal.kind === 'portal' ? 'portal' : 'app';
}
