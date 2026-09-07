import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';

export interface NotificationRow {
  id: string;
  account_id: string;
  recipient_id: string;
  type: string;
  title: string;
  body: string;
  target_kind: string;
  target_id: string;
  link: string | null;
  collapse_key: string | null;
  count: number;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewNotification {
  readonly accountId: string;
  readonly recipientId: string;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly link?: string;
  readonly collapseKey?: string;
}

/**
 * acct.notifications with the AIX notification triad (identity-key
 * recipient, collapse key, muted): an unread row with the same collapse key
 * absorbs a repeat instead of producing a second row.
 */
@Injectable()
export class NotificationsRepository extends RepositoryBase {
  async upsert(tx: Tx, input: NewNotification): Promise<NotificationRow> {
    if (input.collapseKey) {
      const collapsed = await this.maybeOne<NotificationRow>(
        tx,
        `update acct.notifications set count = count + 1, title = $3, body = $4
          where recipient_id = $1 and collapse_key = $2 and read_at is null returning *`,
        [input.recipientId, input.collapseKey, input.title, input.body ?? ''],
      );
      if (collapsed) return collapsed;
    }
    return this.one<NotificationRow>(
      tx,
      'notification',
      `insert into acct.notifications (account_id, recipient_id, type, title, body, target_kind, target_id, link, collapse_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        input.accountId,
        input.recipientId,
        input.type,
        input.title,
        input.body ?? '',
        input.targetKind,
        input.targetId,
        input.link ?? null,
        input.collapseKey ?? null,
      ],
    );
  }

  feed(tx: Tx, recipientId: string, before: string | undefined, limit: number): Promise<NotificationRow[]> {
    return before
      ? this.many<NotificationRow>(
          tx,
          `select * from acct.notifications where recipient_id = $1 and updated_at < $2 order by updated_at desc limit $3`,
          [recipientId, before, limit],
        )
      : this.many<NotificationRow>(
          tx,
          `select * from acct.notifications where recipient_id = $1 order by updated_at desc limit $2`,
          [recipientId, limit],
        );
  }

  async unreadCount(tx: Tx, recipientId: string): Promise<number> {
    const row = await this.maybeOne<{ n: number }>(
      tx,
      `select count(*)::int as n from acct.notifications where recipient_id = $1 and read_at is null`,
      [recipientId],
    );
    return row?.n ?? 0;
  }

  markRead(tx: Tx, recipientId: string, id: string): Promise<NotificationRow> {
    return this.one<NotificationRow>(
      tx,
      'notification',
      `update acct.notifications set read_at = coalesce(read_at, now()) where id = $1 and recipient_id = $2 returning *`,
      [id, recipientId],
    );
  }

  markAllRead(tx: Tx, recipientId: string): Promise<number> {
    return this.count(tx, `update acct.notifications set read_at = now() where recipient_id = $1 and read_at is null`, [
      recipientId,
    ]);
  }
}
