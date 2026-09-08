import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import type { EventCondition } from './audit-search.js';

export interface SavedQueryRow {
  id: string;
  name: string;
  description: string;
  owner_user_id: string;
  owner_name: string | null;
  shared: boolean;
  conditions: EventCondition[];
  created_at: string;
  updated_at: string;
}

/**
 * The saved condition sets of the audit search (`op.audit_saved_queries`,
 * Audit & Analytics 7.1). Operator records with no account of their own:
 * what a query may see is decided when it runs, by the grant clause the
 * search applies to whoever ran it.
 */
@Injectable()
export class SavedQueriesRepository extends RepositoryBase {
  private static readonly SELECT = `select q.id, q.name, q.description, q.owner_user_id, q.shared, q.conditions,
              q.created_at, q.updated_at,
              nullif(trim(concat_ws(' ', u.first_name, u.last_name)), '') as owner_name
         from op.audit_saved_queries q
         left join op.users u on u.id = q.owner_user_id`;

  /** Mine plus every shared one, by name. */
  visible(tx: Tx, userId: string): Promise<SavedQueryRow[]> {
    return this.many<SavedQueryRow>(
      tx,
      `${SavedQueriesRepository.SELECT} where q.owner_user_id = $1 or q.shared order by q.name`,
      [userId],
    );
  }

  /**
   * One readable query. A private query of another user is invisible rather
   * than forbidden, which is the house rule for a by-id read: a foreign id
   * is never confirmed with a 403.
   */
  readable(tx: Tx, id: string, userId: string): Promise<SavedQueryRow> {
    return this.one<SavedQueryRow>(
      tx,
      'audit_saved_query',
      `${SavedQueriesRepository.SELECT} where q.id = $1 and (q.owner_user_id = $2 or q.shared)`,
      [id, userId],
    );
  }

  /** One query the caller owns: editing and deleting are the owner's alone. */
  owned(tx: Tx, id: string, userId: string): Promise<SavedQueryRow> {
    return this.one<SavedQueryRow>(
      tx,
      'audit_saved_query',
      `${SavedQueriesRepository.SELECT} where q.id = $1 and q.owner_user_id = $2`,
      [id, userId],
    );
  }

  async insert(
    tx: Tx,
    input: {
      name: string;
      description: string;
      ownerUserId: string;
      shared: boolean;
      conditions: readonly EventCondition[];
    },
  ): Promise<SavedQueryRow> {
    const row = await this.one<{ id: string }>(
      tx,
      'audit_saved_query',
      `insert into op.audit_saved_queries (name, description, owner_user_id, shared, conditions)
       values ($1, $2, $3, $4, $5::jsonb) returning id`,
      [input.name, input.description, input.ownerUserId, input.shared, JSON.stringify(input.conditions)],
    );
    return this.readable(tx, row.id, input.ownerUserId);
  }

  async update(
    tx: Tx,
    id: string,
    userId: string,
    changes: { name?: string; description?: string; shared?: boolean; conditions?: readonly EventCondition[] },
  ): Promise<SavedQueryRow> {
    await tx.query(
      `update op.audit_saved_queries
          set name = coalesce($3, name),
              description = coalesce($4, description),
              shared = coalesce($5, shared),
              conditions = coalesce($6::jsonb, conditions)
        where id = $1 and owner_user_id = $2`,
      [
        id,
        userId,
        changes.name ?? null,
        changes.description ?? null,
        changes.shared ?? null,
        changes.conditions ? JSON.stringify(changes.conditions) : null,
      ],
    );
    return this.owned(tx, id, userId);
  }

  async remove(tx: Tx, id: string, userId: string): Promise<void> {
    await tx.query('delete from op.audit_saved_queries where id = $1 and owner_user_id = $2', [id, userId]);
  }
}
