import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import type { AiCapability } from '../../contracts/ai.js';
import { redact } from '../../domain/ai/redaction.js';
import type { HarnessFrame } from '../../domain/ai/sse.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { UsageEventsService } from '../telemetry/telemetry.module.js';
import { TicketsService, type TicketView } from '../tickets/tickets.service.js';
import { AiRepository, type ThreadRow } from './ai.repository.js';
import { AiSettingsService } from './ai-settings.service.js';
import { isBuilt } from './capabilities.js';
import { HARNESS_CLIENT, HarnessUnavailableError, type HarnessClient } from './harness-client.js';
import { SessionTokenService } from './session-token.service.js';
import { consume, SuggestionService, type TurnOutcome } from './suggestion.service.js';

export interface TurnInput {
  readonly agent: 'desk_assistant';
  readonly message: string;
  readonly ticket_id: string;
  readonly thread_id?: string | null;
}

const OPPORTUNITY = 'solution:xms';
const CANCEL_TTL_MS = 15 * 60_000;

/**
 * The interactive face of the adapter (AI Integration section 3; AI
 * functionality technical section 4): one request is one assistant turn,
 * relayed frame by frame to the browser as SSE. The first turn of a thread
 * carries the redacted ticket facts; later turns carry the message only,
 * the harness thread holds the history. A structured proposal at the end
 * of the answer becomes an AISuggestion and is announced to the client as
 * an `xms_suggestion` frame before `[DONE]`. Attachment binaries are not
 * relayed (the panel has no file surface in the cut).
 */
