-- 0009 Reporting (Dashboards & Report Packs technical section 2; Audit &
-- Analytics section 7) cut to the day-30 set: daily snapshots, the portal
-- measure whitelist, portfolio roll-up, report runs and packs, the unified
-- events view for the audit search.

create table rpt.daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  snapshot_date date not null,
  taken_at timestamptz not null default now(),
  measure text not null,
  grain jsonb not null default '{}'::jsonb,
  numerator numeric(14,4),
  denominator numeric(14,4),
  value numeric(14,4) not null,
  source text not null default 'scheduled' check (source in ('scheduled', 'backfill')),
  created_at timestamptz not null default now()
);
create unique index ux_rpt_daily_snapshots_key on rpt.daily_snapshots (account_id, snapshot_date, measure, grain);
create index ix_rpt_daily_snapshots_series on rpt.daily_snapshots (account_id, measure, snapshot_date desc);
create trigger trg_rpt_daily_snapshots_append_only before update or delete on rpt.daily_snapshots
  for each row execute function sys.raise_append_only();

-- Portal whitelist of measures (the API filters too; the policy is the backstop).
create table rpt.portal_visible_measures (
  key text primary key,
  label text not null
);
insert into rpt.portal_visible_measures (key, label) values
  ('open_tickets', 'Open requests'),
  ('volume_created', 'Requests raised'),
  ('volume_resolved', 'Requests resolved'),
  ('sla_response_attainment', 'Response target met'),
  ('sla_resolution_attainment', 'Resolution target met'),
  ('mttr_minutes', 'Average time to resolve'),
  ('backlog_by_age', 'Open requests by age'),
  ('consumption_minutes', 'Hours consumed');
grant select on rpt.portal_visible_measures to xms_portal, xms_app, xms_worker;

alter table rpt.daily_snapshots enable row level security;
alter table rpt.daily_snapshots force row level security;
create policy acct_isolation_operator on rpt.daily_snapshots to xms_app, xms_worker
  using (account_id = any (sys.account_ids()))
  with check (account_id = any (sys.account_ids()));
create policy acct_isolation_portal on rpt.daily_snapshots for select to xms_portal
  using (account_id = sys.account_id() and measure in (select key from rpt.portal_visible_measures));
grant select on rpt.daily_snapshots to xms_portal;

create table rpt.portfolio_daily (
  snapshot_date date not null,
  measure text not null,
  grain jsonb not null default '{}'::jsonb,
  value numeric(14,4) not null,
  taken_at timestamptz not null default now(),
  primary key (snapshot_date, measure, grain)
);
grant select on rpt.portfolio_daily to xms_app;
grant select, insert, update on rpt.portfolio_daily to xms_worker;
revoke all on rpt.portfolio_daily from xms_portal;

create table op.report_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pack_type text not null check (pack_type in ('wsr', 'qbr', 'custom')),
  master_key text,
  layout jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index ux_op_report_templates_default on op.report_templates (pack_type) where is_default;
insert into op.report_templates (name, pack_type, layout, is_default)
values ('Weekly status report', 'wsr', '{"slides": ["cover", "headline", "sla", "backlog", "consumption"]}'::jsonb, true);
revoke all on op.report_templates from xms_portal;

create table acct.report_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  schedule_id uuid,
  pack_type text not null check (pack_type in ('wsr', 'qbr', 'custom')),
  period_start date not null,
  period_end date not null,
  status text not null default 'queued' check (status in ('queued', 'generating', 'ready_for_review', 'awaiting_review', 'approved', 'sending', 'sent', 'failed', 'skipped')),
  claimed_by text,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  pack_id uuid,
  reviewer_id text,
  reviewed_at timestamptz,
  delivery jsonb,
  requested_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index ix_acct_report_runs_status on acct.report_runs (account_id, status, created_at desc);
create trigger trg_acct_report_runs_updated before update on acct.report_runs for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.report_runs', false);

create table acct.report_packs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  run_id uuid not null references acct.report_runs (id) on delete cascade,
  period_start date not null,
  period_end date not null,
  measures jsonb not null default '{}'::jsonb,
  notable jsonb not null default '[]'::jsonb,
  narrative_source text not null default 'template' check (narrative_source in ('axel', 'template')),
  narrative_versions jsonb not null default '[]'::jsonb,
  suggestion_id uuid,
  pptx_key text,
  pdf_key text,
  template_version integer not null default 1,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index ix_acct_report_packs_run on acct.report_packs (run_id);
create trigger trg_acct_report_packs_updated before update on acct.report_packs for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.report_packs', false);

-- ---------------------------------------------------------------------------
-- The unified events view for the Admin audit search (Audit & Analytics 7.1).
-- SECURITY INVOKER: each stream keeps its own grants and policies.
-- ---------------------------------------------------------------------------
create view rpt.events_v with (security_invoker = true) as
  select e.id, 'audit'::text as stream, e.created_at as occurred_at, e.event_type, e.account_id,
         e.actor_kind, e.actor_id, e.actor_name, null::text as principal_kind, null::text as session_id, e.request_id, e.correlation_id,
         e.entity_kind, e.entity_id, 'success'::text as outcome,
         jsonb_build_object('field', e.field, 'old_value', e.old_value, 'new_value', e.new_value, 'ticket_id', e.ticket_id) as attrs
    from acct.audit_events e
  union all
  select s.id, 'security', s.occurred_at, s.event_type, s.account_id,
         s.actor_kind, s.actor_id, s.actor_name, s.principal_kind, s.session_id, s.request_id, s.correlation_id,
         s.entity_kind, s.entity_id, s.outcome, s.attrs
    from sys.security_events s
  union all
  select u.id, 'usage', u.occurred_at, u.event_type, u.account_id,
         u.actor_kind, u.actor_id, null::text, u.principal_kind, u.session_id, u.request_id, null::text,
         u.entity_kind, u.entity_id, u.outcome, u.attrs
    from rpt.usage_events u;
grant select on rpt.events_v to xms_app, xms_worker;
revoke all on rpt.events_v from xms_portal;
