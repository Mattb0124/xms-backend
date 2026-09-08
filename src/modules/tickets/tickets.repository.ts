import { Injectable } from '@nestjs/common';
import { RepositoryBase, quoteIdent, type Tx } from '../../db/repository.base.js';
import type { Clock, ClockKind } from '../../domain/sla/engine.js';

export interface TicketRow {
  id: string;
  account_id: string;
  number: string;
  type: 'incident' | 'service_request' | 'change' | 'problem' | 'project_task';
  state: string;
  state_machine_version_id: string;
  short_description: string;
  description: string | null;
  category: string | null;
  impact: 'high' | 'medium' | 'low' | null;
  urgency: 'high' | 'medium' | 'low' | null;
  priority: 'p1' | 'p2' | 'p3' | 'p4';
  priority_overridden: boolean;
  matrix_version_id: string | null;
  source: 'portal' | 'email' | 'internal' | 'api' | 'sync' | 'import';
  requester_contact_id: string | null;
  group_id: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  contract_id: string;
  configuration_item_id: string | null;
  ticket_group_id: string | null;
  out_of_scope: string;
  out_of_scope_detail: Record<string, unknown> | null;
  resolution_code: string | null;
  resolution_notes: string | null;
  solution_article_id: string | null;
  solution_candidate: boolean;
  time_exemption_reason: string | null;
  external_refs: Record<string, unknown>;
  reopen_count: number;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  sla_response_breached: boolean;
  sla_resolution_breached: boolean;
  email_token: string | null;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface ClockRow {
  id: string;
  account_id: string;
  ticket_id: string;
  kind: ClockKind;
  policy_ref: string;
  calendar_id: string;
  target_minutes: number;
  started_at: string;
  due_at: string;
  paused_at: string | null;
  paused_total_minutes: number;
  met_at: string | null;
  breached_at: string | null;
}

export interface MessageRow {
  id: string;
  account_id: string;
  ticket_id: string;
  author_kind: string;
  author_id: string;
  author_name: string;
  body: string;
  source: string;
  is_first_response?: boolean;
  created_at: string;
}

export interface ContactRow {
  id: string;
  account_id: string;
  email: string;
  display_name: string;
  portal_user_id: string | null;
}

export interface ListFilters {
  accountIds?: string[];
  state?: string[];
  type?: string[];
  priority?: string[];
  assigneeId?: string;
  groupId?: string;
  unassigned?: boolean;
  open?: boolean;
  breached?: boolean;
  /** The out-of-scope flag, on the closed vocabulary of migration 0004. */
  outOfScope?: string[];
  q?: string;
  requesterContactId?: string;
  /** Translated condition set; called with the current bind offset. */
  conditions?: (offset: number) => { sql: string; values: unknown[] };
}

export interface Page {
  limit: number;
  cursor?: { updatedAt: string; id: string };
  sort: 'updated_desc' | 'created_desc' | 'priority';
}

export function ticketKey(number: string | number): string {
  return `CS${String(number).padStart(7, '0')}`;
}

export function parseTicketKey(key: string): string | undefined {
  const match = key.match(/^CS(\d{7,})$/i);
  return match ? String(Number(match[1])) : undefined;
}

export function toClock(row: ClockRow): Clock {
  return {
    kind: row.kind,
    policyRef: row.policy_ref,
    calendarId: row.calendar_id,
    targetMinutes: row.target_minutes,
    startedAt: new Date(row.started_at),
    dueAt: new Date(row.due_at),
    pausedAt: row.paused_at ? new Date(row.paused_at) : null,
    pausedTotalMinutes: row.paused_total_minutes,
    metAt: row.met_at ? new Date(row.met_at) : null,
    breachedAt: row.breached_at ? new Date(row.breached_at) : null,
  };
}

/**
 * The ticket tables (Ticket Management technical 2). Every method takes the
 * bound transaction; the referenced ids a client supplies are loaded under
 * the same session so a foreign id raises 404, never 403.
 */
@Injectable()
export class TicketsRepository extends RepositoryBase {
  byId(tx: Tx, id: string): Promise<TicketRow> {
    return this.one<TicketRow>(tx, 'ticket', 'select * from acct.tickets where id = $1', [id]);
  }

  byNumber(tx: Tx, number: string): Promise<TicketRow> {
    return this.one<TicketRow>(tx, 'ticket', 'select * from acct.tickets where number = $1', [number]);
  }

