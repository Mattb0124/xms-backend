import { Injectable } from '@nestjs/common';
import type { AiCapability, AiDecision, AiTargetKind, WithheldReason } from '../../contracts/ai.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';

export interface AiSettingsRow {
  id: string;
  account_id: string;
  enabled: boolean;
  dpa_reference: string | null;
  residency_region: string;
  redaction_profile: 'standard' | 'strict';
  draft_tone: 'plain' | 'formal';
  capabilities: Record<string, unknown>;
  auto_apply_approval_ref: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SuggestionRow {
  id: string;
  account_id: string;
  capability: AiCapability;
  target_kind: AiTargetKind;
  target_id: string;
  status_initial: 'offered' | 'withheld';
  withheld_reason: WithheldReason | null;
  payload: Record<string, unknown>;
  confidence: string | null;
  agent_id: string;
  prompt_version: string;
  model_id: string;
  thread_id: string | null;
  harness_build: string | null;
  latency_ms: number | null;
  expires_at: string | null;
  requested_by: string;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  account_id: string;
  suggestion_id: string;
  decision: AiDecision;
  decided_by_kind: 'user' | 'system';
  decided_by_id: string;
  applied_payload: Record<string, unknown> | null;
  edit_distance: number | null;
  reject_reason: string | null;
  audit_event_id: string | null;
  policy_version: string | null;
  created_at: string;
}

export interface ThreadRow {
  id: string;
  account_id: string;
  ticket_id: string | null;
  user_id: string;
  agent_id: string;
  thread_id: string;
  title: string | null;
  created_at: string;
  last_turn_at: string;
}

/**
 * SQL for the AI tables (AI functionality technical section 2). Every
 * query runs under the caller's binding; the suggestion insert relies on
 * the restrictive switch policy to refuse an offered row for a disabled
 * account, which the service reports as a typed 409.
 */
@Injectable()
export class AiRepository extends RepositoryBase {
  settings(tx: Tx, accountId: string): Promise<AiSettingsRow | undefined> {
    return this.maybeOne(tx, 'select * from acct.ai_settings where account_id = $1', [accountId]);
  }

