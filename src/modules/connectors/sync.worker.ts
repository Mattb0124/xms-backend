import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OBJECT_STORE } from '../../common/storage/storage.module.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import type { RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService, SYSTEM_ACTOR } from '../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import {
  defaultSor,
  resolveInboundState,
  resolveOutboundState,
  translateInbound,
  translateOutbound,
  XMS_FIELDS,
  type FieldMap,
  type StateMap,
  type XmsField,
} from '../../domain/sync/maps.js';
import {
  decideEnqueue,
  decideInbound,
  decideOutbound,
  externalChangedSince,
  hasJournalMarker,
  isOutboundEvent,
  isReflection,
  journalMarker,
  outboundHash,
  outboundNextAttempt,
  syncOrigin,
} from '../../domain/sync/rules.js';
import { DbPools } from '../../db/pool.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import type { Job } from '../../worker/jobs.js';
import type { OutboxRow } from '../../worker/outbox-dispatcher.js';
import { AttachmentsService } from '../attachments/attachments.module.js';
import { TicketsService, type TicketView } from '../tickets/tickets.service.js';
import type { CreateTicketDto, PatchTicketDto, TransitionDto } from '../tickets/tickets.dto.js';
import { coerceFieldMap, ConnectorsService } from './connectors.service.js';
import {
  ConnectorsRepository,
  type InboxRow,
  type InstanceRow,
  type LinkRow,
  type OutboundRow,
} from './connectors.repository.js';
import {
  fromSnowTime,
  SnowError,
  type JournalEntry,
  type SnowAttachment,
  type SnowClient,
  type SnowRecord,
} from './snow-client.js';
import { SnowClientFactory } from './snow-client.factory.js';

const PAGE = 200;
const MAX_INBOX_ATTEMPTS = 5;

/**
 * The connector worker (ServiceNow Sync technical 3.3, 3.4, 3.6): the
 * poller writes inbox rows behind a watermark that only advances after the
 * page is stored; the apply handler turns each inbox row into domain calls
 * through the ticket service as the instance's sync principal with origin
 * `sync:<instance>`, so nothing echoes back; the health job derives the
 * per-instance state from the runs and trips the switch at the threshold.
 * Every attempt is a sync run row.
 */
@Injectable()
export class SyncWorker {
  private readonly logger = new Logger(SyncWorker.name);

