import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService, type AuditActor } from '../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import {
  decisionPermissionFor,
  parseProposal,
  type AiCapability,
  type AiTargetKind,
  type WithheldReason,
} from '../../contracts/ai.js';
import { redact, type Person, type RedactionProfile } from '../../domain/ai/redaction.js';
import { extractProposal, SseParser, stripProposal, type HarnessFrame } from '../../domain/ai/sse.js';
import type { Tx } from '../../db/repository.base.js';
import { DbPools } from '../../db/pool.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { loadEnv } from '../../config/env.js';
import type { Job } from '../../worker/jobs.js';
import { TicketsService, type TicketView } from '../tickets/tickets.service.js';
import type { MessageRow } from '../tickets/tickets.repository.js';
import type { PatchTicketDto } from '../tickets/tickets.dto.js';
import { AiRepository, type DecisionRow, type SuggestionRow } from './ai.repository.js';
import { AiSettingsService, type EffectiveSwitch } from './ai-settings.service.js';
import { CAPABILITY_BUILDERS, isBuilt, type CapabilityContext, type TicketFacts } from './capabilities.js';
import { HARNESS_CLIENT, HarnessUnavailableError, type HarnessClient } from './harness-client.js';
import { SessionTokenService } from './session-token.service.js';

export const AXEL_ACTOR: AuditActor = { kind: 'ai', id: 'axel', name: 'Axel' };

export interface SuggestionView {
  readonly id: string;
  readonly capability: AiCapability;
  readonly target_kind: AiTargetKind;
  readonly target_id: string;
  readonly status: 'offered' | 'withheld';
  readonly withheld_reason: WithheldReason | null;
  readonly payload: Record<string, unknown>;
  readonly confidence: number | null;
  readonly agent_id: string;
  readonly prompt_version: string;
  readonly model_id: string;
  readonly thread_id: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly decision?: DecisionRow | null;
  /** The agent's explanation without the proposal block; not stored. */
  readonly explanation?: string;
}

export interface TurnOutcome {
  readonly content: string;
  readonly streamId?: string;
  readonly modelId?: string;
  readonly build?: string;
  readonly threadId?: string;
  readonly error?: { error: string; code?: string };
  readonly cancelled: boolean;
  readonly latencyMs: number;
}

interface ProposalMeta {
  readonly agentId: string;
  readonly promptVersion: string;
  readonly modelId?: string;
  readonly build?: string;
  readonly threadId?: string | null;
  readonly latencyMs?: number;
}

/**
 * The single-shot face of the adapter and the suggestion life cycle (AI
 * functionality technical 2.6, 2.7, 3). Pre-flight in this order: account
 * switch, capability, caller permission, redaction; only then the harness.
 * Every withheld outcome is a row and a security event before the caller
 * hears about it. The harness call runs outside any transaction; the facts
 * are read in one unit of work and the result stored in another.
 */
@Injectable()
export class SuggestionService {
  private readonly logger = new Logger(SuggestionService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly pools: DbPools,
    private readonly repo: AiRepository,
    private readonly settings: AiSettingsService,
    private readonly tickets: TicketsService,
    private readonly session: SessionTokenService,
    @Inject(HARNESS_CLIENT) private readonly harness: HarnessClient,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
  ) {}

  // Single-shot -----------------------------------------------------------

