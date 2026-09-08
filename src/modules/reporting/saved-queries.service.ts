import { ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestContext } from '../../common/auth/decorators.js';
import { hasPermission, type Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { translateEvents, type EventCondition } from './audit-search.js';
import { ReportingService } from './reporting.service.js';
import { SavedQueriesRepository, type SavedQueryRow } from './saved-queries.repository.js';

export interface SavedQueryInput {
  readonly name: string;
  readonly description?: string;
  readonly shared?: boolean;
  readonly conditions: readonly EventCondition[];
}

export interface SavedQueryPatch {
  readonly name?: string;
  readonly description?: string;
  readonly shared?: boolean;
  readonly conditions?: readonly EventCondition[];
}

/**
 * Saved queries for the audit search (Audit & Analytics 7.1). A saved query
 * is a named condition set and nothing else; running one is the ordinary
 * search under the caller's own grants, so two readers running the same
 * shared query see their own accounts' events.
 *
 * Two rules make that safe. Conditions are validated with `translateEvents`
 * on every save, the one place a condition is judged, so a saved query can
 * never hold a condition the search would refuse (a query saved before a
 * field was withdrawn would otherwise fail at run time instead of at save
 * time). And sharing needs `audit:export`: the specification names no
 * permission for a shared query, so it takes the one that already governs
 * putting audit rows in front of other people, which `audit:read` does not
 * imply.
 */
@Injectable()
export class SavedQueriesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly queries: SavedQueriesRepository,
    private readonly reporting: ReportingService,
    private readonly audit: AuditService,
  ) {}

  list(principal: Principal): Promise<SavedQueryRow[]> {
    return this.uow.run(principal, (tx) => this.queries.visible(tx, principal.userId));
  }

  get(principal: Principal, id: string): Promise<SavedQueryRow> {
    return this.uow.run(principal, (tx) => this.queries.readable(tx, id, principal.userId));
  }

  create(principal: Principal, ctx: RequestContext, input: SavedQueryInput): Promise<SavedQueryRow> {
    const conditions = this.validated(input.conditions);
    const shared = this.sharing(principal, input.shared ?? false);
    return this.uow.run(principal, async (tx) => {
      const row = await this.queries.insert(tx, {
        name: input.name,
        description: input.description ?? '',
        ownerUserId: principal.userId,
        shared,
        conditions,
      });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'audit_saved_query',
          entityId: row.id,
          eventType: 'created',
          newValue: { name: row.name, shared: row.shared, conditions: row.conditions },
        },
      ]);
      return row;
    });
  }

  update(principal: Principal, ctx: RequestContext, id: string, patch: SavedQueryPatch): Promise<SavedQueryRow> {
    const conditions = patch.conditions === undefined ? undefined : this.validated(patch.conditions);
    if (patch.shared !== undefined) this.sharing(principal, patch.shared);
    return this.uow.run(principal, async (tx) => {
      const before = await this.queries.owned(tx, id, principal.userId);
      const row = await this.queries.update(tx, id, principal.userId, {
        name: patch.name,
        description: patch.description,
        shared: patch.shared,
        conditions,
      });
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'audit_saved_query',
          entityId: row.id,
          eventType: 'updated',
          oldValue: { name: before.name, shared: before.shared, conditions: before.conditions },
          newValue: { name: row.name, shared: row.shared, conditions: row.conditions },
        },
      ]);
      return row;
    });
  }

  remove(principal: Principal, ctx: RequestContext, id: string): Promise<{ deleted: true }> {
    return this.uow.run(principal, async (tx) => {
      const row = await this.queries.owned(tx, id, principal.userId);
      await this.queries.remove(tx, id, principal.userId);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: 'audit_saved_query',
          entityId: id,
          eventType: 'deleted',
          oldValue: { name: row.name, shared: row.shared, conditions: row.conditions },
        },
      ]);
      return { deleted: true as const };
    });
  }

  /**
   * Running a saved query is the inline search with the stored conditions:
   * one code path, one grant clause, one set of rows.
   */
  async run(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    page: { limit?: number; cursor?: string },
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null; saved_query: SavedQueryRow }> {
    const saved = await this.get(principal, id);
    const result = await this.reporting.searchEvents(principal, ctx, {
      conditions: saved.conditions,
      limit: page.limit,
      cursor: page.cursor,
    });
    return { ...result, saved_query: saved };
  }

  /** The search's own grammar is the only judge of a condition, at save time as at run time. */
  private validated(conditions: readonly EventCondition[]): readonly EventCondition[] {
    translateEvents({ conditions });
    return conditions;
  }

  private sharing(principal: Principal, shared: boolean): boolean {
    if (shared && !hasPermission(principal, 'audit:export'))
      throw new ForbiddenException({ code: 'forbidden', permission: 'audit:export' });
    return shared;
  }
}