  constructor(
    private readonly pools: DbPools,
    private readonly uow: UnitOfWork,
    private readonly repo: ConnectorsRepository,
    private readonly connectors: ConnectorsService,
    private readonly clients: SnowClientFactory,
    private readonly tickets: TicketsService,
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  pollJob(intervalMs = 10_000): Job {
    return { name: 'connectors.poll', intervalMs, run: () => this.pollDue() };
  }

  applyJob(intervalMs = 5_000): Job {
    return { name: 'connectors.apply', intervalMs, run: () => this.applyPending() };
  }

  healthJob(intervalMs = 60_000): Job {
    return { name: 'connectors.health', intervalMs, run: () => this.recomputeHealth() };
  }

  // Poll ---------------------------------------------------------------------

  /** One pass over the due instances. Returns a summary line. */
  async pollDue(): Promise<string> {
    const accounts = await this.liveAccounts();
    if (accounts.length === 0) return 'polled 0';
    const summary: string[] = [];
    await this.uow.perAccount(accounts, async (tx) => {
      const due = await this.repo.claimDue(tx);
      for (const instance of due) summary.push(await this.pollOne(tx, instance));
    });
    return `polled ${summary.length}${summary.length ? `: ${summary.join('; ')}` : ''}`;
  }

  async pollOne(tx: Tx, instance: InstanceRow): Promise<string> {
    const started = Date.now();
    const next = new Date(Date.now() + instance.poll_interval_seconds * 1000);
    try {
      const client = await this.clients.forInstance(instance);
      const watermark = new Date(instance.inbound_watermark);
      const records = await client.changedSince(
        instance.table_name,
        watermark,
        instance.inbound_watermark_sys_id,
        PAGE,
      );
      let inserted = 0;
      let duplicates = 0;
      for (const record of records) {
        const journal = await client.journal(record.sys_id, watermark.getTime() > 0 ? watermark : null);
        // Metadata only: the bytes are fetched on apply, once the row has a
        // ticket to hang them on and the size has been judged.
        const attachments = await client.attachments(record.sys_id);
        const id = await this.repo.insertInbox(tx, {
          instanceId: instance.id,
          externalId: record.sys_id,
          externalVersion: record.sys_updated_on,
          accountId: instance.account_id,
          payload: { instance_id: instance.id, record, journal, attachments },
        });
        if (id) inserted += 1;
        else duplicates += 1;
      }
      const last = records.at(-1);
      await this.repo.touchInstance(tx, instance.id, {
        next_poll_at: next,
        last_success_at: new Date(),
        last_error: null,
        credential_state: 'valid',
        ...(last
          ? { inbound_watermark: fromSnowTime(last.sys_updated_on), inbound_watermark_sys_id: last.sys_id }
          : {}),
      });
      await this.repo.insertRun(tx, {
        accountId: instance.account_id,
        instanceId: instance.id,
        direction: 'poll',
        outcome: 'success',
        durationMs: Date.now() - started,
        detail: { fetched: records.length, inserted, duplicates },
      });
      return `${instance.name}: ${inserted} new, ${duplicates} duplicate`;
    } catch (error) {
      const detail =
        error instanceof SnowError ? `${error.status}: ${error.detail.slice(0, 200)}` : (error as Error).message;
      const credentialInvalid = error instanceof SnowError && (error.status === 401 || error.status === 403);
      await this.repo.touchInstance(tx, instance.id, {
        next_poll_at: next,
        last_error: detail,
        last_error_at: new Date(),
        ...(credentialInvalid ? { credential_state: 'invalid' } : {}),
      });
      await this.repo.insertRun(tx, {
        accountId: instance.account_id,
        instanceId: instance.id,
        direction: 'poll',
        outcome: 'retried',
        errorClass: error instanceof SnowError ? error.errorClass : 'retryable',
        errorText: detail,
        durationMs: Date.now() - started,
      });
      this.logger.warn(`poll ${instance.name} failed: ${detail}`);
      return `${instance.name}: failed (${detail})`;
    }
  }

  // Apply --------------------------------------------------------------------

  async applyPending(): Promise<string> {
    const accounts = await this.liveAccounts();
    if (accounts.length === 0) return 'applied 0';
    const instances = (await this.uow.perAccount(accounts, (tx) => this.repo.allInstances(tx))).flat();
    let applied = 0;
    let failed = 0;
    for (const instance of instances) {
      if (instance.mode === 'off' || instance.kill_switch === 'tripped') continue;
      const rows = await this.uow.worker([instance.account_id], (tx) => this.repo.pendingInbox(tx, instance.id));
      for (const row of rows) {
        const outcome = await this.applyOne(instance, row);
        if (outcome === 'applied') applied += 1;
        else if (outcome === 'failed') failed += 1;
      }
    }
    return `applied ${applied}, failed ${failed}`;
  }

  /** One inbox row in its own transaction; the row settles inside it. */
  async applyOne(instance: InstanceRow, row: InboxRow): Promise<'applied' | 'dropped' | 'failed' | 'retry'> {
    const started = Date.now();
    const principal = syncPrincipal(instance);
    const ctx: RequestContext = { requestId: `inbox-${row.id}`, origin: `sync:${instance.id}` };
    try {
      return await this.uow.worker([instance.account_id], async (tx) => {
        const fresh = await this.repo.instance(tx, instance.id);
        if (fresh.mode === 'off' || fresh.kill_switch === 'tripped') return 'retry';
        const outcome = await this.applyRecord(tx, fresh, principal, ctx, row, started);
        return outcome;
      });
    } catch (error) {
      const terminal =
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException;
      const detail = describe(error);
      return this.uow.worker([instance.account_id], async (tx) => {
        const attempts = await this.repo.retryInbox(tx, row.id, detail);
        if (terminal || attempts >= MAX_INBOX_ATTEMPTS) {
          const letter = await this.repo.insertDeadLetter(tx, {
            queue: 'inbox',
            accountId: instance.account_id,
            correlationId: ctx.requestId,
            payload: {
              inbox_id: row.id,
              instance_id: instance.id,
              external_id: row.external_id,
              external_version: row.external_version,
            },
            error: detail,
            attempts,
          });
          await this.repo.settleInbox(tx, row.id, 'failed', detail);
          await this.repo.insertRun(tx, {
            accountId: instance.account_id,
            instanceId: instance.id,
            direction: 'in',
            inboxId: row.id,
            externalSysId: row.external_id,
            attempt: attempts,
            outcome: 'dead_lettered',
            errorClass: 'terminal',
            errorText: detail,
            durationMs: Date.now() - started,
            detail: { dead_letter_id: letter },
          });
          await this.repo.touchInstance(tx, instance.id, { last_error: detail, last_error_at: new Date() });
          this.logger.error(`inbox ${row.id} for ${instance.name} dead-lettered: ${detail}`);
          return 'failed';
        }
        await this.repo.insertRun(tx, {
          accountId: instance.account_id,
          instanceId: instance.id,
          direction: 'in',
          inboxId: row.id,
          externalSysId: row.external_id,
          attempt: attempts,
          outcome: 'retried',
          errorClass: 'retryable',
          errorText: detail,
          durationMs: Date.now() - started,
        });
        return 'retry';
      });
    }
  }

  private async applyRecord(
    tx: Tx,
    instance: InstanceRow,
    principal: Principal,
    ctx: RequestContext,
    row: InboxRow,
    started: number,
  ): Promise<'applied' | 'dropped'> {
    const record = (row.payload.record ?? {}) as SnowRecord;
    const journal = ((row.payload.journal ?? []) as JournalEntry[]).filter(
      (entry) => entry.element_id === record.sys_id,
    );
    const fieldMapRow = instance.active_field_map_id
      ? await this.repo.map<unknown>(tx, 'field', instance.active_field_map_id)
      : undefined;
    if (!fieldMapRow) throw new ConflictException({ code: 'no_active_field_map' });
    const fieldMap = coerceFieldMap(fieldMapRow.entries);
    const stateMap = instance.active_state_map_id
      ? ((await this.repo.map<StateMap>(tx, 'state', instance.active_state_map_id)).entries ?? {})
      : undefined;
    const translation = translateInbound(fieldMap, record);
    const patch = translation.patch;
    const sysUpdatedOn = fromSnowTime(record.sys_updated_on);
    const link = await this.repo.linkByExternal(tx, instance.id, record.sys_id);
    const externalNumber = String(record.number ?? record.sys_id);
    const detail: Record<string, unknown> = { fields: Object.keys(patch), journal: journal.length };

    // Reflection: our own outbound write coming back (no outbound in this cut; the rule still guards).
    if (link) {
      const sent = Object.fromEntries(
        fieldMap.entries.filter((entry) => entry.direction !== 'in').map((entry) => [entry.xms, patch[entry.xms]]),
      );
      if (
        isReflection({
          lastOutboundAt: link.last_outbound_at ? new Date(link.last_outbound_at) : null,
          lastOutboundHash: link.last_outbound_hash,
          sysUpdatedOn,
          inboundHash: outboundHash(sent),
          toleranceSeconds: instance.clock_tolerance_seconds,
        })
      ) {
        await this.repo.settleInbox(tx, row.id, 'dropped_reflection');
        await this.repo.insertRun(tx, {
          accountId: instance.account_id,
          instanceId: instance.id,
          direction: 'in',
          ticketId: link.ticket_id,
          externalSysId: record.sys_id,
          inboxId: row.id,
          outcome: 'skipped_reflection',
          durationMs: Date.now() - started,
        });
        return 'dropped';
      }
    }

    let ticket: TicketView;
    let currentLink: LinkRow;
    if (!link) {
      if (!patch.short_description || !patch.requester_email)
        throw new BadRequestException({
          code: 'mapping_incomplete',
          missing: ['short_description', 'requester_email'].filter((f) => !patch[f as XmsField]),
        });
      const type = stateMap && Object.keys(stateMap).length === 1 ? Object.keys(stateMap)[0] : 'incident';
      ticket = (await this.tickets.create(
        principal,
        ctx,
        {
          account_id: instance.account_id,
          type,
          short_description: String(patch.short_description).slice(0, 300),
          description: patch.description === undefined ? undefined : String(patch.description),
          category: patch.category === undefined ? undefined : String(patch.category),
          impact: patch.impact as CreateTicketDto['impact'],
          urgency: patch.urgency as CreateTicketDto['urgency'],
          requester_email: String(patch.requester_email),
          requester_name: patch.requester_name === undefined ? undefined : String(patch.requester_name),
          source: 'sync',
        } as unknown as CreateTicketDto,
        tx,
      )) as TicketView;
      ticket = (await this.tickets.patch(
        principal,
        ctx,
        ticket.id,
        {
          version: ticket.version,
          external_refs: {
            ...(ticket.external_refs as Record<string, string>),
            servicenow: externalNumber,
            servicenow_sys_id: record.sys_id,
            ...(patch.client_reference !== undefined ? { client_reference: String(patch.client_reference) } : {}),
          },
        } as PatchTicketDto,
        tx,
      )) as TicketView;
      currentLink = await this.repo.insertLink(tx, {
        accountId: instance.account_id,
        instanceId: instance.id,
        ticketId: ticket.id,
        sysId: record.sys_id,
        number: externalNumber,
        sysUpdatedOn,
      });
      detail.created = true;
    } else {
      ticket = (await this.tickets.get(principal, link.ticket_id, tx)) as TicketView;
      currentLink = link;
      const applied: Partial<PatchTicketDto> = {};
      const skipped: string[] = [];
      for (const entry of fieldMap.entries) {
        if (entry.direction === 'out' || !(entry.xms in patch)) continue;
        const policy = currentLink.field_sor_overrides?.[entry.xms] ?? entry.sor ?? defaultSor(entry.xms);
        const current = ticketValue(ticket, entry.xms);
        const decision = decideInbound({
          policy: policy as never,
          isCreate: false,
          xmsValue: current,
          externalValue: patch[entry.xms],
          xmsUpdatedAt: new Date(ticket.updated_at),
          externalUpdatedAt: sysUpdatedOn,
        });
        if (!decision.apply) {
          if (decision.reason === 'xms_owned') skipped.push(entry.xms);
          continue;
        }
        if (entry.xms === 'short_description' || entry.xms === 'description' || entry.xms === 'category')
          (applied as Record<string, unknown>)[entry.xms] = String(patch[entry.xms]).slice(
            0,
            entry.xms === 'short_description' ? 300 : 50000,
          );
        else if (entry.xms === 'impact' || entry.xms === 'urgency')
          (applied as Record<string, unknown>)[entry.xms] = patch[entry.xms];
      }
      if (skipped.length > 0) {
        await this.repo.touchLink(tx, currentLink.id, {
          state: 'conflict',
          last_conflict: { fields: skipped, at: new Date().toISOString(), sys_updated_on: record.sys_updated_on },
        });
        await this.repo.insertRun(tx, {
          accountId: instance.account_id,
          instanceId: instance.id,
          direction: 'in',
          ticketId: ticket.id,
          externalSysId: record.sys_id,
          inboxId: row.id,
          outcome: 'skipped_policy',
          detail: { fields: skipped },
        });
      }
      if (Object.keys(applied).length > 0 && !['closed', 'cancelled'].includes(ticket.state)) {
        ticket = (await this.tickets.patch(
          principal,
          ctx,
          ticket.id,
          { version: ticket.version, ...applied } as PatchTicketDto,
          tx,
        )) as TicketView;
        detail.patched = Object.keys(applied);
      }
    }

    // State through the state map, only into accepted, reachable states.
    if (stateMap && record.state !== undefined && record.state !== null) {
      const entry = stateMap[ticket.type];
      if (entry) {
        const allowed = (await this.tickets.allowedTransitions(principal, ticket.id, tx)).transitions;
        const resolved = resolveInboundState(
          entry,
          String(pickValue(record.state)),
          ticket.state,
          allowed.map((t) => t.to),
        );
        if (resolved.target) {
          const target = allowed.find((t) => t.to === resolved.target)!;
          const dto: Partial<TransitionDto> = { version: ticket.version, to: resolved.target };
          if (target.requires.includes('pause_reason'))
            dto.pause_reason = resolved.target === 'awaiting_third_party' ? 'awaiting_third_party' : 'awaiting_client';
          if (target.requires.some((r) => r === 'resolution' || r === 'time_logged')) {
            detail.state_skipped = { target: resolved.target, reason: 'requires_close_discipline' };
          } else {
            ticket = (await this.tickets.transition(principal, ctx, ticket.id, dto as TransitionDto, tx)) as TicketView;
            detail.state = { to: resolved.target, via: resolved.via };
          }
        } else if (resolved.reason && resolved.reason !== 'same') {
          detail.state_skipped = { external: pickValue(record.state), reason: resolved.reason };
        }
      }
    }

    // Journal entries: comments become public comments; work notes only when enabled; our own echoes never.
    let journalApplied = 0;
    for (const entry of journal) {
      const kind =
        entry.element === instance.journal_public
          ? 'comment'
          : entry.element === 'work_notes'
            ? 'work_note'
            : undefined;
      if (!kind) continue;
      if (kind === 'work_note' && !instance.sync_work_notes) continue;
      if (hasJournalMarker(entry.value)) continue;
      if (await this.repo.journalLinkExists(tx, instance.id, entry.sys_id)) continue;
      const body = `${entry.value}`.trim();
      if (!body) continue;
      const created = (
        kind === 'comment'
          ? await this.tickets.addComment(principal, ctx, ticket.id, { body }, tx)
          : await this.tickets.addWorkNote(principal, ctx, ticket.id, { body }, tx)
      ) as { id: string };
      await this.repo.insertJournalLink(tx, {
        accountId: instance.account_id,
        instanceId: instance.id,
        ticketId: ticket.id,
        kind,
        xmsId: created.id,
        externalSysId: entry.sys_id,
        direction: 'in',
      });
      journalApplied += 1;
    }
    detail.journal_applied = journalApplied;
    detail.attachments = await this.pullAttachments(tx, instance, principal, ctx, ticket, row);

    await this.repo.touchLink(tx, currentLink.id, {
      last_inbound_at: new Date(),
      last_inbound_sys_updated_on: sysUpdatedOn,
      external_number: externalNumber,
    });
    await this.repo.settleInbox(tx, row.id, 'applied');
    await this.repo.insertRun(tx, {
      accountId: instance.account_id,
      instanceId: instance.id,
      direction: 'in',
      ticketId: ticket.id,
      externalSysId: record.sys_id,
      inboxId: row.id,
      attempt: row.attempts + 1,
      outcome: 'success',
      durationMs: Date.now() - started,
      detail,
    });
    await this.audit.account(
      tx,
      instance.account_id,
      { kind: 'system', id: `sync:${instance.id}`, name: `${instance.name} (sync)` },
      ctx,
      [
        {
          entityKind: 'ticket',
          entityId: ticket.id,
          ticketId: ticket.id,
          eventType: 'sync.applied',
          newValue: { external: externalNumber, ...detail },
        },
      ],
    );
    return 'applied';
  }

  /**
   * Files on the client's case (ServiceNow Sync technical 3.4 step 6;
   * SN-06). One under the instance's limit is downloaded, stored and
   * scanned like any upload; one over it becomes a work note naming the
   * file, or nothing at all, as the instance is configured. Every outcome
   * is recorded on the attachment links, which is also what stops a file
   * arriving twice and what stops one we pushed coming back.
   */
  private async pullAttachments(
    tx: Tx,
    instance: InstanceRow,
    principal: Principal,
    ctx: RequestContext,
    ticket: TicketView,
    row: InboxRow,
  ): Promise<{ copied: number; linked: number; skipped: number }> {
    const listed = (row.payload.attachments ?? []) as SnowAttachment[];
    const outcome = { copied: 0, linked: 0, skipped: 0 };
    if (listed.length === 0) return outcome;
    let client: SnowClient | undefined;
    for (const file of listed) {
      if (!file?.sys_id) continue;
      if (await this.repo.attachmentLinkExists(tx, instance.id, file.sys_id)) continue;
      const size = Number(file.size_bytes ?? 0);
      if (size > instance.attachment_limit_bytes) {
        if (instance.attachment_over_limit === 'link') {
          await this.tickets.addWorkNote(
            principal,
            ctx,
            ticket.id,
            {
              body: `${file.file_name} (${size} bytes) is attached to ${ticket.external_refs.servicenow ?? 'the case'} in ServiceNow and is over the ${instance.attachment_limit_bytes} byte copy limit. Open it in the client instance.`,
            },
            tx,
          );
          outcome.linked += 1;
        } else {
          outcome.skipped += 1;
        }
        await this.repo.insertAttachmentLink(tx, {
          accountId: instance.account_id,
          instanceId: instance.id,
          ticketId: ticket.id,
          attachmentId: null,
          externalSysId: file.sys_id,
          direction: 'in',
          outcome: instance.attachment_over_limit === 'link' ? 'linked' : 'skipped',
        });
        continue;
      }
      client ??= await this.clients.forInstance(instance);
      const body = await client.downloadAttachment(file.sys_id, instance.attachment_limit_bytes);
      const stored = await this.attachments.ingest(
        tx,
        {
          accountId: instance.account_id,
          ticketId: ticket.id,
          fileName: file.file_name,
          contentType: file.content_type || 'application/octet-stream',
          body,
          uploadedBy: principal.userId,
          uploadedByName: principal.displayName,
          visibility: 'public',
        },
        ctx,
      );
      await this.repo.insertAttachmentLink(tx, {
        accountId: instance.account_id,
        instanceId: instance.id,
        ticketId: ticket.id,
        attachmentId: stored.id,
        externalSysId: file.sys_id,
        direction: 'in',
        outcome: 'copied',
      });
      outcome.copied += 1;
    }
    return outcome;
  }

  // Outbound queue -----------------------------------------------------------

  /** Whether an outbox event type can reach a connector at all (the dispatcher's filter). */
  handles(eventType: string): boolean {
    return isOutboundEvent(eventType);
  }

  /**
   * The dispatcher handler (ServiceNow Sync technical 3.5; SN-03). One XMS
   * change becomes one outbound row per instance of the account that
   * subscribes to the event, is in bidirectional mode and holds a link for
   * the ticket, unless the change came from that instance, which is the
   * loop guard. The two refusals an operator would ask about, our own echo
   * and a work note an instance is not configured to receive, are recorded
   * as skipped runs; the rest are silent because nothing was ever asked of
   * the instance.
   */
  async onOutbox(row: OutboxRow): Promise<void> {
    const event = row.event_type;
    if (!isOutboundEvent(event)) return;
    await this.uow.worker([row.account_id], async (tx) => {
      const instances = (await this.repo.allInstances(tx)).filter((one) => one.account_id === row.account_id);
      if (instances.length === 0) return;
      const subscriptions = await this.repo.outboundEvents(tx);
      for (const instance of instances) {
        const link = await this.repo.linkByTicket(tx, instance.id, row.aggregate_id);
        const decision = decideEnqueue({
          event,
          origin: row.origin,
          instanceId: instance.id,
          mode: instance.mode,
          subscribedEvents: subscriptions[instance.type] ?? [],
          hasLink: link !== undefined,
          syncWorkNotes: instance.sync_work_notes,
          attachmentVisibility: String(row.payload.visibility ?? ''),
        });
        if (!decision.enqueue) {
          if (
            decision.reason === 'own_origin' ||
            decision.reason === 'work_notes_off' ||
            decision.reason === 'internal_attachment'
          ) {
            await this.repo.insertRun(tx, {
              accountId: row.account_id,
              instanceId: instance.id,
              direction: 'out',
              ticketId: row.aggregate_id,
              outboxId: row.id,
              outcome: decision.reason === 'own_origin' ? 'skipped_reflection' : 'skipped_policy',
              detail: { event, reason: decision.reason },
            });
          }
          continue;
        }
        await this.repo.insertOutbound(tx, {
          accountId: row.account_id,
          instanceId: instance.id,
          ticketId: row.aggregate_id,
          linkId: link!.id,
          event,
          outboxId: row.id,
          payload: row.payload ?? {},
          origin: row.origin,
          correlationId: row.correlation_id,
        });
      }
    });
  }

  // Outbound delivery --------------------------------------------------------

  outboundJob(intervalMs = 5_000): Job {
    return { name: 'connectors.outbound', intervalMs, run: () => this.deliverPending() };
  }

  /**
   * One pass over the queued rows of every armed bidirectional instance
   * (ServiceNow Sync technical 3.5). Rows leave oldest first so a ticket's
   * changes reach the instance in the order they were made.
   */
  async deliverPending(now = new Date()): Promise<string> {
    const accounts = await this.liveAccounts();
    if (accounts.length === 0) return 'delivered 0';
    const instances = (await this.uow.perAccount(accounts, (tx) => this.repo.allInstances(tx))).flat();
    let sent = 0;
    let skipped = 0;
    let retried = 0;
    let failed = 0;
    for (const instance of instances) {
      if (instance.mode !== 'bidirectional' || instance.kill_switch === 'tripped') continue;
      const rows = await this.uow.worker([instance.account_id], (tx) => this.repo.claimOutbound(tx, instance.id, now));
      for (const row of rows) {
        const outcome = await this.deliverOne(instance, row, now);
        if (outcome === 'sent') sent += 1;
        else if (outcome === 'skipped') skipped += 1;
        else if (outcome === 'retry') retried += 1;
        else if (outcome === 'failed') failed += 1;
      }
    }
    return `delivered ${sent}, skipped ${skipped}, retried ${retried}, failed ${failed}`;
  }

  /** One outbound row in its own transaction; the row settles inside it. */
  async deliverOne(
    instance: InstanceRow,
    row: OutboundRow,
    now = new Date(),
  ): Promise<'sent' | 'skipped' | 'failed' | 'retry' | 'deferred'> {
    const started = Date.now();
    try {
      return await this.uow.worker([instance.account_id], async (tx) => {
        // The switch and the mode are read again here: a trip while the
        // batch was in flight leaves the row queued, untouched and in order.
        const fresh = await this.repo.instance(tx, instance.id);
        if (fresh.mode !== 'bidirectional' || fresh.kill_switch === 'tripped') return 'deferred';
        return this.push(tx, fresh, row, started);
      });
    } catch (error) {
      const detail = describe(error);
      const terminal =
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        (error instanceof SnowError && error.errorClass === 'terminal');
      const attempts = row.attempts + 1;
      const next = terminal ? null : outboundNextAttempt(attempts, now);
      return this.uow.worker([instance.account_id], async (tx) => {
        if (error instanceof SnowError && (error.status === 401 || error.status === 403))
          await this.repo.touchInstance(tx, instance.id, { credential_state: 'invalid' });
        if (!next) {
          const letter = await this.repo.insertDeadLetter(tx, {
            queue: 'outbound',
            accountId: instance.account_id,
            correlationId: row.correlation_id,
            payload: {
              outbound_id: row.id,
              instance_id: instance.id,
              ticket_id: row.ticket_id,
              event: row.event,
              outbox_id: row.outbox_id,
            },
            error: detail,
            attempts,
          });
          await this.repo.settleOutbound(tx, row.id, {
            status: 'dead_lettered',
            attempts,
            last_error: detail,
          });
          await this.repo.insertRun(tx, {
            accountId: instance.account_id,
            instanceId: instance.id,
            direction: 'out',
            ticketId: row.ticket_id,
            outboxId: row.outbox_id,
            attempt: attempts,
            outcome: 'dead_lettered',
            errorClass: 'terminal',
            errorText: detail,
            durationMs: Date.now() - started,
            detail: { event: row.event, dead_letter_id: letter },
          });
          await this.repo.touchInstance(tx, instance.id, { last_error: detail, last_error_at: new Date() });
          this.logger.error(`outbound ${row.id} for ${instance.name} dead-lettered: ${detail}`);
          return 'failed';
        }
        await this.repo.settleOutbound(tx, row.id, {
          status: 'pending',
          attempts,
          next_attempt_at: next,
          last_error: detail,
        });
        await this.repo.insertRun(tx, {
          accountId: instance.account_id,
          instanceId: instance.id,
          direction: 'out',
          ticketId: row.ticket_id,
          outboxId: row.outbox_id,
          attempt: attempts,
          outcome: 'retried',
          errorClass: 'retryable',
          errorText: detail,
          durationMs: Date.now() - started,
          detail: { event: row.event },
        });
        return 'retry';
      });
    }
  }

  private async push(tx: Tx, instance: InstanceRow, row: OutboundRow, started: number): Promise<'sent' | 'skipped'> {
    const principal = syncPrincipal(instance);
    const ctx: RequestContext = { requestId: `outbound-${row.id}`, origin: syncOrigin(instance.id) };
    const link = await this.repo.linkByTicket(tx, instance.id, row.ticket_id);
    if (!link || link.state === 'unlinked')
      return this.settleSkip(tx, instance, row, started, 'noop', { reason: 'no_link' });
    const fieldMapRow = instance.active_field_map_id
      ? await this.repo.map<unknown>(tx, 'field', instance.active_field_map_id)
      : undefined;
    if (!fieldMapRow) throw new ConflictException({ code: 'no_active_field_map' });
    const fieldMap = coerceFieldMap(fieldMapRow.entries);
    const stateMap = instance.active_state_map_id
      ? ((await this.repo.map<StateMap>(tx, 'state', instance.active_state_map_id)).entries ?? {})
      : undefined;
    const ticket = (await this.tickets.get(principal, row.ticket_id, tx)) as TicketView;
    const client = await this.clients.forInstance(instance);
    const record = await client.get(instance.table_name, link.external_sys_id);
    if (!record) {
      // The client deleted the case: XMS keeps the ticket and stops
      // pushing at it (functional 5.7).
      await this.repo.touchLink(tx, link.id, { state: 'unlinked' });
      return this.settleSkip(tx, instance, row, started, 'noop', { reason: 'external_record_gone' });
    }
    const sysUpdatedOn = fromSnowTime(record.sys_updated_on);
    const externalChanged = externalChangedSince(
      link.last_inbound_sys_updated_on ? new Date(link.last_inbound_sys_updated_on) : null,
      sysUpdatedOn,
      instance.clock_tolerance_seconds,
    );
    const detail: Record<string, unknown> = { event: row.event, external_number: link.external_number };

    // Journals: the policy on both journals is merge, so a comment always
    // travels; the marker and the journal link are what stop it echoing.
    if (row.event === 'comment.created' || row.event === 'work_note.created') {
      const kind = row.event === 'comment.created' ? 'comment' : 'work_note';
      const messageId = String(row.payload.comment_id ?? row.payload.work_note_id ?? '');
      if (!messageId) throw new BadRequestException({ code: 'message_missing', event: row.event });
      if (await this.repo.journalLinkExistsForXms(tx, instance.id, kind, messageId))
        return this.settleSkip(tx, instance, row, started, 'noop', { ...detail, reason: 'already_sent' });
      const message = await this.repo.message(tx, kind, messageId);
      if (!message) throw new NotFoundException({ code: 'not_found', entity: kind });
      if (message.source === 'sync')
        return this.settleSkip(tx, instance, row, started, 'skipped_reflection', {
          ...detail,
          reason: 'arrived_from_sync',
        });
      const element = kind === 'comment' ? journalElement(instance.journal_public) : 'work_notes';
      const text = `${journalMarker(message.id)} ${ticket.key} ${message.author_name}: ${message.body}`;
      const written = await client.createJournal(instance.table_name, link.external_sys_id, element, text);
      await this.repo.insertJournalLink(tx, {
        accountId: instance.account_id,
        instanceId: instance.id,
        ticketId: row.ticket_id,
        kind,
        xmsId: message.id,
        externalSysId: written.entry.sys_id,
        direction: 'out',
      });
      detail.journal = { element, entry: written.entry.sys_id, kind };
      await this.echoGuard(tx, link.id, fieldMap, written.record);
      return this.settleSent(tx, instance, row, ticket, started, detail, ctx, null);
    }

    // Files: only a scanned, public attachment crosses, and only once
    // (SN-06; Security & Tenancy on visibility).
    if (row.event === 'attachment.scanned') {
      const attachmentId = String(row.payload.attachment_id ?? '');
      const attachment = attachmentId ? await this.repo.attachment(tx, attachmentId) : undefined;
      if (!attachment) throw new NotFoundException({ code: 'not_found', entity: 'attachment' });
      if (attachment.scan_state !== 'clean' || attachment.visibility !== 'public')
        return this.settleSkip(tx, instance, row, started, 'skipped_policy', {
          ...detail,
          reason: attachment.scan_state !== 'clean' ? 'not_scanned_clean' : 'internal_attachment',
        });
      if (await this.repo.attachmentLinkExistsForXms(tx, instance.id, attachment.id))
        return this.settleSkip(tx, instance, row, started, 'noop', { ...detail, reason: 'already_sent' });
      const size = Number(attachment.size_bytes);
      if (size > instance.attachment_limit_bytes) {
        if (instance.attachment_over_limit === 'link') {
          await client.createJournal(
            instance.table_name,
            link.external_sys_id,
            journalElement(instance.journal_public),
            `${journalMarker(attachment.id)} ${ticket.key}: ${attachment.file_name} (${size} bytes) is over the ${instance.attachment_limit_bytes} byte copy limit and stays in XMS.`,
          );
        }
        await this.repo.insertAttachmentLink(tx, {
          accountId: instance.account_id,
          instanceId: instance.id,
          ticketId: row.ticket_id,
          attachmentId: attachment.id,
          externalSysId: `over-limit:${attachment.id}`,
          direction: 'out',
          outcome: instance.attachment_over_limit === 'link' ? 'linked' : 'skipped',
        });
        return this.settleSkip(tx, instance, row, started, 'skipped_policy', {
          ...detail,
          reason: 'over_limit',
          file: attachment.file_name,
          size,
        });
      }
      const uploaded = await client.uploadAttachment(
        instance.table_name,
        link.external_sys_id,
        attachment.file_name,
        attachment.content_type,
        await this.store.getObject(attachment.s3_key),
      );
      await this.repo.insertAttachmentLink(tx, {
        accountId: instance.account_id,
        instanceId: instance.id,
        ticketId: row.ticket_id,
        attachmentId: attachment.id,
        externalSysId: uploaded.sys_id,
        direction: 'out',
        outcome: 'copied',
      });
      detail.attachment = { file: attachment.file_name, size, external: uploaded.sys_id };
      return this.settleSent(tx, instance, row, ticket, started, detail, ctx, null);
    }

    // Fields and state.
    const body: Record<string, string> = {};
    let sent: Partial<Record<XmsField, unknown>> = {};
    let conflict: Record<string, unknown> | null = null;
    if (row.event === 'ticket.transitioned') {
      const entry = stateMap?.[ticket.type];
      const resolved = entry ? resolveOutboundState(entry, ticket.state) : { reason: 'no_outbound' as const };
      if (!resolved.value)
        return this.settleSkip(tx, instance, row, started, 'skipped_policy', {
          ...detail,
          state: ticket.state,
          reason: 'no_outbound',
        });
      body.state = resolved.value;
      // XMS runs the state machine (technical 2.8), so the state is never
      // dropped by policy; where the client's model cannot tell two XMS
      // states apart the run says so.
      detail.state = { from: row.payload.from ?? null, to: ticket.state, external: resolved.value };
      if (resolved.shared) detail.state_shared = { with: resolved.shared, canonical: resolved.canonical ?? null };
    } else {
      const values = outboundValues(ticket);
      const changed = (row.payload.fields as unknown[] | undefined)?.filter(
        (field): field is string => typeof field === 'string',
      );
      const only = changed && changed.length > 0 ? changed : undefined;
      const external = translateInbound(fieldMap, record).patch;
      const allowed: string[] = [];
      const dropped: { field: string; policy: string; reason: string }[] = [];
      for (const entry of fieldMap.entries) {
        if (entry.direction === 'in') continue;
        if (only && !only.includes(entry.xms)) continue;
        if (values[entry.xms] === undefined) continue;
        const policy = (link.field_sor_overrides?.[entry.xms] ?? entry.sor ?? defaultSor(entry.xms)) as never;
        const decision = decideOutbound({
          policy,
          externalChanged,
          xmsValue: values[entry.xms],
          externalValue: external[entry.xms],
          xmsUpdatedAt: new Date(ticket.updated_at),
          externalUpdatedAt: sysUpdatedOn,
        });
        if (decision.send) allowed.push(entry.xms);
        else if (decision.reason !== 'same') dropped.push({ field: entry.xms, policy, reason: decision.reason });
      }
      const translation = translateOutbound(fieldMap, values, allowed);
      Object.assign(body, translation.body);
      sent = translation.sent;
      if (translation.unmapped.length > 0) detail.unmapped = translation.unmapped;
      // A contested change records its outcome whichever side won: the
      // operator's question is "both sides moved, what happened", and the
      // answer is the kept and dropped lists with the policy that decided.
      if (externalChanged || dropped.length > 0) {
        conflict = {
          external_sys_updated_on: record.sys_updated_on,
          external_changed: externalChanged,
          kept: allowed,
          dropped,
        };
        detail.conflict = conflict;
      }
      if (dropped.length > 0) {
        await this.repo.touchLink(tx, link.id, {
          state: 'conflict',
          last_conflict: {
            direction: 'out',
            fields: dropped.map((one) => one.field),
            at: new Date().toISOString(),
            sys_updated_on: record.sys_updated_on,
          },
        });
      }
      detail.fields = Object.keys(body);
      if (Object.keys(body).length === 0)
        return this.settleSkip(tx, instance, row, started, dropped.length > 0 ? 'skipped_policy' : 'noop', {
          ...detail,
          reason: dropped.length > 0 ? 'policy' : 'nothing_to_send',
        });
    }

    const updated = await client.update(instance.table_name, link.external_sys_id, body);
    detail.sent = Object.keys(sent);
    await this.echoGuard(tx, link.id, fieldMap, updated);
    return this.settleSent(tx, instance, row, ticket, started, detail, ctx, conflict);
  }

  /**
   * The echo guard (ServiceNow Sync technical 2.7): the link records what
   * the record reads as after our write, in XMS terms and over the same
   * field set the reflection rule hashes on the way in, together with the
   * `sys_updated_on` the instance stamped. The next poll then recognises
   * our own write instead of applying it back.
   */
  private async echoGuard(tx: Tx, linkId: string, fieldMap: FieldMap, record: SnowRecord): Promise<void> {
    const after = translateInbound(fieldMap, record).patch;
    const echo = Object.fromEntries(
      fieldMap.entries.filter((entry) => entry.direction !== 'in').map((entry) => [entry.xms, after[entry.xms]]),
    );
    await this.repo.touchLink(tx, linkId, {
      last_outbound_at: new Date(),
      last_outbound_hash: outboundHash(echo),
      last_inbound_sys_updated_on: fromSnowTime(record.sys_updated_on),
    });
  }

  private async settleSent(
    tx: Tx,
    instance: InstanceRow,
    row: OutboundRow,
    ticket: TicketView,
    started: number,
    detail: Record<string, unknown>,
    ctx: RequestContext,
    conflict: Record<string, unknown> | null,
  ): Promise<'sent'> {
    await this.repo.settleOutbound(tx, row.id, {
      status: 'sent',
      attempts: row.attempts + 1,
      sent_at: new Date(),
      last_error: null,
      conflict,
    });
    await this.repo.insertRun(tx, {
      accountId: instance.account_id,
      instanceId: instance.id,
      direction: 'out',
      ticketId: row.ticket_id,
      outboxId: row.outbox_id,
      attempt: row.attempts + 1,
      outcome: 'success',
      durationMs: Date.now() - started,
      detail,
    });
    await this.repo.touchInstance(tx, instance.id, { last_success_at: new Date(), last_error: null });
    await this.audit.account(
      tx,
      instance.account_id,
      { kind: 'system', id: syncOrigin(instance.id), name: `${instance.name} (sync)` },
      ctx,
      [
        {
          entityKind: 'ticket',
          entityId: ticket.id,
          ticketId: ticket.id,
          eventType: conflict ? 'sync.conflict' : 'sync.pushed',
          newValue: detail,
        },
      ],
    );
    return 'sent';
  }

  /** A row that reached no call: settled, with the reason on the run so the operator sees it. */
  private async settleSkip(
    tx: Tx,
    instance: InstanceRow,
    row: OutboundRow,
    started: number,
    outcome: 'noop' | 'skipped_policy' | 'skipped_reflection',
    detail: Record<string, unknown>,
  ): Promise<'skipped'> {
    await this.repo.settleOutbound(tx, row.id, {
      status: 'skipped',
      attempts: row.attempts + 1,
      conflict: (detail.conflict as Record<string, unknown> | undefined) ?? null,
    });
    await this.repo.insertRun(tx, {
      accountId: instance.account_id,
      instanceId: instance.id,
      direction: 'out',
      ticketId: row.ticket_id,
      outboxId: row.outbox_id,
      attempt: row.attempts + 1,
      outcome,
      durationMs: Date.now() - started,
      detail,
    });
    return 'skipped';
  }

  // Health -------------------------------------------------------------------

  async recomputeHealth(): Promise<string> {
    const accounts = await this.liveAccounts();
    if (accounts.length === 0) return 'health 0';
    let tripped = 0;
    await this.uow.perAccount(accounts, async (tx) => {
      for (const instance of await this.repo.allInstances(tx)) {
        if (instance.kill_switch === 'tripped') {
          if (instance.health !== 'tripped') await this.repo.touchInstance(tx, instance.id, { health: 'tripped' });
          continue;
        }
        const threshold = instance.error_trip_threshold;
        const stats = await this.repo.windowStats(tx, instance.id, threshold.window_minutes);
        const ratio = stats.attempts > 0 ? stats.failures / stats.attempts : 0;
        let health: InstanceRow['health'] = 'healthy';
        if (stats.attempts >= threshold.min_attempts && ratio >= threshold.ratio) {
          await this.trip(tx, instance, `error ratio ${ratio.toFixed(2)} over ${threshold.window_minutes} minutes`);
          tripped += 1;
          continue;
        }
        if (stats.attempts >= threshold.min_attempts && ratio >= threshold.ratio / 2) health = 'failing';
        else {
          const dead = await this.repo.openDeadLetterCount(tx, instance.id);
          const pending = await this.repo.pendingInboxCount(tx, instance.id);
          const lagMs = Date.now() - new Date(instance.last_success_at ?? instance.created_at).getTime();
          const stale = instance.mode !== 'off' && lagMs > instance.poll_interval_seconds * 3 * 1000;
          if (dead > 0 || (pending > 0 && stale) || (stale && instance.last_error)) health = 'degraded';
        }
        if (health !== instance.health) await this.repo.touchInstance(tx, instance.id, { health });
      }
    });
    return `health recomputed, tripped ${tripped}`;
  }

  private async trip(tx: Tx, instance: InstanceRow, reason: string): Promise<void> {
    await this.repo.updateInstance(tx, instance.id, instance.version, {
      kill_switch: 'tripped',
      trip_reason: reason,
      tripped_at: new Date(),
      tripped_by: 'health',
      health: 'tripped',
    });
    await this.audit.account(tx, instance.account_id, SYSTEM_ACTOR, { requestId: 'health' }, [
      {
        entityKind: 'connector_instance',
        entityId: instance.id,
        eventType: 'connector.kill_switch',
        field: 'kill_switch',
        oldValue: 'armed',
        newValue: { state: 'tripped', reason, by: 'health' },
      },
    ]);
    await this.security.write(
      {
        type: 'admin.connector.kill_switch',
        outcome: 'success',
        accountId: instance.account_id,
        actorKind: 'system',
        actorId: 'health',
        entityKind: 'connector_instance',
        entityId: instance.id,
        attrs: { action: 'trip', reason, name: instance.name, automatic: true },
      },
      tx,
    );
    this.logger.error(`connector ${instance.name} tripped: ${reason}`);
  }

  private async liveAccounts(): Promise<string[]> {
    return (
      await this.pools.get('worker').query<{ id: string }>(`select id from op.accounts where status <> 'system'`)
    ).rows.map((row) => row.id);
  }
}

/** The identity an instance acts as inside XMS: bound to its account, ticket permissions only, never a person. */
export function syncPrincipal(instance: Pick<InstanceRow, 'id' | 'name' | 'account_id'>): Principal {
  return {
    kind: 'internal',
    userId: `sync:${instance.id}`,
    email: `sync+${instance.id}@xms.local`,
    displayName: `${instance.name} (sync)`,
    accountIds: [instance.account_id],
    permissions: new Set(['tickets:view', 'tickets:create', 'tickets:work', 'tickets:resolve'] as const),
    tokenType: 'harness',
  };
}

function ticketValue(ticket: TicketView, field: XmsField): unknown {
  switch (field) {
    case 'requester_email':
      return ticket.requester?.email ?? null;
    case 'requester_name':
      return ticket.requester?.display_name ?? null;
    case 'client_reference':
      return (ticket.external_refs as Record<string, unknown>).client_reference ?? null;
    case 'client_notes':
      return (ticket.external_refs as Record<string, unknown>).client_notes ?? null;
    case 'external_ref':
      return (ticket.external_refs as Record<string, unknown>).servicenow ?? null;
    default:
      return (ticket as unknown as Record<string, unknown>)[field] ?? null;
  }
}

/** The ticket in XMS field terms, for the outbound translation. */
function outboundValues(ticket: TicketView): Partial<Record<XmsField, unknown>> {
  const values: Partial<Record<XmsField, unknown>> = {};
  for (const field of Object.keys(XMS_FIELDS) as XmsField[]) {
    const value = ticketValue(ticket, field);
    if (value !== null && value !== undefined) values[field] = value;
  }
  return values;
}

/** The instance's public journal, defaulting to `comments` for anything else the column holds. */
function journalElement(configured: string): 'comments' | 'work_notes' {
  return configured === 'work_notes' ? 'work_notes' : 'comments';
}

function pickValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in (value as object)) return (value as { value: unknown }).value;
  return value;
}

function describe(error: unknown): string {
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException
  ) {
    const response = error.getResponse();
    return typeof response === 'string' ? response : JSON.stringify(response).slice(0, 500);
  }
  return (error as Error).message.slice(0, 500);
}