  async suggest(
    principal: Principal,
    ctx: RequestContext,
    input: { capability: AiCapability; target_kind: 'ticket'; target_id: string; instruction?: string },
    bound?: Tx,
  ): Promise<SuggestionView> {
    if (!isBuilt(input.capability)) throw new BadRequestException({ code: 'capability_unbuilt' });
    const prepared = await this.inTx(principal, bound, (tx) => this.prepare(tx, principal, ctx, input));
    if ('withheld' in prepared) return prepared.withheld;
    const started = Date.now();
    let outcome: TurnOutcome;
    try {
      const token = await this.session.tokenFor(principal);
      const stream = await this.harness.stream(
        prepared.agentId,
        { session_id: `xms-${randomUUID()}`, message: prepared.message },
        token,
      );
      outcome = await consume(stream.chunks, started);
    } catch (error) {
      return this.harnessFailure(principal, ctx, prepared, error as Error, bound);
    }
    return this.inTx(principal, bound, (tx) =>
      this.record(tx, principal, ctx, {
        accountId: prepared.accountId,
        capability: input.capability,
        targetKind: 'ticket',
        targetId: prepared.ticketId,
        outcome,
        meta: { agentId: prepared.agentId, promptVersion: prepared.promptVersion, latencyMs: outcome.latencyMs },
        effective: prepared.effective,
      }),
    );
  }

  /** Worker intake (AI functionality technical section 3): classify, prioritise and duplicate as single-shot calls. */
  async intake(accountId: string, ticketId: string): Promise<string> {
    const principal = servicePrincipal(accountId);
    const ctx: RequestContext = { requestId: `intake-${ticketId}` };
    return this.uow.worker([accountId], async (tx) => {
      const effective = await this.settings.effective(tx, accountId);
      if (!effective.on) return `skipped:${effective.reason}`;
      const open = await this.repo.openFor(tx, 'ticket', ticketId);
      const results: string[] = [];
      for (const capability of ['classify', 'prioritise', 'duplicate'] as const) {
        if (!effective.capabilities[capability].enabled) continue;
        if (open.some((row) => row.capability === capability)) {
          results.push(`${capability}:exists`);
          continue;
        }
        try {
          const view = await this.suggest(
            principal,
            ctx,
            { capability, target_kind: 'ticket', target_id: ticketId },
            tx,
          );
          results.push(`${capability}:${view.status}${view.withheld_reason ? `:${view.withheld_reason}` : ''}`);
        } catch (error) {
          this.logger.warn(`intake ${capability} on ${ticketId}: ${(error as Error).message}`);
          results.push(`${capability}:error`);
        }
      }
      return results.join(',') || 'nothing';
    });
  }

  /**
   * A proposal arriving through a `propose_*` MCP tool call (AI Integration
   * section 4): the harness already ran the agent; XMS validates the payload
   * against the capability schema and applies the same switch policy and
   * threshold as its own calls. The caller is the invoking user, carried by
   * the harness session token, so RLS and permissions are that person's.
   */
  async propose(
    principal: Principal,
    ctx: RequestContext,
    input: {
      capability: AiCapability;
      target_kind: 'ticket';
      target_id: string;
      payload: Record<string, unknown>;
      agent_id?: string;
      thread_id?: string;
    },
  ): Promise<SuggestionView> {
    if (!isBuilt(input.capability)) throw new BadRequestException({ code: 'capability_unbuilt' });
    return this.uow.run(principal, async (tx) => {
      const ticket = (await this.tickets.get(principal, input.target_id, tx)) as TicketView;
      const effective = await this.settings.effective(tx, ticket.account_id);
      const meta = {
        agentId: input.agent_id ?? effective.defaults.agents[input.capability],
        promptVersion: `mcp/${input.capability}`,
        threadId: input.thread_id ?? null,
      };
      const base = {
        accountId: ticket.account_id,
        capability: input.capability,
        targetKind: 'ticket' as const,
        targetId: ticket.id,
        meta,
        principal,
        ctx,
        payload: {},
      };
      if (!effective.on) {
        const reason: WithheldReason =
          effective.reason === 'residency'
            ? 'residency'
            : effective.reason === 'kill_switch'
              ? 'capability_off'
              : 'switch_off';
        return this.withhold(tx, { ...base, reason });
      }
      if (!effective.capabilities[input.capability].enabled)
        return this.withhold(tx, { ...base, reason: 'capability_off' });
      return this.record(tx, principal, ctx, {
        accountId: ticket.account_id,
        capability: input.capability,
        targetKind: 'ticket',
        targetId: ticket.id,
        outcome: { content: '', cancelled: false, latencyMs: 0, threadId: input.thread_id },
        proposal: input.payload,
        meta,
        effective,
      });
    });
  }

