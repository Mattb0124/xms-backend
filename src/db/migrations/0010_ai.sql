-- 0010 AI functionality (AI functionality technical section 2; AI Integration
-- sections 3 and 6) cut to the day-30 set: the per-account AI switch and
-- capability settings, suggestions with their decisions and feedback, the
-- thread index for the Axel panel, the operator defaults catalog kind `ai`.
-- The embeddings table waits for the harness embeddings endpoint (AI
-- Integration section 8, change 2) and lands with the duplicate v2 cut.

-- The configuration catalogs gain the `ai` kind (operator defaults and kill
-- switches; accounts may override capability settings through ai_settings,
-- not through config_overrides, so the override constraint is widened only
-- to keep the two tables' vocabularies identical).
alter table op.config_defaults drop constraint config_defaults_kind_check;
alter table op.config_defaults add constraint config_defaults_kind_check
  check (kind in ('state_machine', 'priority_matrix', 'sla_policy', 'activity_types', 'billable_classes', 'resolution_codes', 'ai'));
alter table acct.config_overrides drop constraint config_overrides_kind_check;
alter table acct.config_overrides add constraint config_overrides_kind_check
  check (kind in ('state_machine', 'priority_matrix', 'sla_policy', 'activity_types', 'billable_classes', 'resolution_codes', 'ai'));

-- ---------------------------------------------------------------------------
-- acct.ai_settings: the master switch (AI-11) and the capability opt-ins.
-- One row per account, created on first configuration; an account without
-- a row is off. Enabling requires a DPA reference (constraint) and a
-- residency the harness serves (service check against the defaults).
-- ---------------------------------------------------------------------------
create table acct.ai_settings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references op.accounts (id),
  enabled boolean not null default false,
  dpa_reference text,
  residency_region text not null default 'us',
  redaction_profile text not null default 'standard' check (redaction_profile in ('standard', 'strict')),
  draft_tone text not null default 'plain' check (draft_tone in ('plain', 'formal')),
  capabilities jsonb not null default '{}'::jsonb,
  auto_apply_approval_ref text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_settings_enable_requires_dpa check (not enabled or dpa_reference is not null)
);
create trigger trg_acct_ai_settings_updated before update on acct.ai_settings for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.ai_settings', false);
create constraint trigger trg_acct_ai_settings_require_audit after update on acct.ai_settings
  deferrable initially deferred for each row execute function sys.require_audit();

-- ---------------------------------------------------------------------------
-- acct.ai_threads: which harness thread belongs to which ticket and user.
-- XMS stores the reference, never the thread (AI Integration section 6).
-- ---------------------------------------------------------------------------
create table acct.ai_threads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid references acct.tickets (id),
  user_id uuid not null,
  agent_id text not null,
  thread_id text not null,
  title text,
  created_at timestamptz not null default now(),
  last_turn_at timestamptz not null default now()
);
create unique index ux_acct_ai_threads_thread on acct.ai_threads (account_id, user_id, thread_id);
create index ix_acct_ai_threads_ticket on acct.ai_threads (account_id, ticket_id, last_turn_at desc);
select sys.apply_account_isolation('acct.ai_threads', false);

-- ---------------------------------------------------------------------------
-- acct.ai_suggestions (append-only): every proposal Axel made or would have
-- made. Withheld rows keep the switch, threshold and outage history
-- measurable (AI-09, AI-13); the payload is kept on below-threshold rows so
-- the accuracy what-if can be computed from stored confidences.
-- ---------------------------------------------------------------------------
create table acct.ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  capability text not null check (capability in ('classify', 'prioritise', 'duplicate', 'summarise', 'draft_reply', 'wsr_narrative', 'time_entry', 'burn_anomaly')),
  target_kind text not null check (target_kind in ('ticket', 'report_run', 'person_day', 'contract_period', 'queue_query')),
  target_id text not null,
  status_initial text not null check (status_initial in ('offered', 'withheld')),
  withheld_reason text check (withheld_reason in ('below_threshold', 'switch_off', 'capability_off', 'residency', 'redaction_refused', 'unavailable', 'no_content', 'schema_error')),
  payload jsonb not null default '{}'::jsonb,
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  agent_id text not null,
  prompt_version text not null,
  model_id text not null default 'unknown',
  thread_id text,
  harness_build text,
  latency_ms integer,
  expires_at timestamptz,
  requested_by text not null,
  created_at timestamptz not null default now(),
  constraint ai_suggestions_withheld_reason check ((status_initial = 'withheld') = (withheld_reason is not null))
);
create index ix_acct_ai_suggestions_target on acct.ai_suggestions (account_id, target_kind, target_id, created_at desc);
create index ix_acct_ai_suggestions_accuracy on acct.ai_suggestions (account_id, capability, created_at);
create index ix_acct_ai_suggestions_expiry on acct.ai_suggestions (expires_at) where status_initial = 'offered';
create trigger trg_acct_ai_suggestions_append_only before update or delete on acct.ai_suggestions
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.ai_suggestions', false);
-- The AI switch enforced at the data layer (AI-11): an offered suggestion
-- cannot be inserted for an account whose switch is off, whatever the
-- adapter did. Restrictive, so it ANDs with the isolation policy.
create policy ai_suggestions_switch on acct.ai_suggestions as restrictive for insert to xms_app, xms_worker
  with check (
    status_initial = 'withheld'
    or exists (select 1 from acct.ai_settings s where s.account_id = ai_suggestions.account_id and s.enabled)
  );