  lock(tx: Tx, id: string): Promise<TicketRow> {
    return this.one<TicketRow>(tx, 'ticket', 'select * from acct.tickets where id = $1 for update', [id]);
  }

  insert(
    tx: Tx,
    row: Partial<TicketRow> & {
      account_id: string;
      type: string;
      state: string;
      short_description: string;
      priority: string;
      contract_id: string;
      created_by: string;
    },
  ): Promise<TicketRow> {
    const columns = Object.keys(row);
    return this.one<TicketRow>(
      tx,
      'ticket',
      `insert into acct.tickets (${columns.map(quoteIdent).join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning *`,
      columns.map((column) => serialise(row[column as keyof TicketRow])),
    );
  }

  update(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<TicketRow> {
    const serialised: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(assignments)) serialised[key] = serialise(value);
    return this.updateVersioned<TicketRow>(tx, 'ticket', 'acct.tickets', id, version, serialised);
  }

  async list(tx: Tx, filters: ListFilters, page: Page): Promise<{ rows: TicketRow[]; hasMore: boolean }> {
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (clause: string, value: unknown): void => {
      values.push(value);
      where.push(clause.replace('?', `$${values.length}`));
    };
    if (filters.accountIds?.length) add('account_id = any (?::uuid[])', filters.accountIds);
    if (filters.state?.length) add('state = any (?::text[])', filters.state);
    if (filters.type?.length) add('type = any (?::text[])', filters.type);
    if (filters.priority?.length) add('priority = any (?::text[])', filters.priority);
    if (filters.assigneeId) add('assignee_id = ?', filters.assigneeId);
    if (filters.groupId) add('group_id = ?', filters.groupId);
    if (filters.requesterContactId) add('requester_contact_id = ?', filters.requesterContactId);
    if (filters.outOfScope?.length) add('out_of_scope = any (?::text[])', filters.outOfScope);
    if (filters.unassigned) where.push('assignee_id is null');
    if (filters.breached) where.push('(sla_response_breached or sla_resolution_breached)');
    if (filters.open) where.push(`state not in ('closed', 'cancelled')`);
    if (filters.q) {
      const number = parseTicketKey(filters.q.trim());
      if (number) add('number = ?', number);
      else {
        values.push(filters.q.trim());
        where.push(
          `(search @@ plainto_tsquery('english', $${values.length}) or ('CS' || lpad(number::text, 7, '0')) ilike '%' || $${values.length} || '%')`,
        );
      }
    }
    if (filters.conditions) {
      const translated = filters.conditions(values.length);
      values.push(...translated.values);
      where.push(translated.sql);
    }
    const orderBy =
      page.sort === 'created_desc'
        ? 'created_at desc, id desc'
        : page.sort === 'priority'
          ? 'priority asc, updated_at desc, id desc'
          : 'updated_at desc, id desc';
    if (page.cursor && page.sort !== 'priority') {
      const column = page.sort === 'created_desc' ? 'created_at' : 'updated_at';
      values.push(page.cursor.updatedAt, page.cursor.id);
      where.push(`(${column}, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(page.limit + 1);
    const clause = where.length > 0 ? `where ${where.join(' and ')}` : '';
    const rows = await this.many<TicketRow>(
      tx,
      `select * from acct.tickets ${clause} order by ${orderBy} limit $${values.length}`,
      values,
    );
    return { rows: rows.slice(0, page.limit), hasMore: rows.length > page.limit };
  }

  // Clocks and pauses --------------------------------------------------------

  clocksOf(tx: Tx, ticketId: string): Promise<ClockRow[]> {
    return this.many<ClockRow>(tx, 'select * from acct.sla_clocks where ticket_id = $1 order by kind', [ticketId]);
  }

  clocksOfMany(tx: Tx, ticketIds: string[]): Promise<ClockRow[]> {
    if (ticketIds.length === 0) return Promise.resolve([]);
    return this.many<ClockRow>(tx, 'select * from acct.sla_clocks where ticket_id = any ($1::uuid[])', [ticketIds]);
  }

  async insertClock(tx: Tx, accountId: string, ticketId: string, clock: Clock): Promise<void> {
    await tx.query(
      `insert into acct.sla_clocks (account_id, ticket_id, kind, policy_ref, calendar_id, target_minutes, started_at, due_at, paused_at, paused_total_minutes, met_at, breached_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        accountId,
        ticketId,
        clock.kind,
        clock.policyRef,
        clock.calendarId,
        clock.targetMinutes,
        clock.startedAt,
        clock.dueAt,
        clock.pausedAt,
        clock.pausedTotalMinutes,
        clock.metAt,
        clock.breachedAt,
      ],
    );
  }

  async saveClock(tx: Tx, id: string, clock: Clock): Promise<void> {
    await tx.query(
      `update acct.sla_clocks set target_minutes = $2, due_at = $3, paused_at = $4, paused_total_minutes = $5, met_at = $6, breached_at = $7 where id = $1`,
      [id, clock.targetMinutes, clock.dueAt, clock.pausedAt, clock.pausedTotalMinutes, clock.metAt, clock.breachedAt],
    );
  }

  async insertPause(
    tx: Tx,
    accountId: string,
    ticketId: string,
    reason: string,
    note: string | null,
    startedBy: string,
    at: Date,
  ): Promise<string> {
    const row = await this.one<{ id: string }>(
      tx,
      'sla_pause',
      `insert into acct.sla_pauses (account_id, ticket_id, reason, note, started_at, started_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [accountId, ticketId, reason, note, at, startedBy],
    );
    return row.id;
  }

  async endOpenPauses(tx: Tx, ticketId: string, endedBy: string, at: Date, excludedMinutes: number): Promise<number> {
    return this.count(
      tx,
      `update acct.sla_pauses set ended_at = $2, ended_by = $3, excluded_minutes = $4 where ticket_id = $1 and ended_at is null`,
      [ticketId, at, endedBy, excludedMinutes],
    );
  }

  pausesOf(
    tx: Tx,
    ticketId: string,
  ): Promise<
    {
      id: string;
      reason: string;
      note: string | null;
      started_at: string;
      ended_at: string | null;
      excluded_minutes: number | null;
      started_by: string;
      ended_by: string | null;
    }[]
  > {
    return this.many(
      tx,
      'select id, reason, note, started_at, ended_at, excluded_minutes, started_by, ended_by from acct.sla_pauses where ticket_id = $1 order by started_at',
      [ticketId],
    );
  }

  // Messages -----------------------------------------------------------------

  insertComment(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string;
      authorKind: string;
      authorId: string;
      authorName: string;
      body: string;
      source: string;
      isFirstResponse: boolean;
    },
  ): Promise<MessageRow> {
    return this.one<MessageRow>(
      tx,
      'comment',
      `insert into acct.comments (account_id, ticket_id, author_kind, author_id, author_name, body, source, is_first_response)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        input.accountId,
        input.ticketId,
        input.authorKind,
        input.authorId,
        input.authorName,
        input.body,
        input.source,
        input.isFirstResponse,
      ],
    );
  }