  // Reads -------------------------------------------------------------------

  open(principal: Principal, targetKind: AiTargetKind, targetId: string): Promise<SuggestionView[]> {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.repo.openFor(tx, targetKind, targetId);
      return rows.map((row) => toView(row));
    });
  }

  history(principal: Principal, targetKind: AiTargetKind, targetId: string): Promise<SuggestionView[]> {
    return this.uow.run(principal, async (tx) => {
      const rows = await this.repo.historyFor(tx, targetKind, targetId);
      return rows.map((row) => toView(row, row.decision));
    });
  }

  // Decisions ---------------------------------------------------------------

  async decide(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    input: {
      decision: 'accepted' | 'edited_accepted' | 'rejected';
      applied_payload?: Record<string, unknown>;
      reject_reason?: string;
    },
  ): Promise<{ suggestion: SuggestionView; decision: DecisionRow }> {
    return this.uow.run(principal, async (tx) => {
      const suggestion = await this.repo.suggestion(tx, id);
      if (suggestion.status_initial !== 'offered') throw new ConflictException({ code: 'not_offered' });
      const decisions = await this.repo.decisionsOf(tx, id);
      if (decisions.some((row) => row.decision !== 'expired')) throw new ConflictException({ code: 'already_decided' });
      if (decisions.length > 0 || (suggestion.expires_at && new Date(suggestion.expires_at) <= new Date()))
        throw new ConflictException({ code: 'expired' });
      const permission = decisionPermissionFor(suggestion.capability);
      if (!principal.permissions.has(permission)) {
        await this.security.write({
          type: 'authz.permission.denied',
          outcome: 'denied',
          accountId: suggestion.account_id,
          actorKind: 'user',
          actorId: principal.userId,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: 'ai_suggestion',
          entityId: id,
          attrs: { permission, capability: suggestion.capability },
        });
        throw new ForbiddenException({ code: 'forbidden', permission });
      }
      const ticketId = suggestion.target_kind === 'ticket' ? suggestion.target_id : undefined;
      if (input.decision === 'rejected') {
        const decision = await this.repo.insertDecision(tx, {
          accountId: suggestion.account_id,
          suggestionId: id,
          decision: 'rejected',
          byKind: 'user',
          byId: principal.userId,
          rejectReason: input.reject_reason ?? null,
        });
        await this.audit.account(tx, suggestion.account_id, actorOf(principal), ctx, [
          {
            entityKind: 'ai_suggestion',
            entityId: id,
            ticketId,
            eventType: 'ai.suggestion.rejected',
            aiSuggestionId: id,
            newValue: { capability: suggestion.capability, reason: input.reject_reason ?? null },
          },
        ]);
        return { suggestion: toView(suggestion, decision), decision };
      }
      if (input.decision === 'edited_accepted' && !input.applied_payload)
        throw new BadRequestException({ code: 'applied_payload_required' });
      const applied = input.applied_payload ?? suggestion.payload;
      const parsed = parseProposal(suggestion.capability, applied);
      if (!parsed.ok) throw new BadRequestException({ code: 'invalid_payload', problems: parsed.problems });
      await this.apply(tx, principal, ctx, suggestion, parsed.value.payload);
      const editDistance =
        input.decision === 'edited_accepted' &&
        typeof suggestion.payload.text === 'string' &&
        typeof applied.text === 'string'
          ? levenshtein(String(suggestion.payload.text).slice(0, 5000), String(applied.text).slice(0, 5000))
          : null;
      const decision = await this.repo.insertDecision(tx, {
        accountId: suggestion.account_id,
        suggestionId: id,
        decision: input.decision,
        byKind: 'user',
        byId: principal.userId,
        appliedPayload: parsed.value.payload,
        editDistance,
      });
      await this.audit.account(tx, suggestion.account_id, AXEL_ACTOR, ctx, [
        {
          entityKind: 'ai_suggestion',
          entityId: id,
          ticketId,
          eventType: 'ai.suggestion.applied',
          aiSuggestionId: id,
          newValue: {
            capability: suggestion.capability,
            decision: input.decision,
            applied_payload: parsed.value.payload,
            confirmed_by: principal.userId,
            confirmed_by_name: principal.displayName,
          },
        },
      ]);
      return { suggestion: toView(suggestion, decision), decision };
    });
  }

  feedback(principal: Principal, id: string, input: { rating: number; comment?: string }): Promise<{ id: string }> {
    return this.uow.run(principal, async (tx) => {
      const suggestion = await this.repo.suggestion(tx, id);
      return this.repo.insertFeedback(tx, {
        accountId: suggestion.account_id,
        suggestionId: id,
        rating: input.rating,
        comment: input.comment ?? null,
        authorId: principal.userId,
      });
    });
  }

  // Expiry ------------------------------------------------------------------

  expiryJob(intervalMs = 5 * 60_000): Job {
    return { name: 'ai.suggestion_expiry', intervalMs, run: () => this.expire() };
  }

  async expire(now = new Date()): Promise<string> {
    const accounts = (
      await this.pools.get('worker').query<{ id: string }>(`select id from op.accounts where status <> 'system'`)
    ).rows.map((row) => row.id);
    if (accounts.length === 0) return 'expired 0';
    return this.uow.worker(accounts, async (tx) => {
      const candidates = await this.repo.expiredCandidates(tx, now);
      for (const candidate of candidates) {
        await this.repo.insertDecision(tx, {
          accountId: candidate.account_id,
          suggestionId: candidate.id,
          decision: 'expired',
          byKind: 'system',
          byId: 'expiry',
        });
        await this.audit.account(tx, candidate.account_id, { kind: 'system', id: 'expiry', name: 'XMS' }, {}, [
          {
            entityKind: 'ai_suggestion',
            entityId: candidate.id,
            eventType: 'ai.suggestion.expired',
            aiSuggestionId: candidate.id,
          },
        ]);
      }
      return `expired ${candidates.length}`;
    });
  }

  // Accuracy ----------------------------------------------------------------

  accuracy(
    principal: Principal,
    query: { account?: string; capability?: AiCapability; from?: string; to?: string; threshold?: number },
  ): Promise<Record<string, unknown>> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
      throw new BadRequestException({ code: 'bad_range' });
    return this.uow.run(principal, async (tx) => {
      const accountIds = query.account ? [query.account] : [...principal.accountIds];
      const rows = await this.repo.accuracy(tx, accountIds, query.capability, from, to, query.threshold);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        threshold: query.threshold ?? null,
        capabilities: rows.map((row) => {
          const accepted = Number(row.accepted) + Number(row.edited_accepted);
          const decided = accepted + Number(row.rejected);
          const whatIfDecided = Number(row.what_if_decided);
          return {
            ...row,
            acceptance_rate: decided > 0 ? Number((accepted / decided).toFixed(3)) : null,
            what_if:
              query.threshold === undefined
                ? null
                : {
                    withheld: Number(row.what_if_withheld),
                    acceptance_rate:
                      whatIfDecided > 0 ? Number((Number(row.what_if_accepted) / whatIfDecided).toFixed(3)) : null,
                  },
          };
        }),
      };
    });
  }

  // Shared with the interactive face -------------------------------------

  /** Stores a proposal that arrived as the answer of a turn, or a withheld row explaining why not. */
  async record(
    tx: Tx,
    principal: Principal,
    ctx: RequestContext,
    input: {
      accountId: string;
      capability: AiCapability;
      targetKind: AiTargetKind;
      targetId: string;
      outcome: TurnOutcome;
      meta: ProposalMeta;
      effective: EffectiveSwitch;
      /** An already-extracted proposal (interactive face); otherwise extracted from the outcome text. */
      proposal?: Record<string, unknown>;
    },
  ): Promise<SuggestionView> {
    const meta = {
      ...input.meta,
      modelId: input.outcome.modelId,
      build: input.outcome.build,
      threadId: input.outcome.threadId,
    };
    const base = {
      accountId: input.accountId,
      capability: input.capability,
      targetKind: input.targetKind,
      targetId: input.targetId,
      meta,
      principal,
      ctx,
    };
    if (input.outcome.error && !input.outcome.content) {
      return this.withhold(tx, { ...base, reason: 'unavailable', payload: { error: input.outcome.error } });
    }
    const proposal = input.proposal ?? extractProposal(input.outcome.content);
    if (!proposal) return this.withhold(tx, { ...base, reason: 'no_content', payload: {} });
    const { capability: _capability, ...body } = proposal;
    const parsed = parseProposal(input.capability, body);
    if (!parsed.ok)
      return this.withhold(tx, { ...base, reason: 'schema_error', payload: { problems: parsed.problems } });
    const setting = input.effective.capabilities[input.capability];
    if (parsed.value.confidence !== null && parsed.value.confidence < setting.threshold) {
      return this.withhold(tx, {
        ...base,
        reason: 'below_threshold',
        payload: parsed.value.payload,
        confidence: parsed.value.confidence,
      });
    }
    const row = await this.repo.insertSuggestion(tx, {
      accountId: input.accountId,
      capability: input.capability,
      targetKind: input.targetKind,
      targetId: input.targetId,
      status: 'offered',
      payload: parsed.value.payload,
      confidence: parsed.value.confidence,
      agentId: meta.agentId,
      promptVersion: meta.promptVersion,
      modelId: meta.modelId,
      threadId: meta.threadId,
      harnessBuild: meta.build,
      latencyMs: meta.latencyMs,
      expiresAt: new Date(Date.now() + setting.expires_minutes * 60_000),
      requestedBy: principal.userId,
    });
    await this.audit.account(tx, input.accountId, AXEL_ACTOR, ctx, [
      {
        entityKind: 'ai_suggestion',
        entityId: row.id,
        ticketId: input.targetKind === 'ticket' ? input.targetId : undefined,
        eventType: 'ai.suggestion.offered',
        aiSuggestionId: row.id,
        newValue: { capability: input.capability, confidence: parsed.value.confidence, agent_id: meta.agentId },
      },
    ]);
    return toView(row, null, stripProposal(input.outcome.content));
  }

  async withhold(
    tx: Tx,
    input: {
      accountId: string;
      capability: AiCapability;
      targetKind: AiTargetKind;
      targetId: string;
      reason: WithheldReason;
      payload: Record<string, unknown>;
      confidence?: number | null;
      meta: ProposalMeta;
      principal: Principal;
      ctx: RequestContext;
    },
  ): Promise<SuggestionView> {
    const row = await this.repo.insertSuggestion(tx, {
      accountId: input.accountId,
      capability: input.capability,
      targetKind: input.targetKind,
      targetId: input.targetId,
      status: 'withheld',
      withheldReason: input.reason,
      payload: input.payload,
      confidence: input.confidence ?? null,
      agentId: input.meta.agentId,
      promptVersion: input.meta.promptVersion,
      modelId: input.meta.modelId,
      threadId: input.meta.threadId,
      harnessBuild: input.meta.build,
      latencyMs: input.meta.latencyMs,
      requestedBy: input.principal.userId,
    });
    await this.security.write(
      {
        type: 'ai.suggestion.withheld',
        outcome: 'withheld',
        accountId: input.accountId,
        actorKind: input.principal.userId === SERVICE_USER_ID ? 'system' : 'user',
        actorId: input.principal.userId,
        principalKind: input.principal.kind,
        requestId: input.ctx.requestId,
        entityKind: 'ai_suggestion',
        entityId: row.id,
        attrs: { capability: input.capability, reason: input.reason, target: `${input.targetKind}:${input.targetId}` },
      },
      tx,
    );
    return toView(row);
  }

  /** Reads the target and runs the pre-flight; returns the request to send or the withheld row. */
  async prepare(
    tx: Tx,
    principal: Principal,
    ctx: RequestContext,
    input: { capability: AiCapability; target_id: string; instruction?: string },
  ): Promise<
    | { withheld: SuggestionView }
    | {
        accountId: string;
        ticketId: string;
        capability: AiCapability;
        agentId: string;
        promptVersion: string;
        message: string;
        effective: EffectiveSwitch;
        roleMap: Record<string, string>;
      }
  > {
    const ticket = (await this.tickets.get(principal, input.target_id, tx)) as TicketView;
    const effective = await this.settings.effective(tx, ticket.account_id);
    const agentId = effective.defaults.agents[input.capability];
    const meta = {
      agentId,
      promptVersion: CAPABILITY_BUILDERS[input.capability]!({ ticket: emptyFacts(ticket) }).promptVersion,
    };
    const base = {
      accountId: ticket.account_id,
      capability: input.capability,
      targetKind: 'ticket' as const,
      targetId: ticket.id,
      meta,
      principal,
      ctx,
      payload: {},
    };
    if (!effective.on) {
      const reason: WithheldReason =
        effective.reason === 'residency'
          ? 'residency'
          : effective.reason === 'kill_switch'
            ? 'capability_off'
            : 'switch_off';
      return { withheld: await this.withhold(tx, { ...base, reason }) };
    }
    if (!effective.capabilities[input.capability].enabled) {
      return { withheld: await this.withhold(tx, { ...base, reason: 'capability_off' }) };
    }
    const facts = await this.facts(tx, principal, ticket, effective.settings?.redaction_profile ?? 'standard', ctx);
    if (facts.refused) return { withheld: await this.withhold(tx, { ...base, reason: 'redaction_refused' }) };
    const context: CapabilityContext = {
      ticket: facts.ticket,
      tone: effective.settings?.draft_tone ?? 'plain',
      instruction: input.instruction ? redact(input.instruction, 'standard').text : undefined,
    };
    let candidates: CapabilityContext['candidates'];
    if (input.capability === 'duplicate') {
      const similar = await this.repo.similarTickets(tx, ticket.account_id, ticket.id, ticket.short_description);
      if (similar.length === 0) return { withheld: await this.withhold(tx, { ...base, reason: 'no_content' }) };
      candidates = similar.map((row) => ({
        ticket_id: row.id,
        key: `CS${String(row.number).padStart(7, '0')}`,
        short_description: redact(row.short_description, 'standard').text,
        state: row.state,
        similarity: Number(row.similarity),
      }));
    }
    const categories =
      input.capability === 'classify'
        ? (
            await tx.query<{ category: string }>(
              `select distinct category from acct.tickets where account_id = $1 and category is not null order by 1 limit 50`,
              [ticket.account_id],
            )
          ).rows.map((row) => row.category)
        : undefined;
    const built = CAPABILITY_BUILDERS[input.capability]!({ ...context, candidates, categories });
    return {
      accountId: ticket.account_id,
      ticketId: ticket.id,
      capability: input.capability,
      agentId,
      promptVersion: built.promptVersion,
      message: built.message,
      effective,
      roleMap: facts.roleMap,
    };
  }

  /** The redacted facts of a ticket for a capability request; work notes only for internal callers. */
  async facts(
    tx: Tx,
    principal: Principal,
    ticket: TicketView,
    profile: RedactionProfile,
    ctx: RequestContext,
  ): Promise<{ ticket: TicketFacts; refused: boolean; roleMap: Record<string, string> }> {
    const comments = (await this.tickets.comments(principal, ticket.id, tx)) as MessageRow[];
    const workNotes =
      principal.kind === 'portal' ? [] : ((await this.tickets.workNotes(principal, ticket.id, tx)) as MessageRow[]);
    const people: Person[] = ticket.requester
      ? [{ email: ticket.requester.email, name: ticket.requester.display_name, role: 'requester' }]
      : [];
    const counts: Record<string, number> = {};
    let refused = false;
    let roleMap: Record<string, string> = {};
    const scrub = (text: string | null | undefined): string => {
      const result = redact(text ?? '', profile, people);
      for (const [kind, count] of Object.entries(result.counts)) counts[kind] = (counts[kind] ?? 0) + count;
      refused = refused || result.refused;
      roleMap = { ...roleMap, ...result.roleMap };
      return result.text;
    };
    const facts: TicketFacts = {
      key: ticket.key,
      type: ticket.type,
      state: ticket.state,
      short_description: scrub(ticket.short_description),
      description: scrub(ticket.description),
      category: ticket.category,
      impact: ticket.impact,
      urgency: ticket.urgency,
      priority: ticket.priority,
      requester_label: profile === 'strict' ? '[requester]' : (ticket.requester?.display_name ?? 'unknown'),
      created_at: ticket.created_at,
      comments: comments.map((row) => ({
        author: profile === 'strict' && row.author_kind === 'portal_user' ? '[requester]' : row.author_name,
        kind: row.author_kind,
        at: row.created_at,
        body: scrub(row.body),
      })),
      work_notes: workNotes.map((row) => ({ author: row.author_name, at: row.created_at, body: scrub(row.body) })),
    };
    if (Object.keys(counts).length > 0 || refused) {
      await this.security.write({
        type: 'ai.egress.redacted',
        outcome: refused ? 'withheld' : 'success',
        accountId: ticket.account_id,
        actorKind: principal.userId === SERVICE_USER_ID ? 'system' : 'user',
        actorId: principal.userId,
        principalKind: principal.kind,
        requestId: ctx.requestId,
        entityKind: 'ticket',
        entityId: ticket.id,
        attrs: { counts, refused, profile },
      });
    }
    return { ticket: facts, refused, roleMap };
  }

  private async harnessFailure(
    principal: Principal,
    ctx: RequestContext,
    prepared: { accountId: string; ticketId: string; agentId: string; promptVersion: string; capability: AiCapability },
    error: Error,
    bound?: Tx,
  ): Promise<SuggestionView> {
    const detail =
      error instanceof HarnessUnavailableError ? `${error.status}: ${error.detail.slice(0, 300)}` : error.message;
    this.logger.warn(`harness call failed for ${prepared.ticketId}: ${detail}`);
    await this.security.write({
      type: 'ai.turn.failed',
      outcome: 'failed',
      accountId: prepared.accountId,
      actorKind: principal.userId === SERVICE_USER_ID ? 'system' : 'user',
      actorId: principal.userId,
      principalKind: principal.kind,
      requestId: ctx.requestId,
      entityKind: 'ticket',
      entityId: prepared.ticketId,
      attrs: { agent_id: prepared.agentId, detail },
    });
    return this.inTx(principal, bound, (tx) =>
      this.withhold(tx, {
        accountId: prepared.accountId,
        capability: prepared.capability,
        targetKind: 'ticket',
        targetId: prepared.ticketId,
        reason: 'unavailable',
        payload: { detail },
        meta: { agentId: prepared.agentId, promptVersion: prepared.promptVersion },
        principal,
        ctx,
      }),
    );
  }

  /** The apply step per capability (AI functionality technical 2.6 guards). */
  private async apply(
    tx: Tx,
    principal: Principal,
    ctx: RequestContext,
    suggestion: SuggestionRow,
    applied: Record<string, unknown>,
  ): Promise<void> {
    const tickets = this.tickets;
    if (suggestion.target_kind !== 'ticket') return;
    switch (suggestion.capability) {
      case 'classify':
      case 'prioritise': {
        const ticket = (await tickets.get(principal, suggestion.target_id, tx)) as TicketView;
        if (ticket.assignee_id)
          throw new ConflictException({ code: 'target_state', detail: 'intake suggestions apply before assignment' });
        const patch: Partial<PatchTicketDto> =
          suggestion.capability === 'classify'
            ? { version: ticket.version, category: String(applied.category) }
            : {
                version: ticket.version,
                impact: applied.impact as PatchTicketDto['impact'],
                urgency: applied.urgency as PatchTicketDto['urgency'],
              };
        await tickets.patch(principal, ctx, ticket.id, patch as PatchTicketDto, tx);
        return;
      }
      case 'duplicate': {
        if (!applied.merge_into) throw new BadRequestException({ code: 'merge_target_required' });
        await tickets.addLink(principal, ctx, suggestion.target_id, String(applied.merge_into), 'duplicate', tx);
        return;
      }
      default:
        // summarise and draft_reply are consumed by the person; accepting records the use.
        return;
    }
  }

  private inTx<T>(principal: Principal, bound: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return bound ? fn(bound) : this.uow.run(principal, fn);
  }
}