  insertSettings(tx: Tx, accountId: string, values: Partial<AiSettingsRow>): Promise<AiSettingsRow> {
    return this.one(
      tx,
      'ai_settings',
      `insert into acct.ai_settings (account_id, enabled, dpa_reference, residency_region, redaction_profile, draft_tone, capabilities, auto_apply_approval_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        accountId,
        values.enabled ?? false,
        values.dpa_reference ?? null,
        values.residency_region ?? 'us',
        values.redaction_profile ?? 'standard',
        values.draft_tone ?? 'plain',
        JSON.stringify(values.capabilities ?? {}),
        values.auto_apply_approval_ref ?? null,
      ],
    );
  }

  updateSettings(tx: Tx, id: string, version: number, assignments: Record<string, unknown>): Promise<AiSettingsRow> {
    const values = { ...assignments };
    if ('capabilities' in values) values.capabilities = JSON.stringify(values.capabilities);
    return this.updateVersioned(tx, 'ai_settings', 'acct.ai_settings', id, version, values);
  }

  insertSuggestion(
    tx: Tx,
    input: {
      accountId: string;
      capability: AiCapability;
      targetKind: AiTargetKind;
      targetId: string;
      status: 'offered' | 'withheld';
      withheldReason?: WithheldReason;
      payload: Record<string, unknown>;
      confidence: number | null;
      agentId: string;
      promptVersion: string;
      modelId?: string;
      threadId?: string | null;
      harnessBuild?: string | null;
      latencyMs?: number | null;
      expiresAt?: Date | null;
      requestedBy: string;
    },
  ): Promise<SuggestionRow> {
    return this.one(
      tx,
      'ai_suggestion',
      `insert into acct.ai_suggestions
         (account_id, capability, target_kind, target_id, status_initial, withheld_reason, payload, confidence, agent_id,
          prompt_version, model_id, thread_id, harness_build, latency_ms, expires_at, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning *`,
      [
        input.accountId,
        input.capability,
        input.targetKind,
        input.targetId,
        input.status,
        input.withheldReason ?? null,
        JSON.stringify(input.payload),
        input.confidence,
        input.agentId,
        input.promptVersion,
        input.modelId ?? 'unknown',
        input.threadId ?? null,
        input.harnessBuild ?? null,
        input.latencyMs ?? null,
        input.expiresAt ?? null,
        input.requestedBy,
      ],
    );
  }

  suggestion(tx: Tx, id: string): Promise<SuggestionRow> {
    return this.one(tx, 'ai_suggestion', 'select * from acct.ai_suggestions where id = $1', [id]);
  }

  decisionsOf(tx: Tx, suggestionId: string): Promise<DecisionRow[]> {
    return this.many(tx, 'select * from acct.ai_suggestion_decisions where suggestion_id = $1 order by created_at', [
      suggestionId,
    ]);
  }

  /** Offered, undecided and unexpired suggestions for a record, newest first per capability. */
  openFor(tx: Tx, targetKind: AiTargetKind, targetId: string): Promise<SuggestionRow[]> {
    return this.many(
      tx,
      `select distinct on (s.capability) s.*
         from acct.ai_suggestions s
        where s.target_kind = $1 and s.target_id = $2 and s.status_initial = 'offered'
          and (s.expires_at is null or s.expires_at > now())
          and not exists (select 1 from acct.ai_suggestion_decisions d where d.suggestion_id = s.id)
        order by s.capability, s.created_at desc`,
      [targetKind, targetId],
    );
  }

  /** Every suggestion for a record with its decision, for the record's AI history. */
  historyFor(
    tx: Tx,
    targetKind: AiTargetKind,
    targetId: string,
  ): Promise<(SuggestionRow & { decision: DecisionRow | null })[]> {
    return this.many(
      tx,
      `select s.*, (select row_to_json(d) from acct.ai_suggestion_decisions d where d.suggestion_id = s.id order by (d.decision <> 'expired') desc, d.created_at desc limit 1) as decision
         from acct.ai_suggestions s
        where s.target_kind = $1 and s.target_id = $2
        order by s.created_at desc limit 100`,
      [targetKind, targetId],
    );
  }

  insertDecision(
    tx: Tx,
    input: {
      accountId: string;
      suggestionId: string;
      decision: AiDecision;
      byKind: 'user' | 'system';
      byId: string;
      appliedPayload?: Record<string, unknown> | null;
      editDistance?: number | null;
      rejectReason?: string | null;
      policyVersion?: string | null;
    },
  ): Promise<DecisionRow> {
    return this.one(
      tx,
      'ai_decision',
      `insert into acct.ai_suggestion_decisions
         (account_id, suggestion_id, decision, decided_by_kind, decided_by_id, applied_payload, edit_distance, reject_reason, policy_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [
        input.accountId,
        input.suggestionId,
        input.decision,
        input.byKind,
        input.byId,
        input.appliedPayload ? JSON.stringify(input.appliedPayload) : null,
        input.editDistance ?? null,
        input.rejectReason ?? null,
        input.policyVersion ?? null,
      ],
    );
  }

  insertFeedback(
    tx: Tx,
    input: { accountId: string; suggestionId: string; rating: number; comment?: string | null; authorId: string },
  ): Promise<{ id: string }> {
    return this.one(
      tx,
      'ai_feedback',
      `insert into acct.ai_feedback (account_id, suggestion_id, rating, comment, author_id) values ($1, $2, $3, $4, $5) returning id`,
      [input.accountId, input.suggestionId, input.rating, input.comment ?? null, input.authorId],
    );
  }

  /** Offered suggestions past their expiry with no decision at all. */
  expiredCandidates(tx: Tx, now: Date, limit = 500): Promise<{ id: string; account_id: string }[]> {
    return this.many(
      tx,
      `select s.id, s.account_id from acct.ai_suggestions s
        where s.status_initial = 'offered' and s.expires_at is not null and s.expires_at <= $1
          and not exists (select 1 from acct.ai_suggestion_decisions d where d.suggestion_id = s.id)
        order by s.expires_at limit $2`,
      [now, limit],
    );
  }

  upsertThread(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string | null;
      userId: string;
      agentId: string;
      threadId: string;
      title?: string;
    },
  ): Promise<ThreadRow> {
    return this.one(
      tx,
      'ai_thread',
      `insert into acct.ai_threads (account_id, ticket_id, user_id, agent_id, thread_id, title)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (account_id, user_id, thread_id) do update set last_turn_at = now(), title = coalesce(acct.ai_threads.title, excluded.title)
       returning *`,
      [input.accountId, input.ticketId, input.userId, input.agentId, input.threadId, input.title ?? null],
    );
  }

  threadsOf(tx: Tx, userId: string, ticketId: string): Promise<ThreadRow[]> {
    return this.many(
      tx,
      'select * from acct.ai_threads where user_id = $1 and ticket_id = $2 order by last_turn_at desc limit 20',
      [userId, ticketId],
    );
  }

  /**
   * Duplicate candidates without embeddings (duplicate v1): trigram
   * similarity of the short description plus a full-text match over the
   * description, resolved or open, same account, newest first.
   */
  similarTickets(
    tx: Tx,
    accountId: string,
    ticketId: string,
    shortDescription: string,
    limit = 5,
  ): Promise<{ id: string; number: string; short_description: string; state: string; similarity: number }[]> {
    return this.many(
      tx,
      `select t.id, t.number, t.short_description, t.state,
              greatest(similarity(t.short_description, $3), 0)::float as similarity
         from acct.tickets t
        where t.account_id = $1 and t.id <> $2 and t.state <> 'cancelled'
          and (t.short_description % $3 or similarity(t.short_description, $3) > 0.2)
        order by similarity desc, t.created_at desc
        limit $4`,
      [accountId, ticketId, shortDescription, limit],
    );
  }

  /** Accuracy counts per capability (AI-13) and the threshold what-if from stored confidences. */
  accuracy(
    tx: Tx,
    accountIds: string[],
    capability: AiCapability | undefined,
    from: Date,
    to: Date,
    threshold: number | undefined,
  ): Promise<Record<string, unknown>[]> {
    return this.many(
      tx,
      `with s as (
         select s.*, d.decision
           from acct.ai_suggestions s
           left join acct.ai_suggestion_decisions d on d.suggestion_id = s.id and d.decision <> 'expired'
          where s.account_id = any ($1::uuid[]) and s.created_at >= $3 and s.created_at < $4
            and ($2::text is null or s.capability = $2)
       )
       select capability,
              count(*) filter (where status_initial = 'offered')::int as offered,
              count(*) filter (where status_initial = 'withheld')::int as withheld,
              count(*) filter (where decision = 'accepted')::int as accepted,
              count(*) filter (where decision = 'edited_accepted')::int as edited_accepted,
              count(*) filter (where decision = 'rejected')::int as rejected,
              count(*) filter (where decision = 'auto_applied')::int as auto_applied,
              count(*) filter (where status_initial = 'offered' and decision is null and expires_at <= now())::int as expired,
              count(*) filter (where status_initial = 'offered' and decision is null and (expires_at is null or expires_at > now()))::int as open,
              (select jsonb_object_agg(reason, n) from (select withheld_reason as reason, count(*)::int as n from s x where x.capability = s.capability and x.withheld_reason is not null group by 1) r) as withheld_reasons,
              count(*) filter (where $5::numeric is not null and status_initial = 'offered' and confidence is not null and confidence < $5)::int as what_if_withheld,
              count(*) filter (where $5::numeric is not null and status_initial = 'offered' and (confidence is null or confidence >= $5) and decision in ('accepted', 'edited_accepted'))::int as what_if_accepted,
              count(*) filter (where $5::numeric is not null and status_initial = 'offered' and (confidence is null or confidence >= $5) and decision is not null)::int as what_if_decided
         from s
        group by capability
        order by capability`,
      [accountIds, capability ?? null, from, to, threshold ?? null],
    );
  }
}