@Injectable()
export class AxelService {
  private readonly logger = new Logger(AxelService.name);
  /** stream_id -> owner, for cancel; pruned on every turn. */
  private readonly streams = new Map<string, { userId: string; token: string; at: number }>();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: AiRepository,
    private readonly settings: AiSettingsService,
    private readonly tickets: TicketsService,
    private readonly suggestions: SuggestionService,
    private readonly session: SessionTokenService,
    @Inject(HARNESS_CLIENT) private readonly harness: HarnessClient,
    private readonly security: SecurityEventsService,
    private readonly usage: UsageEventsService,
  ) {}

  async turn(principal: Principal, ctx: RequestContext, input: TurnInput, response: Response): Promise<void> {
    const started = Date.now();
    this.prune();
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();
    const send = (frame: Record<string, unknown> | '[DONE]'): void => {
      response.write(`data: ${frame === '[DONE]' ? '[DONE]' : JSON.stringify(frame)}\n\n`);
    };
    const fail = async (code: string, detail: string, accountId?: string): Promise<void> => {
      await this.security.write({
        type: 'ai.turn.failed',
        outcome: code === 'withheld' ? 'withheld' : 'failed',
        accountId: accountId ?? null,
        actorKind: 'user',
        actorId: principal.userId,
        principalKind: principal.kind,
        requestId: ctx.requestId,
        entityKind: 'ticket',
        entityId: input.ticket_id,
        attrs: { code, detail },
      });
      send({ type: 'error', code, error: detail });
      send('[DONE]');
      response.end();
    };

    // Pre-flight in one unit of work: the ticket (404 when invisible), the switch, the facts.
    let prepared:
      | { ticket: TicketView; agentId: string; message: string; capabilities: Record<string, { enabled: boolean }> }
      | { withheld: string; accountId?: string };
    try {
      prepared = await this.uow.run(principal, async (tx) => {
        const ticket = (await this.tickets.get(principal, input.ticket_id, tx)) as TicketView;
        const effective = await this.settings.effective(tx, ticket.account_id);
        if (!effective.on) return { withheld: effective.reason ?? 'switch_off', accountId: ticket.account_id };
        const profile = effective.settings?.redaction_profile ?? 'standard';
        const message = redact(input.message, profile);
        if (message.refused) return { withheld: 'redaction_refused', accountId: ticket.account_id };
        let text = message.text;
        if (!input.thread_id) {
          const facts = await this.suggestions.facts(tx, principal, ticket, profile, ctx);
          if (facts.refused) return { withheld: 'redaction_refused', accountId: ticket.account_id };
          text = [
            `You are Axel inside XMS, helping ${principal.displayName} with the ticket below. Answer briefly. When asked for a reply draft or a summary, end with a fenced JSON block whose "capability" is "draft_reply" or "summarise" in the XMS proposal shape.`,
            '',
            ticketFactsText(facts.ticket),
            '',
            `Message: ${text}`,
          ].join('\n');
        }
        return {
          ticket,
          agentId: effective.defaults.agents.summarise,
          message: text,
          capabilities: effective.capabilities,
        };
      });
    } catch (error) {
      if (error instanceof NotFoundException) {
        await fail('not_found', 'ticket not found');
        return;
      }
      throw error;
    }
    if ('withheld' in prepared) {
      await fail('withheld', prepared.withheld, prepared.accountId);
      return;
    }
    const { ticket, agentId } = prepared;
    await this.security.write({
      type: 'ai.turn.started',
      outcome: 'success',
      accountId: ticket.account_id,
      actorKind: 'user',
      actorId: principal.userId,
      principalKind: principal.kind,
      requestId: ctx.requestId,
      entityKind: 'ticket',
      entityId: ticket.id,
      attrs: { agent_id: agentId, thread_id: input.thread_id ?? null },
    });

    const abort = new AbortController();
    response.on('close', () => abort.abort());
    let token: string;
    let outcome: TurnOutcome;
    try {
      token = await this.session.tokenFor(principal);
      const stream = await this.harness.stream(
        agentId,
        {
          session_id: `xms-${principal.userId}-${ticket.id}`,
          message: prepared.message,
          thread_id: input.thread_id ?? null,
          opportunity_id: OPPORTUNITY,
        },
        token,
        abort.signal,
      );
      outcome = await consume(stream.chunks, started, async (frame) => {
        await this.relay(frame, send, principal, ticket, agentId, token);
      });
    } catch (error) {
      const detail =
        error instanceof HarnessUnavailableError
          ? `${error.status}: ${error.detail.slice(0, 300)}`
          : (error as Error).message;
      this.logger.warn(`turn failed for ${ticket.id}: ${detail}`);
      await fail('unavailable', detail, ticket.account_id);
      return;
    }

    // A structured proposal at the end of the answer becomes a suggestion.
    const proposal = proposalOf(outcome.content);
    if (
      proposal &&
      isBuilt(String(proposal.capability)) &&
      prepared.capabilities[String(proposal.capability)]?.enabled
    ) {
      const capability = String(proposal.capability) as AiCapability;
      const suggestion = await this.uow.run(principal, async (tx) => {
        const effective = await this.settings.effective(tx, ticket.account_id);
        return this.suggestions.record(tx, principal, ctx, {
          accountId: ticket.account_id,
          capability,
          targetKind: 'ticket',
          targetId: ticket.id,
          outcome,
          proposal,
          meta: { agentId, promptVersion: `panel/${capability}`, latencyMs: outcome.latencyMs },
          effective,
        });
      });
      send({ type: 'xms_suggestion', suggestion });
    }
    this.usage.record({
      type: 'axel.turn.completed',
      accountId: ticket.account_id,
      actorKind: 'user',
      actorId: principal.userId,
      principalKind: principal.kind,
      sessionId: principal.sessionId,
      requestId: ctx.requestId,
      entityKind: 'ticket',
      entityId: ticket.id,
      outcome: outcome.error && !outcome.content ? 'failed' : 'success',
      attrs: {
        agent_id: agentId,
        latency_ms: outcome.latencyMs,
        cancelled: outcome.cancelled,
        thread_id: outcome.threadId ?? input.thread_id ?? null,
        proposal: proposal ? String(proposal.capability) : null,
      },
    });
    send('[DONE]');
    response.end();
  }

  async cancel(principal: Principal, streamId: string): Promise<{ cancelled: boolean }> {
    const owner = this.streams.get(streamId);
    if (!owner || owner.userId !== principal.userId)
      throw new NotFoundException({ code: 'not_found', entity: 'stream' });
    const cancelled = await this.harness.cancel(streamId, owner.token);
    this.streams.delete(streamId);
    return { cancelled };
  }

  threads(principal: Principal, ticketId: string): Promise<ThreadRow[]> {
    return this.uow.run(principal, (tx) => this.repo.threadsOf(tx, principal.userId, ticketId));
  }

  private async relay(
    frame: HarnessFrame,
    send: (frame: Record<string, unknown>) => void,
    principal: Principal,
    ticket: TicketView,
    agentId: string,
    token: string,
  ): Promise<void> {
    switch (frame.type) {
      case 'text':
        send({ content: frame.content });
        return;
      case 'stream_started':
        this.streams.set(frame.stream_id, { userId: principal.userId, token, at: Date.now() });
        send({ type: 'stream_started', stream_id: frame.stream_id });
        return;
      case 'thread_created':
        await this.uow.run(principal, (tx) =>
          this.repo.upsertThread(tx, {
            accountId: ticket.account_id,
            ticketId: ticket.id,
            userId: principal.userId,
            agentId,
            threadId: frame.thread_id,
            title: ticket.short_description.slice(0, 120),
          }),
        );
        send({ type: 'thread_created', thread_id: frame.thread_id });
        return;
      case 'attachment':
        send({ type: 'attachment', filename: frame.filename, mimeType: frame.mimeType, size: frame.size });
        return;
      case 'error':
        send({ type: 'error', error: frame.error, code: frame.code });
        return;
      case 'cancelled':
        send({ type: 'cancelled', reason: frame.reason });
        return;
      case 'other':
        send(frame.data);
        return;
      case 'unparsable':
        this.logger.warn(`unparsable harness frame: ${frame.raw.slice(0, 120)}`);
        return;
      default:
        return;
    }
  }

  private prune(): void {
    const cutoff = Date.now() - CANCEL_TTL_MS;
    for (const [id, entry] of this.streams) if (entry.at < cutoff) this.streams.delete(id);
  }
}

function proposalOf(content: string): Record<string, unknown> | undefined {
  const match = [...content.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].at(-1);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'capability' in (parsed as object)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function ticketFactsText(facts: {
  key: string;
  type: string;
  state: string;
  priority: string;
  requester_label: string;
  short_description: string;
  description: string;
  comments: readonly { author: string; kind: string; at: string; body: string }[];
  work_notes: readonly { author: string; at: string; body: string }[];
}): string {
  const lines = [
    `Ticket ${facts.key} (${facts.type}, ${facts.state}, ${facts.priority}); requester ${facts.requester_label}`,
    `Short description: ${facts.short_description}`,
    `Description: ${facts.description.slice(0, 4000) || '(none)'}`,
  ];
  for (const comment of facts.comments.slice(-15))
    lines.push(`- ${comment.at} ${comment.author} (${comment.kind}): ${comment.body.slice(0, 1200)}`);
  if (facts.work_notes.length > 0) lines.push('Internal work notes (never quote to the requester):');
  for (const note of facts.work_notes.slice(-15))
    lines.push(`- ${note.at} ${note.author}: ${note.body.slice(0, 1200)}`);
  return lines.join('\n');
}
