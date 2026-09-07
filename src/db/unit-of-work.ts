import { Injectable } from '@nestjs/common';
import type pg from 'pg';
import { bindingOf, dbRoleOf, type Principal } from '../common/auth/principal.js';
import { DbPools } from './pool.js';
import { withSession, type AccountBinding, type SessionContext } from './session.js';

/**
 * The service-facing entry to the data layer. A service never sees a pool;
 * it asks for a unit of work bound to a principal (the normal case), to the
 * operator scope (operator tables only, no account binding), or to an
 * explicit account set for the worker. The binding is derived from the
 * Principal here and nowhere else.
 */
export type Work<T> = (tx: pg.PoolClient) => Promise<T>;

@Injectable()
export class UnitOfWork {
  constructor(private readonly pools: DbPools) {}

  /** Bound to the principal's accounts, on the role its kind uses. */
  run<T>(principal: Principal, fn: Work<T>, context: Partial<SessionContext> = {}): Promise<T> {
    return withSession(this.pools, dbRoleOf(principal), { ...context, binding: bindingOf(principal) }, fn);
  }

  /**
   * Bound to the principal's accounts plus the given ones. Used only where a
   * principal legitimately acts on an account it is not yet granted, such
   * as creating that account's settings row in the same request.
   */
  runWithAccounts<T>(principal: Principal, extra: readonly string[], fn: Work<T>): Promise<T> {
    if (principal.kind === 'portal') throw new Error('Portal principals cannot widen their binding');
    const binding: AccountBinding = { kind: 'operator', accountIds: [...new Set([...principal.accountIds, ...extra])] };
    return withSession(this.pools, 'app', { binding }, fn);
  }

  /**
   * Portal writes. The portal database role is read-only by design (defence
   * in depth); a portal principal's writes run on the app role bound to
   * exactly its one account, through the same services internal users use,
   * with the actor recorded as the portal user.
   */
  portalWrite<T>(principal: Principal, fn: Work<T>): Promise<T> {
    if (principal.kind !== 'portal') throw new Error('portalWrite is for portal principals');
    const [accountId] = principal.accountIds;
    if (!accountId) throw new Error('Portal principal without an account');
    return withSession(this.pools, 'app', { binding: { kind: 'operator', accountIds: [accountId] } }, fn);
  }

  /** Operator tables only; account-scoped tables return nothing under this binding. */
  operator<T>(fn: Work<T>): Promise<T> {
    return withSession(this.pools, 'app', { binding: { kind: 'none' } }, fn);
  }

  /**
   * A request with no principal acting on accounts it named itself, such
   * as the survey link whose token is the credential: the app role bound to
   * exactly those accounts. Callers derive the ids from a security-definer
   * lookup, never from the request body.
   */
  system<T>(accountIds: readonly string[], fn: Work<T>): Promise<T> {
    return withSession(this.pools, 'app', { binding: { kind: 'operator', accountIds: [...accountIds] } }, fn);
  }

  /** Worker jobs bind the accounts of the work they claimed. */
  worker<T>(accountIds: readonly string[], fn: Work<T>): Promise<T> {
    return withSession(this.pools, 'worker', { binding: { kind: 'operator', accountIds: [...accountIds] } }, fn);
  }
}
