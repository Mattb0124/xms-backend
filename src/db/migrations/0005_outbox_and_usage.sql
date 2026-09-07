-- 0005 Connector framework tables (Integration Patterns section 2; P1.5.3)
-- and the usage stream (Audit & Analytics 4.2, 6; P1.5.6).

create table sys.outbox (
  id bigint generated always as identity primary key,
  account_id uuid not null,
  aggregate text not null,
  aggregate_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  correlation_id text not null,
  causation_id text,
  origin text not null default 'user',
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index ix_sys_outbox_pending on sys.outbox (id) where dispatched_at is null;
create index ix_sys_outbox_aggregate on sys.outbox (aggregate, aggregate_id, id);
grant select, insert on sys.outbox to xms_app;
grant select, insert, update on sys.outbox to xms_worker;
grant usage, select on sequence sys.outbox_id_seq to xms_app, xms_worker;
revoke all on sys.outbox from xms_portal;

create table sys.inbox (
  id bigint generated always as identity primary key,
  connector_instance_id text not null,
  external_id text not null,
  external_version text not null default '',
  account_id uuid,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  outcome text check (outcome in ('applied', 'dropped_duplicate', 'dropped_reflection', 'failed')),
  error text
);
create unique index ux_sys_inbox_dedupe on sys.inbox (connector_instance_id, external_id, external_version);
create index ix_sys_inbox_pending on sys.inbox (id) where applied_at is null;
grant select, insert, update on sys.inbox to xms_worker;
revoke all on sys.inbox from xms_app, xms_portal;

create table sys.dead_letters (
  id uuid primary key default gen_random_uuid(),
  queue text not null,
  account_id uuid,
  correlation_id text,
  payload jsonb not null,
  error text not null,
  attempts integer not null default 0,
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  resolution text not null default 'open' check (resolution in ('open', 'replayed', 'discarded')),
  resolved_by text,
  resolved_at timestamptz,
  resolution_reason text
);
create index ix_sys_dead_letters_open on sys.dead_letters (queue, last_failed_at) where resolution = 'open';
grant select, insert, update on sys.dead_letters to xms_worker;
grant select, update on sys.dead_letters to xms_app;
revoke all on sys.dead_letters from xms_portal;

create table sys.job_leases (
  name text primary key,
  holder text not null,
  leased_until timestamptz not null,
  last_run_at timestamptz,
  last_outcome text
);
grant select, insert, update, delete on sys.job_leases to xms_worker;
revoke all on sys.job_leases from xms_app, xms_portal;

-- Usage events: the frontend telemetry client and the API request
-- middleware write here through the worker queue (in dev, directly).
create table rpt.usage_events (
  id uuid not null default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  event_type text not null,
  account_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'portal_user', 'api_client', 'system', 'ai', 'sync', 'anonymous')),
  actor_id text not null default 'anonymous',
  principal_kind text check (principal_kind in ('internal', 'portal', 'api_client', 'harness')),
  session_id text,
  request_id text,
  trace_id text,
  entity_kind text,
  entity_id text,
  outcome text not null default 'success' check (outcome in ('success', 'denied', 'failed', 'withheld')),
  attrs jsonb not null default '{}'::jsonb,
  ip_hash text,
  user_agent_family text,
  app_version text not null default 'dev',
  primary key (id, occurred_at)
) partition by range (occurred_at);
select sys.ensure_month_partitions('rpt.usage_events', date '2026-01-01', date '2028-12-01');
create index ix_rpt_usage_events_time on rpt.usage_events (occurred_at);
create index ix_rpt_usage_events_account on rpt.usage_events (account_id, occurred_at);
create index ix_rpt_usage_events_actor on rpt.usage_events (actor_id, occurred_at);
create index ix_rpt_usage_events_type on rpt.usage_events (event_type, occurred_at);
create index ix_rpt_usage_events_request on rpt.usage_events (request_id);
create trigger trg_rpt_usage_events_append_only before update or delete on rpt.usage_events
  for each row execute function sys.raise_append_only();
-- Operator-wide reads for the usage dashboards (account_id may be null), so
-- the isolation block here is the operator policy over a nullable column:
-- rows without an account are visible to any operator session that holds
-- analytics:read (checked in the service); account rows follow the binding.
alter table rpt.usage_events enable row level security;
alter table rpt.usage_events force row level security;
create policy acct_isolation_operator on rpt.usage_events to xms_app, xms_worker
  using (account_id is null or account_id = any (sys.account_ids()))
  with check (account_id is null or account_id = any (sys.account_ids()));
grant select, insert on rpt.usage_events to xms_app, xms_worker;
revoke all on rpt.usage_events from xms_portal;

create table sys.telemetry_buffer_stats (
  id uuid primary key default gen_random_uuid(),
  observed_at timestamptz not null default now(),
  source text not null,
  accepted integer not null default 0,
  dropped integer not null default 0,
  detail jsonb not null default '{}'::jsonb
);
grant select, insert on sys.telemetry_buffer_stats to xms_app, xms_worker;
revoke all on sys.telemetry_buffer_stats from xms_portal;
