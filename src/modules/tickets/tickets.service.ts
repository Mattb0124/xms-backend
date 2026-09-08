import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/auth/decorators.js';
import { actorKindOf, type Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService, type AuditEntry } from '../../common/audit/audit.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import {
  latch,
  markMet,
  pause,
  restampForPriority,
  resume,
  startClocks,
  view as clockView,
  WALL_CLOCK,
  type Calendar,
  type Clock,
  type ClockView,
} from '../../domain/sla/engine.js';
import { checkRequirements } from '../../domain/tickets/close-discipline.js';
import { freezeAt, freezeOverlapping, insideWindow } from '../../domain/tickets/change-window.js';
import { TicketGroupsRepository, toChangeWindow, windowSpan, type TicketGroupRow } from './change-windows.module.js';
import { translate, type ConditionSet } from './conditions.js';
import { RoutingRepository } from './routing.module.js';
import { ViewsRepository } from './views.js';
import { TimeRepository } from '../time/time.repository.js';
import { KnowledgeRepository } from '../knowledge/knowledge.repository.js';
import type { Level, Priority } from '../../domain/tickets/priority-matrix.js';
import type { StateMachine } from '../../domain/tickets/state-machine.js';
import { ConfigService } from '../admin/config/config.service.js';
import { CalendarService } from '../calendars/calendars.module.js';
import { UsersRepository } from '../admin/users/users.repository.js';
import { ContractsRepository } from '../contracts/contracts.module.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import type {
  CreateTicketDto,
  ListTicketsQueryDto,
  MessageDto,
  PatchTicketDto,
  ScopeDecisionDto,
  ScopeFlagDto,
  TransitionDto,
} from './tickets.dto.js';
import { TicketsRepository, ticketKey, toClock, type ClockRow, type TicketRow } from './tickets.repository.js';

/**
 * The ticket service (Ticket Management technical 3.3). The only writer of
 * ticket state; every mutation locks the row, validates against the
 * resolved state machine, applies the SLA effects in the proof-of-concept
 * order (latch, then pause; resume, then latch), writes every changed field
 * to the audit stream and the outbox in the same transaction, and returns
 * the computed view (the server owns the clocks).
 */
/**
 * What the record keeps about an out-of-scope flag (TM-11). The state lives
 * in `acct.tickets.out_of_scope`; everything the people involved said lives
 * in `out_of_scope_detail`, so the column stays a small closed vocabulary
 * the queue and the waiting rail can count.
 */
export interface ScopeDetail {
  reason?: string;
  flagged_by?: string;
  flagged_by_name?: string;
  flagged_at?: string;
  withdrawn_by?: string;
  withdrawn_at?: string;
  decision?: 'approve' | 'decline';
  note?: string | null;
  decided_by?: string;
  decided_by_name?: string;
  decided_at?: string;
  overage_allowance_minutes?: number | null;
  contract_period_id?: string | null;
}

export interface ScopeView {
  out_of_scope: string;
  reason: string | null;
  flagged_by: string | null;
  flagged_by_name: string | null;
  flagged_at: string | null;
  decision: 'approve' | 'decline' | null;
  note: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  overage_allowance_minutes: number | null;
}