  insertWorkNote(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string;
      authorKind: string;
      authorId: string;
      authorName: string;
      body: string;
      source: string;
    },
  ): Promise<MessageRow> {
    return this.one<MessageRow>(
      tx,
      'work_note',
      `insert into acct.work_notes (account_id, ticket_id, author_kind, author_id, author_name, body, source)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [input.accountId, input.ticketId, input.authorKind, input.authorId, input.authorName, input.body, input.source],
    );
  }

  commentsOf(tx: Tx, ticketId: string): Promise<MessageRow[]> {
    return this.many<MessageRow>(tx, 'select * from acct.comments where ticket_id = $1 order by created_at', [
      ticketId,
    ]);
  }

  workNotesOf(tx: Tx, ticketId: string): Promise<MessageRow[]> {
    return this.many<MessageRow>(tx, 'select * from acct.work_notes where ticket_id = $1 order by created_at', [
      ticketId,
    ]);
  }

  auditOf(
    tx: Tx,
    ticketId: string,
  ): Promise<
    {
      id: string;
      event_type: string;
      field: string | null;
      old_value: unknown;
      new_value: unknown;
      actor_kind: string;
      actor_name: string | null;
      created_at: string;
    }[]
  > {
    return this.many(
      tx,
      `select id, event_type, field, old_value, new_value, actor_kind, actor_name, created_at from acct.audit_events where ticket_id = $1 order by created_at, id`,
      [ticketId],
    );
  }

  publicTimeline(
    tx: Tx,
    ticketId: string,
  ): Promise<
    {
      kind: string;
      item_id: string;
      actor_name: string | null;
      body: string | null;
      file_name: string | null;
      from_state: string | null;
      to_state: string | null;
      created_at: string;
    }[]
  > {
    return this.many(
      tx,
      `select kind, item_id, actor_name, body, file_name, from_state, to_state, created_at from acct.ticket_timeline_public where ticket_id = $1 order by created_at`,
      [ticketId],
    );
  }

  // Contacts -----------------------------------------------------------------

  contactByEmail(tx: Tx, accountId: string, email: string): Promise<ContactRow | undefined> {
    return this.maybeOne<ContactRow>(tx, 'select * from acct.contacts where account_id = $1 and email = $2', [
      accountId,
      email,
    ]);
  }

  contactById(tx: Tx, id: string): Promise<ContactRow> {
    return this.one<ContactRow>(tx, 'contact', 'select * from acct.contacts where id = $1', [id]);
  }

  insertContact(
    tx: Tx,
    accountId: string,
    email: string,
    displayName: string,
    portalUserId?: string,
  ): Promise<ContactRow> {
    return this.one<ContactRow>(
      tx,
      'contact',
      `insert into acct.contacts (account_id, email, display_name, portal_user_id) values ($1, $2, $3, $4) returning *`,
      [accountId, email, displayName, portalUserId ?? null],
    );
  }

  // Watchers -----------------------------------------------------------------

  async ensureWatcher(tx: Tx, accountId: string, ticketId: string, userId: string, source: string): Promise<void> {
    await tx.query(
      `insert into acct.watchers (account_id, ticket_id, user_id, source) values ($1, $2, $3, $4) on conflict (ticket_id, user_id) do nothing`,
      [accountId, ticketId, userId, source],
    );
  }

  watchersOf(tx: Tx, ticketId: string): Promise<{ user_id: string; source: string; muted_at: string | null }[]> {
    return this.many(tx, 'select user_id, source, muted_at from acct.watchers where ticket_id = $1', [ticketId]);
  }

  async setMuted(tx: Tx, ticketId: string, userId: string, muted: boolean): Promise<void> {
    await tx.query(
      `update acct.watchers set muted_at = case when $3 then now() else null end where ticket_id = $1 and user_id = $2`,
      [ticketId, userId, muted],
    );
  }

  // Links --------------------------------------------------------------------

  linksOf(
    tx: Tx,
    ticketId: string,
  ): Promise<{ id: string; from_ticket_id: string; to_ticket_id: string; type: string; created_at: string }[]> {
    return this.many(
      tx,
      'select id, from_ticket_id, to_ticket_id, type, created_at from acct.ticket_links where from_ticket_id = $1 or to_ticket_id = $1 order by created_at',
      [ticketId],
    );
  }

  insertLink(
    tx: Tx,
    accountId: string,
    from: string,
    to: string,
    type: string,
    createdBy: string,
  ): Promise<{ id: string }> {
    return this.one<{ id: string }>(
      tx,
      'ticket_link',
      `insert into acct.ticket_links (account_id, from_ticket_id, to_ticket_id, type, created_by) values ($1, $2, $3, $4, $5) returning id`,
      [accountId, from, to, type, createdBy],
    );
  }

  deleteLink(tx: Tx, id: string): Promise<number> {
    return this.count(tx, 'delete from acct.ticket_links where id = $1', [id]);
  }

  // Counts for the queue header ---------------------------------------------

  async stats(
    tx: Tx,
    accountIds: string[],
  ): Promise<{ open: number; unassigned: number; breached: number; p1: number }> {
    const row = await this.maybeOne<{ open: number; unassigned: number; breached: number; p1: number }>(
      tx,
      `select count(*) filter (where state not in ('closed', 'cancelled'))::int as open,
              count(*) filter (where state not in ('closed', 'cancelled') and assignee_id is null)::int as unassigned,
              count(*) filter (where state not in ('closed', 'cancelled') and (sla_response_breached or sla_resolution_breached))::int as breached,
              count(*) filter (where state not in ('closed', 'cancelled') and priority = 'p1')::int as p1
         from acct.tickets where account_id = any ($1::uuid[])`,
      [accountIds],
    );
    return row ?? { open: 0, unassigned: 0, breached: 0, p1: 0 };
  }
}

function serialise(value: unknown): unknown {
  if (value === undefined) return null;
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value))
    return JSON.stringify(value);
  return value;
}
