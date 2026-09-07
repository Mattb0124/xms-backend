import { Injectable } from '@nestjs/common';
import { AuditService, SYSTEM_ACTOR } from '../common/audit/audit.service.js';
import { GLOBAL_ACCOUNT_ID } from '../common/auth/principal.repository.js';
import { DbPools } from '../db/pool.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import type { Job } from './jobs.js';

/**
 * Roster housekeeping (Capacity & Allocation technical section 3,
 * CertificationExpiryJob): sixty days before a certification expires the
 * person and every capacity manager hear about it once; the row remembers
 * that it was notified so the next run stays quiet. Notifications sit on
 * the global knowledge account, which every internal principal reads.
 */
export const EXPIRY_WINDOW_DAYS = 60;

interface ExpiringRow {
  id: string;
  person_id: string;
  user_id: string | null;
  display_name: string;
  name: string;
  issuer: string | null;
  expires_on: string;
}

@Injectable()
export class RosterJobs {
  constructor(
    private readonly pools: DbPools,
    private readonly uow: UnitOfWork,
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
  ) {}

  certificationExpiry(intervalMs = 24 * 60 * 60_000): Job {
    return { name: 'roster.certification_expiry', intervalMs, run: () => this.notifyExpiring() };
  }

  /** Notifies once per certification inside the window; returns the count notified. */
  async notifyExpiring(batch = 200): Promise<string> {
    let notified = 0;
    await this.uow.worker([GLOBAL_ACCOUNT_ID], async (tx) => {
      const rows = await tx.query<ExpiringRow>(
        `select c.id, c.person_id, p.user_id, p.display_name, c.name, c.issuer, c.expires_on::text as expires_on
           from op.certifications c join op.people p on p.id = c.person_id
          where p.is_active and c.expiry_notified_at is null and c.expires_on is not null
            and c.expires_on <= current_date + $1::int and c.expires_on >= current_date
          order by c.expires_on limit $2 for update of c skip locked`,
        [EXPIRY_WINDOW_DAYS, batch],
      );
      if (rows.rows.length === 0) return;
      const managers = await tx.query<{ id: string }>(
        `select distinct u.id from op.users u
           join op.role_assignments ra on ra.user_id = u.id and ra.account_id is null
           join op.roles r on r.id = ra.role_id
          where u.kind = 'internal' and u.status = 'active' and r.status = 'active'
            and 'capacity:manage' = any (r.permissions)`,
      );
      for (const row of rows.rows) {
        const recipients = new Set(managers.rows.map((manager) => manager.id));
        if (row.user_id) recipients.add(row.user_id);
        const days = Math.round((new Date(`${row.expires_on}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
        for (const recipientId of recipients)
          await this.notifications.upsert(tx, {
            accountId: GLOBAL_ACCOUNT_ID,
            recipientId,
            type: 'roster.certification_expiring',
            title: `${row.display_name}: ${row.name} expires in ${days} days`,
            body: row.issuer ? `${row.issuer}, expires ${row.expires_on}` : `Expires ${row.expires_on}`,
            targetKind: 'person',
            targetId: row.person_id,
            link: `/roster/${row.person_id}?tab=certifications`,
            collapseKey: `certification:${row.id}`,
          });
        await tx.query('update op.certifications set expiry_notified_at = now() where id = $1', [row.id]);
        await this.audit.operator(tx, SYSTEM_ACTOR, { correlationId: `certification-expiry:${row.id}` }, [
          {
            entityKind: 'person',
            entityId: row.person_id,
            eventType: 'roster.certification.expiring',
            newValue: {
              certification_id: row.id,
              name: row.name,
              expires_on: row.expires_on,
              notified: recipients.size,
            },
          },
        ]);
        notified += 1;
      }
    });
    return `notified ${notified}`;
  }

  /** Kept for symmetry with the other jobs; the pool is the worker's. */
  protected pool() {
    return this.pools.get('worker');
  }
}