export interface TicketView {
  id: string;
  key: string;
  account_id: string;
  type: TicketRow['type'];
  state: string;
  state_label: string;
  short_description: string;
  description: string | null;
  category: string | null;
  impact: string | null;
  urgency: string | null;
  priority: string;
  priority_overridden: boolean;
  source: string;
  requester: { id: string; email: string; display_name: string } | null;
  group_id: string | null;
  /** The project or change window the ticket belongs to (TM-10). */
  ticket_group_id: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  contract_id: string;
  resolution: {
    code: string | null;
    notes: string | null;
    solution_article_id: string | null;
    solution_candidate: boolean;
    time_exemption_reason: string | null;
  };
  /** The out-of-scope flag and its decision (TM-11), for the record bar. */
  scope: ScopeView;
  external_refs: Record<string, unknown>;
  /** The published request form version this ticket answered, when it came from one (CP-03). */
  form_version_id: string | null;
  /** The answers with no ticket column of their own (CP-03). */
  form_data: Record<string, unknown>;
  reopen_count: number;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  sla: { response?: ClockView; resolution?: ClockView };
  /** Whether the reading principal follows this ticket (unmuted watcher). */
  watching?: boolean;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface PortalTicketView {
  id: string;
  key: string;
  type: TicketRow['type'];
  state: string;
  state_label: string;
  short_description: string;
  description: string | null;
  category: string | null;
  priority: string;
  /** The published request form version this request answered (CP-03). */
  form_version_id: string | null;
  /** The answers with no ticket column of their own (CP-03). */
  form_data: Record<string, unknown>;
  requester: { display_name: string } | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  version: number;
}

interface SlaTargetsBody {
  targets: Record<string, Record<string, { response_minutes: number | null; resolution_minutes: number | null }>>;
}

interface ResolutionCodesBody {
  items: { key: string; label: string; no_solution: boolean }[];
}

/** Import-only message fields (Data Migration technical section 3): the source author and time, and whether it counted as an operator response. */
export interface MessageOverrides {
  readonly createdAt?: Date;
  readonly authorKind?: string;
  readonly authorName?: string;
  readonly operatorResponse?: boolean;
}

const OPEN_STATES_EXCLUDED = ['closed', 'cancelled'];

@Injectable()
export class TicketsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tickets: TicketsRepository,
    private readonly contracts: ContractsRepository,
    private readonly users: UsersRepository,
    private readonly notifications: NotificationsRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly views: ViewsRepository,
    private readonly time: TimeRepository,
    private readonly knowledge: KnowledgeRepository,
    private readonly calendars: CalendarService,
    private readonly routing: RoutingRepository,
    private readonly groups: TicketGroupsRepository,
  ) {}

  // Reads ---------------------------------------------------------------------

  async list(
    principal: Principal,
    query: ListTicketsQueryDto,
    bound?: Tx,
  ): Promise<{ items: TicketView[]; next_cursor: string | null; stats: unknown }> {
    const limit = Math.min(query.limit ?? 50, 200);
    return this.inTx(principal, bound, async (tx) => {
      const accountIds = query.account_id?.length
        ? query.account_id.filter((id) => principal.accountIds.includes(id))
        : [...principal.accountIds];
      if (accountIds.length === 0)
        return { items: [], next_cursor: null, stats: { open: 0, unassigned: 0, breached: 0, p1: 0 } };
      let conditions: ConditionSet | undefined = query.conditions ? decodeConditions(query.conditions) : undefined;
      let sort = query.sort;
      if (query.view) {
        const view = await this.views.byId(tx, query.view);
        conditions = view.definition.conditions;
        sort = sort ?? view.definition.sort;
      }
      // The group queue (TM-08). Resolved from op.group_members here rather
      // than taken from the query, so nobody can ask for another team's queue
      // by naming its groups, and only when the request needs it.
      const wantsGroups =
        query.my_groups === true || (conditions?.conditions ?? []).some((condition) => condition.op === 'is_mine');
      const groupIds = wantsGroups ? await this.groupsOf(tx, principal) : [];
      const page = await this.tickets.list(
        tx,
        {
          accountIds,
          conditions: conditions
            ? (offset) => translate(conditions!, { userId: principal.userId, groupIds }, offset)
            : undefined,
          state: query.state,
          type: query.type,
          priority: query.priority,
          assigneeId: query.mine ? principal.userId : query.assignee_id,
          groupId: query.group_id,
          groupIds: query.my_groups ? groupIds : undefined,
          unassigned: query.unassigned,
          open: query.open,
          breached: query.breached,
          outOfScope: query.out_of_scope,
          q: query.q,
        },
        { limit, sort: sort ?? 'updated_desc', cursor: decodeCursor(query.cursor) },
      );
      const clocks = await this.tickets.clocksOfMany(
        tx,
        page.rows.map((row) => row.id),
      );
      const now = new Date();
      const calendars = await this.calendars.forClocks(tx, clocks);
      const machines = new Map<string, StateMachine>();
      const items: TicketView[] = [];
      for (const row of page.rows) {
        const machine = await this.machineFor(tx, row, machines);
        items.push(
          this.toView(
            row,
            clocks.filter((clock) => clock.ticket_id === row.id),
            machine,
            null,
            now,
            calendars,
          ),
        );
      }
      const last = page.rows[page.rows.length - 1];
      const next =
        page.hasMore && last
          ? encodeCursor(query.sort === 'created_desc' ? last.created_at : last.updated_at, last.id)
          : null;
      const stats = await this.tickets.stats(tx, accountIds);
      return { items, next_cursor: next, stats };
    });
  }

  async get(principal: Principal, idOrKey: string, bound?: Tx): Promise<TicketView | PortalTicketView> {
    return this.inTx(principal, bound, async (tx) => {
      const row = await this.load(tx, idOrKey);
      const machine = await this.machineFor(tx, row, new Map());
      const requester = row.requester_contact_id
        ? await this.tickets.contactById(tx, row.requester_contact_id).catch(() => undefined)
        : undefined;
      if (principal.kind === 'portal') return this.toPortalView(row, machine, requester);
      const clocks = await this.tickets.clocksOf(tx, row.id);
      const watchers = await this.tickets.watchersOf(tx, row.id);
      const watching = watchers.some((watcher) => watcher.user_id === principal.userId && !watcher.muted_at);
      return {
        ...this.toView(row, clocks, machine, requester ?? null, new Date(), await this.calendars.forClocks(tx, clocks)),
        watching,
      };
    });
  }

  async allowedTransitions(
    principal: Principal,
    idOrKey: string,
    bound?: Tx,
  ): Promise<{ from: string; transitions: { to: string; label: string; requires: string[]; reopen: boolean }[] }> {
    return this.inTx(principal, bound, async (tx) => {
      const row = await this.load(tx, idOrKey);
      const machine = await this.machineFor(tx, row, new Map());
      const actor = { kind: principal.kind === 'portal' ? ('portal' as const) : ('internal' as const) };
      return {
        from: row.state,
        transitions: machine.available(row.state, actor).map((transition) => ({
          to: transition.to,
          label: transition.label ?? machine.state(transition.to)?.label ?? transition.to,
          requires: [...(transition.requires ?? [])],
          reopen: Boolean(transition.reopen),
        })),
      };
    });
  }

  async timeline(principal: Principal, idOrKey: string, bound?: Tx): Promise<unknown[]> {
    return this.inTx(principal, bound, async (tx) => {
      const row = await this.load(tx, idOrKey);
      if (principal.kind === 'portal') return this.tickets.publicTimeline(tx, row.id);
      const comments = await this.tickets.commentsOf(tx, row.id);
      const notes = await this.tickets.workNotesOf(tx, row.id);
      const audit = await this.tickets.auditOf(tx, row.id);
      const pauses = await this.tickets.pausesOf(tx, row.id);
      const items = [
        ...comments.map((comment) => ({
          kind: 'comment',
          id: comment.id,
          actor_name: comment.author_name,
          actor_kind: comment.author_kind,
          body: comment.body,
          source: comment.source,
          is_first_response: comment.is_first_response,
          created_at: comment.created_at,
        })),
        ...notes.map((note) => ({
          kind: 'work_note',
          id: note.id,
          actor_name: note.author_name,
          actor_kind: note.author_kind,
          body: note.body,
          source: note.source,
          created_at: note.created_at,
        })),
        ...audit.map((event) => ({
          kind: 'audit',
          id: event.id,
          event_type: event.event_type,
          field: event.field,
          old_value: event.old_value,
          new_value: event.new_value,
          actor_name: event.actor_name,
          actor_kind: event.actor_kind,
          created_at: event.created_at,
        })),
        ...pauses.map((p) => ({
          kind: 'pause',
          id: p.id,
          reason: p.reason,
          note: p.note,
          started_at: p.started_at,
          ended_at: p.ended_at,
          excluded_minutes: p.excluded_minutes,
          actor_name: p.started_by,
          created_at: p.started_at,
        })),
      ];
      return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  }

  // Writes --------------------------------------------------------------------

  async create(principal: Principal, ctx: RequestContext, dto: CreateTicketDto, bound?: Tx): Promise<TicketView> {
    if (!principal.accountIds.includes(dto.account_id))
      throw new NotFoundException({ code: 'not_found', entity: 'account' });
    const correlationId = ctx.requestId ?? randomUUID();
    return this.inTx(principal, bound, async (tx) => {
      const contract = await this.resolveContract(tx, dto.account_id, dto.contract_id);
      const { machine, versionId } = await this.config.stateMachine(tx, dto.type, dto.account_id);
      const { matrix, versionId: matrixVersionId } = await this.config.priorityMatrix(tx, dto.account_id);
      const priority = matrix.derive(dto.impact as Level | undefined, dto.urgency as Level | undefined);
      const requester = dto.requester_email
        ? await this.ensureContact(tx, dto.account_id, dto.requester_email, dto.requester_name)
        : undefined;
      const assignee = dto.assignee_id ? await this.assertAssignable(tx, dto.assignee_id) : undefined;
      if (dto.group_id) await this.assertGroup(tx, dto.group_id);
      // Dispatch: what the caller asked for wins; otherwise the account's
      // routing default for this type and category (TM-08). A default is a
      // starting point, so a ticket with no matching rule simply has no group.
      const groupId = dto.group_id ?? (await this.routing.resolve(tx, dto.account_id, dto.type, dto.category ?? null));
      if (dto.ticket_group_id) await this.assertTicketGroup(tx, dto.account_id, dto.ticket_group_id);

      const row = await this.tickets.insert(tx, {
        account_id: dto.account_id,
        type: dto.type,
        state: machine.initial,
        state_machine_version_id: versionId,
        short_description: dto.short_description,
        description: dto.description ?? null,
        category: dto.category ?? null,
        impact: dto.impact ?? null,
        urgency: dto.urgency ?? null,
        priority,
        matrix_version_id: matrixVersionId,
        source:
          (dto.source as string) === 'email'
            ? 'email'
            : principal.kind === 'portal'
              ? 'portal'
              : (dto.source ?? 'internal'),
        requester_contact_id: requester?.id ?? null,
        group_id: groupId,
        ticket_group_id: dto.ticket_group_id ?? null,
        assignee_id: assignee?.id ?? null,
        assignee_name: assignee ? name(assignee) : null,
        contract_id: contract.id,
        // CP-03: which published form version the request answered, and the
        // answers that have no ticket column of their own.
        form_version_id: dto.form_version_id ?? null,
        form_data: dto.form_data ?? {},
        created_by: principal.userId,
        created_by_name: principal.displayName,
      });

      const now = new Date();
      // Import mode (Data Migration technical section 3): no clocks, no outbox, no notifications; the source dates win.
      const importing = ctx.origin === 'import';
      if (!importing) {
        const targets = await this.targetsFor(tx, contract.sla_policy, dto.account_id, dto.type, priority);
        const policyRef = contract.sla_policy ? `contract:${contract.id}` : targets.policyRef;
        const calendar = await this.calendars.forAccount(tx, dto.account_id);
        for (const clock of startClocks(targets.targets, policyRef, calendar, now)) {
          await this.tickets.insertClock(tx, row.account_id, row.id, clock);
        }
      }
      await this.tickets.ensureWatcher(tx, row.account_id, row.id, principal.userId, 'creator');
      if (assignee) await this.tickets.ensureWatcher(tx, row.account_id, row.id, assignee.id, 'assignee');

      await this.audit.account(tx, row.account_id, actorOf(principal), { requestId: ctx.requestId, correlationId }, [
        {
          entityKind: 'ticket',
          entityId: row.id,
          ticketId: row.id,
          eventType: 'ticket.created',
          newValue: { key: ticketKey(row.number), type: row.type, priority: row.priority, state: row.state },
        },
        ...(groupId
          ? [
              {
                entityKind: 'ticket',
                entityId: row.id,
                ticketId: row.id,
                eventType: 'ticket.group_assigned' as const,
                field: 'group_id',
                oldValue: null,
                newValue: groupId,
              },
            ]
          : []),
        ...(assignee
          ? [
              {
                entityKind: 'ticket',
                entityId: row.id,
                ticketId: row.id,
                eventType: 'ticket.assigned' as const,
                field: 'assignee_id',
                oldValue: null,
                newValue: assignee.id,
              },
            ]
          : []),
      ]);
      if (!importing) {
        await this.outbox.write(tx, {
          accountId: row.account_id,
          aggregate: 'ticket',
          aggregateId: row.id,
          eventType: 'ticket.created',
          correlationId,
          origin: ctx.origin,
          payload: { key: ticketKey(row.number), type: row.type, priority: row.priority },
        });
        if (groupId) {
          // Says whether the desk chose the group or the account's routing
          // default did, which is what makes a routing rule answerable later.
          await this.outbox.write(tx, {
            accountId: row.account_id,
            aggregate: 'ticket',
            aggregateId: row.id,
            eventType: 'ticket.group_assigned',
            correlationId,
            origin: ctx.origin,
            payload: { group_id: groupId, source: dto.group_id ? 'chosen' : 'routing_default' },
          });
        }
        if (assignee && assignee.id !== principal.userId) {
          await this.notifyAssignment(tx, row, assignee.id, principal.displayName, correlationId);
        }
      }
      const sourceCreatedAt = (dto as { created_at?: string }).created_at;
      if (importing && sourceCreatedAt) {
        await tx.query(`update acct.tickets set created_at = $2, updated_at = $2 where id = $1`, [
          row.id,
          sourceCreatedAt,
        ]);
        row.created_at = new Date(sourceCreatedAt).toISOString();
        row.updated_at = row.created_at;
      }
      const clocks = await this.tickets.clocksOf(tx, row.id);
      return this.toView(row, clocks, machine, requester ?? null, now, await this.calendars.forClocks(tx, clocks));
    });
  }

  async patch(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    dto: PatchTicketDto,
    bound?: Tx,
  ): Promise<TicketView> {
    const correlationId = ctx.requestId ?? randomUUID();
    return this.inTx(principal, bound, async (tx) => {
      const before = await this.lock(tx, idOrKey);
      if (OPEN_STATES_EXCLUDED.includes(before.state)) throw new ConflictException({ code: 'ticket_closed' });
      const assignments: Record<string, unknown> = {};
      const entries: AuditEntry[] = [];
      for (const field of [
        'short_description',
        'description',
        'category',
        'impact',
        'urgency',
        'external_refs',
      ] as const) {
        if (dto[field] !== undefined) assignments[field] = dto[field];
      }
      if (dto.contract_id !== undefined && dto.contract_id !== before.contract_id) {
        const contract = await this.resolveContract(tx, before.account_id, dto.contract_id);
        assignments.contract_id = contract.id;
      }
      if (dto.group_id !== undefined) {
        if (dto.group_id) await this.assertGroup(tx, dto.group_id);
        assignments.group_id = dto.group_id;
      }
      if (dto.ticket_group_id !== undefined && dto.ticket_group_id !== before.ticket_group_id) {
        if (dto.ticket_group_id) await this.assertTicketGroup(tx, before.account_id, dto.ticket_group_id);
        assignments.ticket_group_id = dto.ticket_group_id;
        entries.push({
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'ticket.grouped',
          field: 'ticket_group_id',
          oldValue: before.ticket_group_id,
          newValue: dto.ticket_group_id,
        });
      }
      let newAssignee: { id: string; first_name: string; last_name: string; email: string } | null | undefined;
      if (dto.assignee_id !== undefined && dto.assignee_id !== before.assignee_id) {
        newAssignee = dto.assignee_id ? await this.assertAssignable(tx, dto.assignee_id) : null;
        assignments.assignee_id = newAssignee?.id ?? null;
        assignments.assignee_name = newAssignee ? name(newAssignee) : null;
      }

      // Priority: re-derived from the matrix when impact or urgency change,
      // unless overridden; a direct priority needs the permission and is
      // audited with the matrix value it replaced.
      const { matrix, versionId: matrixVersionId } = await this.config.priorityMatrix(tx, before.account_id);
      const impact = (assignments.impact ?? before.impact) as Level | null;
      const urgency = (assignments.urgency ?? before.urgency) as Level | null;
      const derived = matrix.derive(impact, urgency);
      let nextPriority: Priority = before.priority;
      if (dto.priority !== undefined) {
        if (!principal.permissions.has('tickets:override-priority'))
          throw new ForbiddenException({ code: 'forbidden', permission: 'tickets:override-priority' });
        nextPriority = dto.priority;
        if (dto.priority !== derived) {
          assignments.priority_overridden = true;
          entries.push({
            entityKind: 'ticket',
            entityId: before.id,
            ticketId: before.id,
            eventType: 'ticket.priority_overridden',
            field: 'priority',
            oldValue: derived,
            newValue: dto.priority,
          });
        } else {
          assignments.priority_overridden = false;
        }
      } else if (
        !before.priority_overridden &&
        (assignments.impact !== undefined || assignments.urgency !== undefined)
      ) {
        nextPriority = derived;
        assignments.matrix_version_id = matrixVersionId;
      }
      if (nextPriority !== before.priority) assignments.priority = nextPriority;

      const after = await this.tickets.update(tx, before.id, dto.version, assignments);
      entries.push(
        ...this.audit.diff(
          'ticket',
          before.id,
          'ticket.updated',
          before as never,
          after as never,
          [
            'short_description',
            'description',
            'category',
            'impact',
            'urgency',
            'priority',
            'group_id',
            'contract_id',
            'external_refs',
          ],
          { ticketId: before.id },
        ),
      );
      if (assignments.group_id !== undefined && assignments.group_id !== before.group_id) {
        entries.push({
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'ticket.group_assigned',
          field: 'group_id',
          oldValue: before.group_id,
          newValue: (assignments.group_id as string | null) ?? null,
        });
      }
      if (newAssignee !== undefined) {
        entries.push({
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'ticket.assigned',
          field: 'assignee_id',
          oldValue: before.assignee_id,
          newValue: newAssignee?.id ?? null,
        });
      }
      if (entries.length === 0) {
        // Nothing changed; the audit guard needs no event and the version was bumped. Record a no-op update.
        entries.push({
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'ticket.updated',
          field: 'version',
          oldValue: before.version,
          newValue: after.version,
        });
      }
      await this.audit.account(
        tx,
        before.account_id,
        actorOf(principal),
        { requestId: ctx.requestId, correlationId },
        entries,
      );

      // Restamp live clocks when the priority changed.
      const clocks = await this.tickets.clocksOf(tx, before.id);
      if (nextPriority !== before.priority) {
        const contract = await this.contracts.byId(tx, after.contract_id);
        const targets = await this.targetsFor(tx, contract.sla_policy, before.account_id, before.type, nextPriority);
        const now = new Date();
        for (const clockRow of clocks) {
          const target =
            clockRow.kind === 'response' ? targets.targets.response_minutes : targets.targets.resolution_minutes;
          if (!target) continue;
          const restamped = restampForPriority(
            toClock(clockRow),
            target,
            await this.calendars.byId(tx, clockRow.calendar_id),
            now,
          );
          await this.tickets.saveClock(tx, clockRow.id, restamped);
        }
      }
      if (ctx.origin !== 'import')
        await this.outbox.write(tx, {
          accountId: before.account_id,
          aggregate: 'ticket',
          aggregateId: before.id,
          eventType: 'ticket.updated',
          correlationId,
          origin: ctx.origin,
          payload: { fields: entries.map((entry) => entry.field).filter(Boolean) },
        });
      if (ctx.origin !== 'import' && assignments.group_id !== undefined && assignments.group_id !== before.group_id) {
        await this.outbox.write(tx, {
          accountId: before.account_id,
          aggregate: 'ticket',
          aggregateId: before.id,
          eventType: 'ticket.group_assigned',
          correlationId,
          origin: ctx.origin,
          payload: { group_id: assignments.group_id ?? null, previous_group_id: before.group_id },
        });
      }
      if (newAssignee) {
        await this.tickets.ensureWatcher(tx, before.account_id, before.id, newAssignee.id, 'assignee');
        if (newAssignee.id !== principal.userId)
          await this.notifyAssignment(tx, after, newAssignee.id, principal.displayName, correlationId);
      }
      const machine = await this.machineFor(tx, after, new Map());
      const finalClocks = await this.tickets.clocksOf(tx, before.id);
      return this.toView(
        after,
        finalClocks,
        machine,
        null,
        new Date(),
        await this.calendars.forClocks(tx, finalClocks),
      );
    });
  }

  async transition(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    dto: TransitionDto,
    bound?: Tx,
  ): Promise<TicketView | PortalTicketView> {
    const correlationId = ctx.requestId ?? randomUUID();
    return this.inTx(principal, bound, async (tx) => {
      const before = await this.lock(tx, idOrKey);
      if (before.version !== dto.version)
        throw new ConflictException({ code: 'stale_version', version: before.version });
      const machine = await this.machineFor(tx, before, new Map());
      const actor = { kind: principal.kind === 'portal' ? ('portal' as const) : ('internal' as const) };
      if (!machine.canTransition(before.state, dto.to, actor)) {
        throw new ConflictException({
          code: 'invalid_transition',
          from: before.state,
          to: dto.to,
          allowed: machine.available(before.state, actor).map((t) => t.to),
        });
      }
      const requirements = machine.requirements(before.state, dto.to);
      // The change window the ticket belongs to, if any: the same record the
      // change calendar and GET /v1/change-calendar/at read (TM-10, TM-18).
      const groupRow = before.ticket_group_id ? await this.groups.byId(tx, before.ticket_group_id) : undefined;
      const windowRow =
        groupRow && groupRow.kind === 'change_window' && groupRow.status !== 'cancelled' ? groupRow : undefined;
      const span = windowRow ? windowSpan(windowRow) : null;
      const codes = await this.resolutionCodes(tx, before.account_id);
      const missing = checkRequirements(
        requirements,
        {
          pauseReason: dto.pause_reason,
          resolution: dto.resolution && {
            code: dto.resolution.code,
            notes: dto.resolution.notes,
            solutionArticleId: dto.resolution.solution_article_id,
            solutionCandidate: dto.resolution.solution_candidate,
            timeExemptionReason: dto.resolution.time_exemption_reason,
          },
        },
        {
          loggedMinutes: await this.time.loggedMinutes(tx, before.id),
          inChangeWindow: span !== null,
          noSolutionCodes: codes.noSolution,
          knownCodes: codes.known,
        },
      );
      // Requirements the month does not enforce yet (approval, plans, windows, workaround) are recorded, not blocking.
      if (missing.length > 0) throw new ConflictException({ code: 'missing_requirements', items: missing });

      const now = new Date();
      const windowNotes = this.assertChangeWindow(
        principal,
        before,
        requirements,
        machine.effects(dto.to),
        windowRow,
        span,
        dto.change_window_reason,
        now,
        windowRow ? await this.conflictsFor(tx, before, windowRow, span) : [],
      );
      const transitionDef = machine.transition(before.state, dto.to)!;
      const fromEffects = machine.effects(before.state);
      const toEffects = machine.effects(dto.to);
      const assignments: Record<string, unknown> = { state: dto.to };
      const entries: AuditEntry[] = [
        {
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'ticket.transition',
          field: 'state',
          oldValue: before.state,
          newValue: dto.to,
        },
      ];
      entries.push(...windowNotes);
      const outboxEvents: { type: string; payload: Record<string, unknown> }[] = [
        { type: 'ticket.transitioned', payload: { from: before.state, to: dto.to } },
      ];

      // Clocks: latch first, then apply the state effects, then latch again after a resume.
      const clockRows = await this.tickets.clocksOf(tx, before.id);
      const clocks = new Map<string, Clock>(clockRows.map((row) => [row.id, toClock(row)]));
      const apply = (id: string, next: Clock): void => {
        clocks.set(id, next);
      };
      for (const [id, clock] of clocks) {
        const result = latch(clock, now);
        if (result.latched) {
          apply(id, result.clock);
          entries.push({
            entityKind: 'ticket',
            entityId: before.id,
            ticketId: before.id,
            eventType: 'sla.breached',
            field: clock.kind,
            newValue: result.clock.dueAt.toISOString(),
          });
          outboxEvents.push({ type: 'sla.breached', payload: { kind: clock.kind } });
        }
      }
      if (fromEffects.pause && !toEffects.pause) {
        let excluded = 0;
        for (const [id, clock] of clocks) {
          const result = resume(clock, await this.calendars.byId(tx, clock.calendarId), now);
          apply(id, result.clock);
          excluded = Math.max(excluded, result.excludedMinutes);
        }
        await this.tickets.endOpenPauses(tx, before.id, principal.userId, now, excluded);
        entries.push({
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'sla.resumed',
          newValue: { excluded_minutes: excluded },
        });
        outboxEvents.push({ type: 'sla.resumed', payload: { excluded_minutes: excluded } });
        for (const [id, clock] of clocks) {
          const result = latch(clock, now);
          if (result.latched) {
            apply(id, result.clock);
            entries.push({
              entityKind: 'ticket',
              entityId: before.id,
              ticketId: before.id,
              eventType: 'sla.breached',
              field: clock.kind,
              newValue: result.clock.dueAt.toISOString(),
            });
            outboxEvents.push({ type: 'sla.breached', payload: { kind: clock.kind } });
          }
        }
      }
      if (toEffects.pause && !fromEffects.pause) {
        for (const [id, clock] of clocks) apply(id, pause(clock, now));
        await this.tickets.insertPause(
          tx,
          before.account_id,
          before.id,
          dto.pause_reason!,
          dto.note ?? null,
          principal.userId,
          now,
        );
        entries.push({
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'sla.paused',
          newValue: { reason: dto.pause_reason },
        });
        outboxEvents.push({ type: 'sla.paused', payload: { reason: dto.pause_reason } });
      }
      if (toEffects.responseMet && !before.first_response_at && actor.kind === 'internal') {
        assignments.first_response_at = now;
        for (const [id, clock] of clocks) if (clock.kind === 'response') apply(id, markMet(clock, now));
      }
      if (toEffects.resolve && dto.resolution?.solution_article_id) {
        const article = await this.knowledge.byId(tx, dto.resolution.solution_article_id);
        if (article.status !== 'published' || !article.published_version_id) {
          throw new ConflictException({ code: 'article_not_published', article: article.display_key });
        }
        await this.knowledge.insertSolution(tx, {
          accountId: before.account_id,
          ticketId: before.id,
          articleId: article.id,
          versionId: article.published_version_id,
          outcome: 'resolved_by',
          actorKind: actorKindOf(principal),
          actorId: principal.userId,
          actorName: principal.displayName,
        });
        entries.push({
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'ticket.updated',
          field: 'solution',
          newValue: { article: article.display_key, outcome: 'resolved_by' },
        });
      }
      if (toEffects.resolve) {
        assignments.resolved_at = now;
        for (const [id, clock] of clocks) if (clock.kind === 'resolution') apply(id, markMet(clock, now));
        if (dto.resolution) {
          assignments.resolution_code = dto.resolution.code ?? null;
          assignments.resolution_notes = dto.resolution.notes ?? null;
          assignments.solution_article_id = dto.resolution.solution_article_id ?? null;
          assignments.solution_candidate = Boolean(dto.resolution.solution_candidate);
          assignments.time_exemption_reason = dto.resolution.time_exemption_reason ?? null;
        }
      }
      if (toEffects.close) assignments.closed_at = now;
      if (toEffects.cancel) assignments.cancelled_at = now;
      if (transitionDef.reopen) {
        assignments.resolved_at = null;
        assignments.reopen_count = before.reopen_count + 1;
      }
      for (const [id, clock] of clocks) await this.tickets.saveClock(tx, id, clock);
      assignments.sla_response_breached = [...clocks.values()].some(
        (clock) => clock.kind === 'response' && clock.breachedAt !== null,
      );
      assignments.sla_resolution_breached = [...clocks.values()].some(
        (clock) => clock.kind === 'resolution' && clock.breachedAt !== null,
      );

      const after = await this.tickets.update(tx, before.id, dto.version, assignments);
      entries.push(
        ...this.audit.diff(
          'ticket',
          before.id,
          'ticket.updated',
          before as never,
          after as never,
          ['resolution_code', 'resolution_notes', 'solution_article_id', 'time_exemption_reason', 'reopen_count'],
          { ticketId: before.id },
        ),
      );
      await this.audit.account(
        tx,
        before.account_id,
        actorOf(principal),
        { requestId: ctx.requestId, correlationId },
        entries,
      );
      for (const event of outboxEvents) {
        await this.outbox.write(tx, {
          accountId: before.account_id,
          aggregate: 'ticket',
          aggregateId: before.id,
          eventType: event.type,
          correlationId,
          origin: ctx.origin,
          payload: event.payload,
        });
      }
      if (dto.note && !toEffects.pause) {
        await this.tickets.insertWorkNote(tx, {
          accountId: before.account_id,
          ticketId: before.id,
          authorKind: 'user',
          authorId: principal.userId,
          authorName: principal.displayName,
          body: dto.note,
          source: 'internal',
        });
      }
      await this.notifyWatchers(
        tx,
        after,
        principal,
        'ticket.transitioned',
        `${ticketKey(after.number)} moved to ${machine.state(after.state)?.label ?? after.state}`,
        correlationId,
      );
      const requester = after.requester_contact_id
        ? await this.tickets.contactById(tx, after.requester_contact_id).catch(() => undefined)
        : undefined;
      if (principal.kind === 'portal') return this.toPortalView(after, machine, requester);
      const finalClocks = await this.tickets.clocksOf(tx, before.id);
      return this.toView(
        after,
        finalClocks,
        machine,
        requester ?? null,
        now,
        await this.calendars.forClocks(tx, finalClocks),
      );
    });
  }

  async addComment(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    dto: MessageDto,
    bound?: Tx,
    overrides?: MessageOverrides,
  ): Promise<unknown> {
    const correlationId = ctx.requestId ?? randomUUID();
    const importing = ctx.origin === 'import';
    return this.inTx(principal, bound, async (tx) => {
      const ticket = await this.lock(tx, idOrKey);
      const isOperator = importing
        ? (overrides?.operatorResponse ?? false)
        : principal.kind === 'internal' || principal.kind === 'api_client';
      const firstResponse = isOperator && !ticket.first_response_at;
      const now = overrides?.createdAt ?? new Date();
      const comment = await this.tickets.insertComment(tx, {
        accountId: ticket.account_id,
        ticketId: ticket.id,
        authorKind: overrides?.authorKind ?? actorKindOf(principal),
        authorId: principal.userId,
        authorName: overrides?.authorName ?? principal.displayName,
        body: dto.body,
        source: importing
          ? 'import'
          : ctx.origin?.startsWith('sync:')
            ? 'sync'
            : principal.kind === 'portal'
              ? 'portal'
              : 'internal',
        isFirstResponse: firstResponse,
      });
      if (overrides?.createdAt)
        await tx.query('update acct.comments set created_at = $2 where id = $1', [comment.id, overrides.createdAt]);
      const entries: AuditEntry[] = [
        {
          entityKind: 'comment',
          entityId: comment.id,
          ticketId: ticket.id,
          eventType: 'comment.created',
          newValue: { source: comment.source },
        },
      ];
      if (firstResponse) {
        const clocks = await this.tickets.clocksOf(tx, ticket.id);
        for (const clockRow of clocks) {
          if (clockRow.kind !== 'response') continue;
          const latched = latch(toClock(clockRow), now);
          const met = markMet(latched.clock, now);
          await this.tickets.saveClock(tx, clockRow.id, met);
          if (latched.latched)
            entries.push({
              entityKind: 'ticket',
              entityId: ticket.id,
              ticketId: ticket.id,
              eventType: 'sla.breached',
              field: 'response',
            });
          entries.push({
            entityKind: 'ticket',
            entityId: ticket.id,
            ticketId: ticket.id,
            eventType: 'sla.met',
            field: 'response',
            newValue: now.toISOString(),
          });
        }
        await this.tickets.update(tx, ticket.id, ticket.version, {
          first_response_at: now,
          sla_response_breached: false,
        });
      }
      await this.audit.account(
        tx,
        ticket.account_id,
        actorOf(principal),
        { requestId: ctx.requestId, correlationId },
        entries,
      );
      if (importing) return comment;
      await this.outbox.write(tx, {
        accountId: ticket.account_id,
        aggregate: 'ticket',
        aggregateId: ticket.id,
        eventType: 'comment.created',
        correlationId,
        origin: ctx.origin,
        payload: { comment_id: comment.id, source: comment.source },
      });
      await this.tickets.ensureWatcher(tx, ticket.account_id, ticket.id, principal.userId, 'commenter');
      await this.notifyWatchers(
        tx,
        ticket,
        principal,
        'comment.created',
        `${principal.displayName} replied on ${ticketKey(ticket.number)}`,
        correlationId,
      );
      return comment;
    });
  }

  async addWorkNote(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    dto: MessageDto,
    bound?: Tx,
    overrides?: MessageOverrides,
  ): Promise<unknown> {
    const importing = ctx.origin === 'import';
    if (principal.kind === 'portal') throw new ForbiddenException({ code: 'wrong_realm' });
    const correlationId = ctx.requestId ?? randomUUID();
    return this.inTx(principal, bound, async (tx) => {
      const ticket = await this.load(tx, idOrKey);
      const note = await this.tickets.insertWorkNote(tx, {
        accountId: ticket.account_id,
        ticketId: ticket.id,
        authorKind: overrides?.authorKind ?? 'user',
        authorId: principal.userId,
        authorName: overrides?.authorName ?? principal.displayName,
        body: dto.body,
        source: importing ? 'import' : ctx.origin?.startsWith('sync:') ? 'sync' : 'internal',
      });
      if (overrides?.createdAt)
        await tx.query('update acct.work_notes set created_at = $2 where id = $1', [note.id, overrides.createdAt]);
      await this.audit.account(tx, ticket.account_id, actorOf(principal), { requestId: ctx.requestId, correlationId }, [
        { entityKind: 'work_note', entityId: note.id, ticketId: ticket.id, eventType: 'work_note.created' },
      ]);
      if (importing) return note;
      // Work notes never produce a public-direction outbox event (Security section 5).
      await this.outbox.write(tx, {
        accountId: ticket.account_id,
        aggregate: 'ticket',
        aggregateId: ticket.id,
        eventType: 'work_note.created',
        correlationId,
        origin: ctx.origin,
        payload: { work_note_id: note.id },
      });
      await this.tickets.ensureWatcher(tx, ticket.account_id, ticket.id, principal.userId, 'commenter');
      return note;
    });
  }

  /**
   * Import only (Data Migration technical section 3): places a migrated ticket
   * in its historical state without the close discipline, clocks, outbox or
   * notifications, stamping resolved and closed times from the source. The
   * state must exist in the ticket's machine; the audit event records it as
   * a transition by the migration actor.
   */
  async importState(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    input: { state: string; at?: Date; resolutionCode?: string },
    bound?: Tx,
  ): Promise<TicketView> {
    if (ctx.origin !== 'import') throw new ForbiddenException({ code: 'import_only' });
    return this.inTx(principal, bound, async (tx) => {
      const before = await this.lock(tx, idOrKey);
      const { machine } = await this.config.stateMachine(tx, before.type, before.account_id);
      const definition = machine.state(input.state);
      if (!definition) throw new BadRequestException({ code: 'unknown_state', state: input.state });
      if (before.state === input.state) {
        const clocks = await this.tickets.clocksOf(tx, before.id);
        return this.toView(before, clocks, machine, null, new Date(), new Map());
      }
      const at = input.at ?? new Date();
      const assignments: Record<string, unknown> = { state: input.state };
      if (definition.effects?.resolve) {
        assignments.resolved_at = at;
        if (input.resolutionCode) assignments.resolution_code = input.resolutionCode;
      }
      if (definition.effects?.close) {
        assignments.resolved_at = before.resolved_at ?? at;
        assignments.closed_at = at;
      }
      if (definition.effects?.cancel) assignments.cancelled_at = at;
      const after = await this.tickets.update(tx, before.id, before.version, assignments);
      await this.audit.account(tx, before.account_id, actorOf(principal), { requestId: ctx.requestId }, [
        {
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'ticket.transition',
          field: 'state',
          oldValue: before.state,
          newValue: input.state,
        },
      ]);
      const clocks = await this.tickets.clocksOf(tx, before.id);
      return this.toView(after, clocks, machine, null, new Date(), new Map());
    });
  }

  async comments(principal: Principal, idOrKey: string, bound?: Tx): Promise<unknown[]> {
    return this.inTx(principal, bound, async (tx) => this.tickets.commentsOf(tx, (await this.load(tx, idOrKey)).id));
  }

  async workNotes(principal: Principal, idOrKey: string, bound?: Tx): Promise<unknown[]> {
    if (principal.kind === 'portal') throw new ForbiddenException({ code: 'wrong_realm' });
    return this.inTx(principal, bound, async (tx) => this.tickets.workNotesOf(tx, (await this.load(tx, idOrKey)).id));
  }

  async links(principal: Principal, idOrKey: string, bound?: Tx): Promise<unknown[]> {
    return this.inTx(principal, bound, async (tx) => this.linksIn(tx, await this.load(tx, idOrKey)));
  }

  private async linksIn(tx: Tx, ticket: TicketRow): Promise<unknown[]> {
    const links = await this.tickets.linksOf(tx, ticket.id);
    const result = [];
    for (const link of links) {
      const otherId = link.from_ticket_id === ticket.id ? link.to_ticket_id : link.from_ticket_id;
      const other = await this.tickets.byId(tx, otherId);
      result.push({
        id: link.id,
        type: link.type,
        direction: link.from_ticket_id === ticket.id ? 'out' : 'in',
        ticket: {
          id: other.id,
          key: ticketKey(other.number),
          short_description: other.short_description,
          state: other.state,
          priority: other.priority,
        },
      });
    }
    return result;
  }

  async addLink(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    toTicketId: string,
    type: string,
    bound?: Tx,
  ): Promise<unknown[]> {
    return this.inTx(principal, bound, async (tx) => {
      const ticket = await this.load(tx, idOrKey);
      const target = await this.tickets.byId(tx, toTicketId);
      if (target.account_id !== ticket.account_id) throw new NotFoundException({ code: 'not_found', entity: 'ticket' });
      if (target.id === ticket.id) throw new BadRequestException({ code: 'self_link' });
      if (type === 'parent' || type === 'blocks') await this.assertAcyclic(tx, ticket.id, target.id, type);
      await this.tickets.insertLink(tx, ticket.account_id, ticket.id, target.id, type, principal.userId);
      await this.audit.account(tx, ticket.account_id, actorOf(principal), { requestId: ctx.requestId }, [
        {
          entityKind: 'ticket',
          entityId: ticket.id,
          ticketId: ticket.id,
          eventType: 'ticket.updated',
          field: `link.${type}`,
          newValue: ticketKey(target.number),
        },
      ]);
      return this.linksIn(tx, ticket);
    });
  }

  async removeLink(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    linkId: string,
    bound?: Tx,
  ): Promise<void> {
    await this.inTx(principal, bound, async (tx) => {
      const ticket = await this.load(tx, idOrKey);
      const removed = await this.tickets.deleteLink(tx, linkId);
      if (removed === 0) throw new NotFoundException({ code: 'not_found', entity: 'ticket_link' });
      await this.audit.account(tx, ticket.account_id, actorOf(principal), { requestId: ctx.requestId }, [
        {
          entityKind: 'ticket',
          entityId: ticket.id,
          ticketId: ticket.id,
          eventType: 'ticket.updated',
          field: 'link.removed',
          oldValue: linkId,
        },
      ]);
    });
  }

  async watch(principal: Principal, idOrKey: string, muted: boolean, bound?: Tx): Promise<{ muted: boolean }> {
    return this.inTx(principal, bound, async (tx) => {
      const ticket = await this.load(tx, idOrKey);
      await this.tickets.ensureWatcher(tx, ticket.account_id, ticket.id, principal.userId, 'explicit');
      await this.tickets.setMuted(tx, ticket.id, principal.userId, muted);
      return { muted };
    });
  }

  // Helpers -------------------------------------------------------------------

  /** Runs in the caller's transaction when one is bound (the portal write path), else in a fresh unit of work. */
  // The out-of-scope flag and its approval (TM-11) -----------------------------

  /**
   * Flags work as outside the contract scope, or withdraws a flag still
   * waiting for a decision. Anyone who works tickets may raise it; the
   * account's contract managers are told, because they are the people who
   * decide what the client is entitled to and they are the same list the
   * budget thresholds already notify.
   */
  async flagScope(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    dto: ScopeFlagDto,
    bound?: Tx,
  ): Promise<TicketView> {
    const correlationId = ctx.requestId ?? randomUUID();
    return this.inTx(principal, bound, async (tx) => {
      const before = await this.lock(tx, idOrKey);
      if (OPEN_STATES_EXCLUDED.includes(before.state)) throw new ConflictException({ code: 'ticket_closed' });
      const detail = (before.out_of_scope_detail ?? {}) as ScopeDetail;
      if (dto.out_of_scope) {
        if (before.out_of_scope === 'flagged') throw new ConflictException({ code: 'already_flagged' });
        const reason = dto.reason?.trim();
        if (!reason) throw new BadRequestException({ code: 'reason_required' });
        const flaggedAt = new Date().toISOString();
        const after = await this.tickets.update(tx, before.id, dto.version, {
          out_of_scope: 'flagged',
          // A new flag starts a new decision: the previous one is history in
          // the audit stream, not a stale answer on the record.
          out_of_scope_detail: {
            reason,
            flagged_by: principal.userId,
            flagged_by_name: principal.displayName,
            flagged_at: flaggedAt,
          } satisfies ScopeDetail,
        });
        await this.audit.account(
          tx,
          before.account_id,
          actorOf(principal),
          { requestId: ctx.requestId, correlationId },
          [
            {
              entityKind: 'ticket',
              entityId: before.id,
              ticketId: before.id,
              eventType: 'ticket.scope_flagged',
              field: 'out_of_scope',
              oldValue: before.out_of_scope,
              newValue: { state: 'flagged', reason },
            },
          ],
        );
        await this.outbox.write(tx, {
          accountId: before.account_id,
          aggregate: 'ticket',
          aggregateId: before.id,
          eventType: 'ticket.scope_flagged',
          correlationId,
          origin: ctx.origin,
          payload: { reason, flagged_by: principal.userId },
        });
        await this.notifyScopeApprovers(tx, after, principal, reason);
        return this.viewOf(tx, after);
      }
      if (before.out_of_scope !== 'flagged') throw new ConflictException({ code: 'not_flagged' });
      const after = await this.tickets.update(tx, before.id, dto.version, {
        out_of_scope: 'none',
        out_of_scope_detail: { ...detail, withdrawn_at: new Date().toISOString(), withdrawn_by: principal.userId },
      });
      await this.audit.account(tx, before.account_id, actorOf(principal), { requestId: ctx.requestId, correlationId }, [
        {
          entityKind: 'ticket',
          entityId: before.id,
          ticketId: before.id,
          eventType: 'ticket.scope_flagged',
          field: 'out_of_scope',
          oldValue: 'flagged',
          newValue: 'none',
        },
      ]);
      return this.viewOf(tx, after);
    });
  }

  /**
   * Approves or declines a pending flag. Approval may carry an allowance in
   * minutes, which is added to the contract period the ticket bills against
   * so the time logged on it is inside budget rather than over it: the
   * period has no separate overage column, so the allowance lands on
   * `carried_over_minutes`, which is exactly the "extra minutes available
   * this period" the burn maths already adds to the contracted figure, and
   * the audit names the allowance so the increase is never mistaken for a
   * rollover. Declining ends the flag and words why.
   */
  async decideScope(
    principal: Principal,
    ctx: RequestContext,
    idOrKey: string,
    dto: ScopeDecisionDto,
    bound?: Tx,
  ): Promise<TicketView> {
    const correlationId = ctx.requestId ?? randomUUID();
    return this.inTx(principal, bound, async (tx) => {
      const before = await this.lock(tx, idOrKey);
      if (before.out_of_scope !== 'flagged') throw new ConflictException({ code: 'not_flagged' });
      const detail = (before.out_of_scope_detail ?? {}) as ScopeDetail;
      // The person who raised the flag is not the person who decides it
      // (Ticket Management technical 3.3): approval is the client's
      // commercial answer, not the flagger's own.
      if (detail.flagged_by && detail.flagged_by === principal.userId)
        throw new ConflictException({ code: 'flagger_cannot_decide' });
      const approved = dto.decision === 'approve';
      const allowance = approved ? (dto.overage_allowance_minutes ?? 0) : 0;
      const decidedAt = new Date().toISOString();
      const entries: AuditEntry[] = [];
      let period: { id: string; carried_over_minutes: number } | undefined;
      if (allowance > 0) {
        const on = decidedAt.slice(0, 10);
        const current = await this.time.periodFor(tx, before.contract_id, on);
        if (!current) throw new ConflictException({ code: 'no_contract_period', on });
        const updated = await this.time.addCarriedOverMinutes(tx, current.id, allowance);
        period = { id: updated.id, carried_over_minutes: updated.carried_over_minutes };
        entries.push({
          entityKind: 'contract_period',
          entityId: current.id,
          ticketId: before.id,
          eventType: 'ticket.scope_decided',
          field: 'carried_over_minutes',
          oldValue: { minutes: current.carried_over_minutes },
          newValue: {
            minutes: updated.carried_over_minutes,
            out_of_scope_allowance_minutes: allowance,
            ticket_id: before.id,
          },
        });
      }
      const after = await this.tickets.update(tx, before.id, dto.version, {
        out_of_scope: approved ? 'approved' : 'declined',
        out_of_scope_detail: {
          ...detail,
          decision: dto.decision,
          note: dto.note?.trim() || null,
          decided_by: principal.userId,
          decided_by_name: principal.displayName,
          decided_at: decidedAt,
          overage_allowance_minutes: allowance > 0 ? allowance : null,
          contract_period_id: period?.id ?? null,
        } satisfies ScopeDetail,
      });
      entries.unshift({
        entityKind: 'ticket',
        entityId: before.id,
        ticketId: before.id,
        eventType: 'ticket.scope_decided',
        field: 'out_of_scope',
        oldValue: 'flagged',
        newValue: { state: after.out_of_scope, note: dto.note?.trim() || null, allowance_minutes: allowance },
      });
      await this.audit.account(
        tx,
        before.account_id,
        actorOf(principal),
        { requestId: ctx.requestId, correlationId },
        entries,
      );
      await this.outbox.write(tx, {
        accountId: before.account_id,
        aggregate: 'ticket',
        aggregateId: before.id,
        eventType: 'ticket.scope_decided',
        correlationId,
        origin: ctx.origin,
        payload: {
          decision: dto.decision,
          decided_by: principal.userId,
          allowance_minutes: allowance,
          contract_period_id: period?.id ?? null,
        },
      });
      await this.notifyScopeDecision(tx, after, principal, detail, dto.decision, allowance);
      return this.viewOf(tx, after);
    });
  }

  /** The flag needs a decision from the people who own the account's contracts. */
  private async notifyScopeApprovers(tx: Tx, ticket: TicketRow, actor: Principal, reason: string): Promise<void> {
    const key = ticketKey(ticket.number);
    for (const recipientId of await this.time.budgetRecipients(tx, ticket.account_id)) {
      if (recipientId === actor.userId) continue;
      await this.notifications.upsert(tx, {
        accountId: ticket.account_id,
        recipientId,
        type: 'ticket.scope_flagged',
        title: `${key} is flagged out of scope and needs a decision`,
        body: reason,
        targetKind: 'ticket',
        targetId: ticket.id,
        link: `/tickets/${key}`,
        collapseKey: `scope:${ticket.id}`,
      });
    }
  }

  /** The decision goes back to whoever raised the flag. */
  private async notifyScopeDecision(
    tx: Tx,
    ticket: TicketRow,
    actor: Principal,
    detail: ScopeDetail,
    decision: 'approve' | 'decline',
    allowance: number,
  ): Promise<void> {
    if (!detail.flagged_by || detail.flagged_by === actor.userId) return;
    const key = ticketKey(ticket.number);
    await this.notifications.upsert(tx, {
      accountId: ticket.account_id,
      recipientId: detail.flagged_by,
      type: 'ticket.scope_decided',
      title:
        decision === 'approve'
          ? `${key} was approved out of scope${allowance > 0 ? ` with ${allowance} minutes of budget` : ''}`
          : `${key} was declined as out of scope`,
      body: ticket.short_description,
      targetKind: 'ticket',
      targetId: ticket.id,
      link: `/tickets/${key}`,
      collapseKey: `scope-decision:${ticket.id}`,
    });
  }

  /** The computed view of a row the caller has just written, clocks and all. */
  private async viewOf(tx: Tx, row: TicketRow): Promise<TicketView> {
    const machine = await this.machineFor(tx, row, new Map());
    const clocks = await this.tickets.clocksOf(tx, row.id);
    return this.toView(row, clocks, machine, null, new Date(), await this.calendars.forClocks(tx, clocks));
  }

  private inTx<T>(principal: Principal, bound: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return bound ? fn(bound) : this.uow.run(principal, (tx) => fn(tx));
  }

  private async load(tx: Tx, idOrKey: string): Promise<TicketRow> {
    const number = idOrKey.match(/^CS\d{7,}$/i) ? String(Number(idOrKey.slice(2))) : undefined;
    return number ? this.tickets.byNumber(tx, number) : this.tickets.byId(tx, idOrKey);
  }

  private async lock(tx: Tx, idOrKey: string): Promise<TicketRow> {
    const row = await this.load(tx, idOrKey);
    return this.tickets.lock(tx, row.id);
  }

  private async machineFor(tx: Tx, row: TicketRow, cache: Map<string, StateMachine>): Promise<StateMachine> {
    const key = `${row.account_id}:${row.type}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const { machine } = await this.config.stateMachine(tx, row.type, row.account_id);
    cache.set(key, machine);
    return machine;
  }

  private async resolveContract(tx: Tx, accountId: string, contractId?: string) {
    if (contractId) {
      const contract = await this.contracts.byId(tx, contractId);
      if (contract.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'contract' });
      if (!this.contracts.periodOpen(contract, new Date()))
        throw new ConflictException({ code: 'contract_period_closed', contract: contract.key });
      return contract;
    }
    const active = (await this.contracts.activeForAccount(tx, accountId)).filter((contract) =>
      this.contracts.periodOpen(contract, new Date()),
    );
    if (active.length === 1) return active[0];
    if (active.length === 0) throw new ConflictException({ code: 'no_active_contract' });
    throw new BadRequestException({
      code: 'contract_required',
      choices: active.map((contract) => ({ id: contract.id, key: contract.key, name: contract.name })),
    });
  }

  private async ensureContact(tx: Tx, accountId: string, email: string, displayName?: string) {
    const lower = email.toLowerCase();
    return (
      (await this.tickets.contactByEmail(tx, accountId, lower)) ??
      (await this.tickets.insertContact(tx, accountId, lower, displayName ?? lower))
    );
  }

  private async assertAssignable(tx: Tx, userId: string) {
    const user = await this.users.byId(tx, userId);
    if (user.kind !== 'internal' || user.status !== 'active')
      throw new BadRequestException({ code: 'not_assignable', userId });
    return user;
  }

  /**
   * The change window rules (TM-10, TM-18), in one place so the Scheduled
   * gate and the implementation gate cannot drift apart. Returns the audit
   * entries the decision earns; throws a worded 409 where it refuses.
   *
   * Scheduling: the window must not be frozen over its own span, and no other
   * change may already be scheduled on the same configuration item in a
   * window that overlaps it. Both are warnings the spec says must be
   * acknowledged with a reason rather than hard walls, so a reason lets the
   * transition through and lands on the audit.
   *
   * Implementing: the state the machine marks `deploy` may only be entered
   * while the instant is inside the window and outside every freeze. Outside
   * it, only `tickets:override-change-window` plus a reason gets through,
   * and the override is audited.
   */
  private assertChangeWindow(
    principal: Principal,
    before: TicketRow,
    requirements: readonly string[],
    effects: { deploy?: boolean },
    windowRow: TicketGroupRow | undefined,
    span: { startsAt: Date; endsAt: Date } | null,
    reason: string | undefined,
    now: Date,
    conflicts: { key: string; group_name: string }[],
  ): AuditEntry[] {
    const entries: AuditEntry[] = [];
    const note = reason?.trim();
    const audit = (
      eventType: 'ticket.change_window_acknowledged' | 'ticket.change_window_overridden',
      value: unknown,
    ) =>
      entries.push({
        entityKind: 'ticket',
        entityId: before.id,
        ticketId: before.id,
        eventType,
        field: 'ticket_group_id',
        oldValue: before.ticket_group_id,
        newValue: value,
      });

    if (requirements.includes('change_window') && windowRow && span) {
      const window = toChangeWindow(windowRow);
      const freeze = freezeOverlapping(window, span);
      if ((freeze || conflicts.length > 0) && !note) {
        throw new ConflictException(
          freeze
            ? { code: 'change_freeze', window: windowRow.name, freeze }
            : { code: 'change_conflict', window: windowRow.name, conflicts },
        );
      }
      if (freeze || conflicts.length > 0)
        audit('ticket.change_window_acknowledged', {
          reason: note,
          freeze: freeze ?? null,
          conflicts: conflicts.map((row) => row.key),
        });
    }

    if (effects.deploy) {
      const window = windowRow ? toChangeWindow(windowRow) : undefined;
      const frozen = window ? freezeAt(window, now) : undefined;
      const open = window !== undefined && insideWindow(window, now) && frozen === undefined;
      if (!open) {
        const overridable = principal.permissions.has('tickets:override-change-window') && Boolean(note);
        if (!overridable) {
          throw new ConflictException({
            code: window === undefined ? 'change_window_required' : 'outside_change_window',
            window: windowRow?.name ?? null,
            starts_at: span?.startsAt.toISOString() ?? null,
            ends_at: span?.endsAt.toISOString() ?? null,
            freeze: frozen ?? null,
            at: now.toISOString(),
            permission: 'tickets:override-change-window',
          });
        }
        audit('ticket.change_window_overridden', {
          reason: note,
          window: windowRow?.name ?? null,
          at: now.toISOString(),
          freeze: frozen ?? null,
        });
      }
    }
    return entries;
  }

  /** Other changes holding the same configuration item in an overlapping window (TM-18). */
  private async conflictsFor(
    tx: Tx,
    before: TicketRow,
    windowRow: TicketGroupRow,
    span: { startsAt: Date; endsAt: Date } | null,
  ): Promise<{ key: string; group_name: string }[]> {
    if (!span || !before.configuration_item_id) return [];
    return this.groups.conflictsOnItem(tx, before.account_id, before.configuration_item_id, before.id, span);
  }

  private async assertTicketGroup(tx: Tx, accountId: string, groupId: string): Promise<void> {
    const group = await this.groups.byId(tx, groupId);
    if (group.account_id !== accountId) throw new NotFoundException({ code: 'not_found', entity: 'ticket_group' });
    if (group.status === 'cancelled') throw new BadRequestException({ code: 'ticket_group_cancelled', groupId });
  }

  /** The assignment groups the signed-in person belongs to (TM-08). */
  async groupsOf(tx: Tx, principal: Principal): Promise<string[]> {
    if (principal.kind === 'portal') return [];
    return (await this.users.groupsOfUser(tx, principal.userId)).map((row) => row.group_id);
  }

  private async assertGroup(tx: Tx, groupId: string): Promise<void> {
    const group = await this.users.groupById(tx, groupId);
    if (group.status !== 'active') throw new BadRequestException({ code: 'group_retired', groupId });
  }

  private async targetsFor(
    tx: Tx,
    contractPolicy: Record<string, unknown> | null,
    accountId: string,
    type: string,
    priority: string,
  ) {
    const policy = contractPolicy as unknown as SlaTargetsBody | null;
    if (policy?.targets?.[type]?.[priority]) {
      return { policyRef: 'contract', targets: policy.targets[type][priority] };
    }
    const resolved = await this.config.resolve<SlaTargetsBody>(tx, 'sla_policy', '*', accountId);
    const targets = resolved.body.targets?.[type]?.[priority] ?? { response_minutes: null, resolution_minutes: null };
    return { policyRef: `default:${resolved.versionId}`, targets };
  }

  private async resolutionCodes(tx: Tx, accountId: string): Promise<{ known: Set<string>; noSolution: Set<string> }> {
    const resolved = await this.config.resolve<ResolutionCodesBody>(tx, 'resolution_codes', '*', accountId);
    return {
      known: new Set(resolved.body.items.map((item) => item.key)),
      noSolution: new Set(resolved.body.items.filter((item) => item.no_solution).map((item) => item.key)),
    };
  }

  private async assertAcyclic(tx: Tx, fromId: string, toId: string, type: string): Promise<void> {
    // Walk from the target along links of the same type; reaching the source means a cycle.
    const seen = new Set<string>();
    const stack = [toId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === fromId) throw new ConflictException({ code: 'link_cycle', type });
      if (seen.has(current)) continue;
      seen.add(current);
      for (const link of await this.tickets.linksOf(tx, current)) {
        if (link.type === type && link.from_ticket_id === current) stack.push(link.to_ticket_id);
      }
    }
  }

  private async notifyAssignment(
    tx: Tx,
    ticket: TicketRow,
    assigneeId: string,
    byName: string,
    correlationId: string,
  ): Promise<void> {
    await this.notifications.upsert(tx, {
      accountId: ticket.account_id,
      recipientId: assigneeId,
      type: 'ticket.assigned',
      title: `${ticketKey(ticket.number)} assigned to you by ${byName}`,
      body: ticket.short_description,
      targetKind: 'ticket',
      targetId: ticket.id,
      link: `/tickets/${ticketKey(ticket.number)}`,
      collapseKey: `assigned:${ticket.id}`,
    });
    await this.outbox.write(tx, {
      accountId: ticket.account_id,
      aggregate: 'ticket',
      aggregateId: ticket.id,
      eventType: 'ticket.assigned',
      correlationId,
      payload: { assignee_id: assigneeId },
    });
  }

  private async notifyWatchers(
    tx: Tx,
    ticket: TicketRow,
    actor: Principal,
    type: string,
    title: string,
    correlationId: string,
  ): Promise<void> {
    const watchers = await this.tickets.watchersOf(tx, ticket.id);
    for (const watcher of watchers) {
      if (watcher.user_id === actor.userId || watcher.muted_at) continue;
      await this.notifications.upsert(tx, {
        accountId: ticket.account_id,
        recipientId: watcher.user_id,
        type,
        title,
        body: ticket.short_description,
        targetKind: 'ticket',
        targetId: ticket.id,
        link: `/tickets/${ticketKey(ticket.number)}`,
        collapseKey: `${type}:${ticket.id}`,
      });
    }
    void correlationId;
  }

  private toView(
    row: TicketRow,
    clocks: ClockRow[],
    machine: StateMachine,
    requester: { id: string; email: string; display_name: string } | null,
    now: Date,
    calendars: Map<string, Calendar> = new Map(),
  ): TicketView {
    const sla: TicketView['sla'] = {};
    for (const clockRow of clocks)
      sla[clockRow.kind] = clockView(toClock(clockRow), calendars.get(clockRow.calendar_id) ?? WALL_CLOCK, now);
    return {
      id: row.id,
      key: ticketKey(row.number),
      account_id: row.account_id,
      type: row.type,
      state: row.state,
      state_label: machine.state(row.state)?.label ?? row.state,
      short_description: row.short_description,
      description: row.description,
      category: row.category,
      impact: row.impact,
      urgency: row.urgency,
      priority: row.priority,
      priority_overridden: row.priority_overridden,
      source: row.source,
      requester: requester ? { id: requester.id, email: requester.email, display_name: requester.display_name } : null,
      group_id: row.group_id,
      ticket_group_id: row.ticket_group_id,
      assignee_id: row.assignee_id,
      assignee_name: row.assignee_name,
      contract_id: row.contract_id,
      resolution: {
        code: row.resolution_code,
        notes: row.resolution_notes,
        solution_article_id: row.solution_article_id,
        solution_candidate: row.solution_candidate,
        time_exemption_reason: row.time_exemption_reason,
      },
      scope: scopeView(row),
      external_refs: row.external_refs,
      form_version_id: row.form_version_id,
      form_data: row.form_data ?? {},
      reopen_count: row.reopen_count,
      first_response_at: row.first_response_at,
      resolved_at: row.resolved_at,
      closed_at: row.closed_at,
      cancelled_at: row.cancelled_at,
      sla,
      created_by: row.created_by,
      created_by_name: row.created_by_name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version,
    };
  }

  private toPortalView(row: TicketRow, machine: StateMachine, requester?: { display_name: string }): PortalTicketView {
    return {
      id: row.id,
      key: ticketKey(row.number),
      type: row.type,
      state: row.state,
      state_label: machine.state(row.state)?.label ?? row.state,
      short_description: row.short_description,
      description: row.description,
      category: row.category,
      priority: row.priority,
      form_version_id: row.form_version_id,
      form_data: row.form_data ?? {},
      requester: requester ? { display_name: requester.display_name } : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      resolved_at: row.resolved_at,
      closed_at: row.closed_at,
      version: row.version,
    };
  }
}

/** The flag and the decision as the record shows them; absent fields read as null, never undefined. */
function scopeView(row: TicketRow): ScopeView {
  const detail = (row.out_of_scope_detail ?? {}) as ScopeDetail;
  return {
    out_of_scope: row.out_of_scope,
    reason: detail.reason ?? null,
    flagged_by: detail.flagged_by ?? null,
    flagged_by_name: detail.flagged_by_name ?? null,
    flagged_at: detail.flagged_at ?? null,
    decision: detail.decision ?? null,
    note: detail.note ?? null,
    decided_by: detail.decided_by ?? null,
    decided_by_name: detail.decided_by_name ?? null,
    decided_at: detail.decided_at ?? null,
    overage_allowance_minutes: detail.overage_allowance_minutes ?? null,
  };
}

function name(user: { first_name: string; last_name: string; email: string }): string {
  return `${user.first_name} ${user.last_name}`.trim() || user.email;
}

function decodeConditions(encoded: string): ConditionSet {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ConditionSet;
    return parsed;
  } catch {
    throw new BadRequestException({ code: 'bad_conditions' });
  }
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt, i: id })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { u: string; i: string };
    if (typeof parsed.u !== 'string' || typeof parsed.i !== 'string') return undefined;
    return { updatedAt: parsed.u, id: parsed.i };
  } catch {
    throw new BadRequestException({ code: 'bad_cursor' });
  }
}