-- ---------------------------------------------------------------------------
-- acct.ai_suggestion_decisions (append-only): the human (or policy)
-- outcome. One final decision per suggestion; expiry is not final so a
-- late human decision on an expired suggestion is still refused by the
-- service, not by the index.
-- ---------------------------------------------------------------------------
create table acct.ai_suggestion_decisions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  suggestion_id uuid not null references acct.ai_suggestions (id),
  decision text not null check (decision in ('accepted', 'edited_accepted', 'rejected', 'expired', 'auto_applied')),
  decided_by_kind text not null check (decided_by_kind in ('user', 'system')),
  decided_by_id text not null,
  applied_payload jsonb,
  edit_distance integer,
  reject_reason text check (reject_reason in ('wrong', 'unnecessary', 'already_done', 'unclear', 'other')),
  audit_event_id uuid,
  policy_version text,
  created_at timestamptz not null default now()
);
create unique index ux_acct_ai_decisions_one_final on acct.ai_suggestion_decisions (suggestion_id) where decision <> 'expired';
create unique index ux_acct_ai_decisions_one_expiry on acct.ai_suggestion_decisions (suggestion_id) where decision = 'expired';
create index ix_acct_ai_decisions_suggestion on acct.ai_suggestion_decisions (account_id, suggestion_id);
create trigger trg_acct_ai_suggestion_decisions_append_only before update or delete on acct.ai_suggestion_decisions
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.ai_suggestion_decisions', false);

-- ---------------------------------------------------------------------------
-- acct.ai_feedback (append-only): optional free-form feedback.
-- ---------------------------------------------------------------------------
create table acct.ai_feedback (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  suggestion_id uuid not null references acct.ai_suggestions (id),
  rating integer not null check (rating between 1 and 5),
  comment text,
  author_id text not null,
  created_at timestamptz not null default now()
);
create index ix_acct_ai_feedback_suggestion on acct.ai_feedback (account_id, suggestion_id);
create trigger trg_acct_ai_feedback_append_only before update or delete on acct.ai_feedback
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.ai_feedback', false);

-- ---------------------------------------------------------------------------
-- Disabling the switch cascades (AI-11): every open suggestion expires and
-- an audit event records the cascade, in the same transaction as the flip.
-- Runs under the caller's binding, so the isolation policies still apply.
-- ---------------------------------------------------------------------------
create or replace function acct.ai_disable_cascade() returns trigger
language plpgsql as $$
begin
  insert into acct.ai_suggestion_decisions (account_id, suggestion_id, decision, decided_by_kind, decided_by_id, policy_version)
  select s.account_id, s.id, 'expired', 'system', 'ai_switch', 'switch_off'
    from acct.ai_suggestions s
   where s.account_id = new.account_id
     and s.status_initial = 'offered'
     and not exists (select 1 from acct.ai_suggestion_decisions d where d.suggestion_id = s.id);
  insert into acct.audit_events (account_id, entity_kind, entity_id, event_type, field, old_value, new_value, actor_kind, actor_id, actor_name)
  values (new.account_id, 'ai_settings', new.id::text, 'ai.settings.changed', 'cascade', 'true'::jsonb, 'false'::jsonb, 'system', 'ai_switch', 'XMS');
  return null;
end $$;
create trigger trg_acct_ai_settings_disable after update of enabled on acct.ai_settings
  for each row when (old.enabled and not new.enabled)
  execute function acct.ai_disable_cascade();

-- The portal has no AI surface at all (AI functionality technical section 4).
revoke all on acct.ai_settings, acct.ai_threads, acct.ai_suggestions, acct.ai_suggestion_decisions, acct.ai_feedback from xms_portal;