// Helpers -----------------------------------------------------------------

export const SERVICE_USER_ID = 'axel-service';

/** The worker's identity for batch calls: bound to one account, AI and ticket permissions only. */
export function servicePrincipal(accountId: string): Principal {
  const env = loadEnv();
  return {
    kind: 'internal',
    userId: SERVICE_USER_ID,
    email: env.AI_SERVICE_USER_EMAIL,
    displayName: 'Axel (XMS worker)',
    accountIds: [accountId],
    permissions: new Set(['ai:use', 'tickets:view', 'tickets:create', 'tickets:work'] as const),
    sessionId: undefined,
    tokenType: 'harness',
  };
}

/** Drains a harness stream into the answer text and the envelope facts. */
export async function consume(
  chunks: AsyncIterable<string>,
  started = Date.now(),
  onFrame?: (frame: HarnessFrame) => void | Promise<void>,
): Promise<TurnOutcome> {
  const parser = new SseParser();
  let content = '';
  let streamId: string | undefined;
  let modelId: string | undefined;
  let build: string | undefined;
  let threadId: string | undefined;
  let error: TurnOutcome['error'];
  let cancelled = false;
  let done = false;
  const handle = async (frame: HarnessFrame): Promise<void> => {
    switch (frame.type) {
      case 'text':
        content += frame.content;
        break;
      case 'stream_started':
        streamId = frame.stream_id;
        modelId = frame.model_id;
        build = frame.build;
        break;
      case 'thread_created':
        threadId = frame.thread_id;
        break;
      case 'error':
        error = { error: frame.error, code: frame.code };
        break;
      case 'cancelled':
        cancelled = true;
        break;
      case 'done':
        done = true;
        break;
      default:
        break;
    }
    if (onFrame) await onFrame(frame);
  };
  for await (const chunk of chunks) {
    for (const frame of parser.push(chunk)) await handle(frame);
    if (done) break;
  }
  if (!done) for (const frame of parser.end()) await handle(frame);
  return { content, streamId, modelId, build, threadId, error, cancelled, latencyMs: Date.now() - started };
}

function toView(row: SuggestionRow, decision?: DecisionRow | null, explanation?: string): SuggestionView {
  return {
    id: row.id,
    capability: row.capability,
    target_kind: row.target_kind,
    target_id: row.target_id,
    status: row.status_initial,
    withheld_reason: row.withheld_reason,
    payload: row.payload,
    confidence: row.confidence === null ? null : Number(row.confidence),
    agent_id: row.agent_id,
    prompt_version: row.prompt_version,
    model_id: row.model_id,
    thread_id: row.thread_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    decision: decision ?? null,
    explanation: explanation ? explanation.slice(0, 2000) : undefined,
  };
}

function emptyFacts(ticket: TicketView): TicketFacts {
  return {
    key: ticket.key,
    type: ticket.type,
    state: ticket.state,
    short_description: '',
    description: '',
    category: null,
    impact: null,
    urgency: null,
    priority: ticket.priority,
    requester_label: '',
    created_at: ticket.created_at,
    comments: [],
    work_notes: [],
  };
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}
