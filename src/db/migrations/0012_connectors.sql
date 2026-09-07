-- 0012 Connector framework and the ServiceNow instance model (Integration
-- Patterns sections 2 to 4; ServiceNow Sync technical section 2; P2.21.2 cut
-- to the Phase 2 scope: instances in ingest-only mode, versioned field and
-- state maps, sync links, journal and attachment links, sync runs, health).
-- Configuration is data: the same handler code serves every instance.

create table op.connector_types (
  key text primary key,
  label text not null,
  outbound_events text[] not null default '{}'::text[],
  created_at timestamptz not null default now()
);
insert into op.connector_types (key, label, outbound_events) values
  ('servicenow', 'ServiceNow', array['ticket.updated', 'ticket.transitioned', 'comment.created', 'work_note.created']);
grant select on op.connector_types to xms_app, xms_worker;
revoke all on op.connector_types from xms_portal;

-- ---------------------------------------------------------------------------
-- acct.connector_instances: one row per external instance per account. The
-- credential is a secret reference, never the secret. Mode and kill switch
-- changes are audited (guard trigger).
-- ---------------------------------------------------------------------------
create table acct.connector_instances (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  type text not null references op.connector_types (key),
  name text not null,
  base_url text not null,
  auth_kind text not null check (auth_kind in ('oauth_client_credentials', 'basic')),
  credential_secret_name text not null,
  credential_state text not null default 'unknown' check (credential_state in ('unknown', 'valid', 'invalid')),
  table_name text not null default 'sn_customerservice_case',
  profile text not null default 'csm' check (profile in ('csm', 'itsm')),
  mode text not null default 'off' check (mode in ('off', 'ingest_only', 'bidirectional')),
  kill_switch text not null default 'armed' check (kill_switch in ('armed', 'tripped')),
  trip_reason text,
  tripped_at timestamptz,
  tripped_by text,
  poll_interval_seconds integer not null default 60 check (poll_interval_seconds between 10 and 86400),
  next_poll_at timestamptz not null default now(),
  inbound_watermark timestamptz not null default '1970-01-01T00:00:00Z',
  inbound_watermark_sys_id text,
  webhook_secret_name text,
  active_field_map_id uuid,
  active_state_map_id uuid,
  journal_public text not null default 'comments',
  sync_work_notes boolean not null default false,
  attachment_limit_bytes integer not null default 10485760,
  attachment_over_limit text not null default 'link' check (attachment_over_limit in ('link', 'skip')),
  error_trip_threshold jsonb not null default '{"ratio": 0.5, "window_minutes": 15, "min_attempts": 10}'::jsonb,
  clock_tolerance_seconds integer not null default 5,
  health text not null default 'healthy' check (health in ('healthy', 'degraded', 'failing', 'tripped')),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ux_acct_connector_instances_name on acct.connector_instances (account_id, name);
create index ix_acct_connector_instances_poll on acct.connector_instances (type, next_poll_at)
  where mode <> 'off' and kill_switch = 'armed';
create trigger trg_acct_connector_instances_updated before update on acct.connector_instances
  for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.connector_instances', false);
-- Operator intent (mode, switch, endpoint, credential, maps, schedule) needs an audit row; the worker's own
-- touches (watermark, health, errors) do not, so the guard names the columns.
create constraint trigger trg_acct_connector_instances_require_audit
  after update of mode, kill_switch, base_url, credential_secret_name, table_name, profile, poll_interval_seconds,
    active_field_map_id, active_state_map_id, journal_public, sync_work_notes, attachment_limit_bytes,
    attachment_over_limit, error_trip_threshold, name on acct.connector_instances
  deferrable initially deferred for each row execute function sys.require_audit();

-- ---------------------------------------------------------------------------
-- Versioned maps: draft, validated, active, retired. Immutable once active
-- (the service refuses edits; the unique active index refuses two).
-- ---------------------------------------------------------------------------
create table acct.field_maps (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  instance_id uuid not null references acct.connector_instances (id),
  version integer not null,
  state text not null default 'draft' check (state in ('draft', 'validated', 'active', 'retired')),
  entries jsonb not null default '[]'::jsonb,
  validation_report jsonb,
  samples jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  activated_by text
);
create unique index ux_acct_field_maps_version on acct.field_maps (instance_id, version);
create unique index ux_acct_field_maps_active on acct.field_maps (instance_id) where state = 'active';
select sys.apply_account_isolation('acct.field_maps', false);

create table acct.state_maps (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  instance_id uuid not null references acct.connector_instances (id),
  version integer not null,
  state text not null default 'draft' check (state in ('draft', 'validated', 'active', 'retired')),
  entries jsonb not null default '{}'::jsonb,
  validation_report jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  activated_by text
);
create unique index ux_acct_state_maps_version on acct.state_maps (instance_id, version);
create unique index ux_acct_state_maps_active on acct.state_maps (instance_id) where state = 'active';
select sys.apply_account_isolation('acct.state_maps', false);

-- ---------------------------------------------------------------------------
-- Sync links: the XMS ticket and the external record, with both watermarks.
-- ---------------------------------------------------------------------------
create table acct.sync_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  instance_id uuid not null references acct.connector_instances (id),
  ticket_id uuid not null references acct.tickets (id),
  external_sys_id text not null,
  external_number text not null,
  state text not null default 'linked' check (state in ('linked', 'pending_external', 'pending_xms', 'conflict', 'unlinked')),
  last_outbound_at timestamptz,
  last_outbound_hash text,
  last_inbound_at timestamptz,
  last_inbound_sys_updated_on timestamptz,
  field_sor_overrides jsonb,
  last_conflict jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ux_acct_sync_links_ticket on acct.sync_links (instance_id, ticket_id);
create unique index ux_acct_sync_links_external on acct.sync_links (instance_id, external_sys_id);
create index ix_acct_sync_links_state on acct.sync_links (account_id, state)
  where state in ('conflict', 'pending_xms', 'pending_external');
create trigger trg_acct_sync_links_updated before update on acct.sync_links
  for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.sync_links', false);

create table acct.sync_journal_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  instance_id uuid not null references acct.connector_instances (id),
  ticket_id uuid not null references acct.tickets (id),
  xms_kind text not null check (xms_kind in ('comment', 'work_note')),
  xms_id uuid not null,
  external_journal_sys_id text not null,
  direction text not null check (direction in ('in', 'out')),
  created_at timestamptz not null default now()
);
create unique index ux_acct_sync_journal_links_external on acct.sync_journal_links (instance_id, external_journal_sys_id);
create unique index ux_acct_sync_journal_links_xms on acct.sync_journal_links (instance_id, xms_kind, xms_id);
create trigger trg_acct_sync_journal_links_append_only before update or delete on acct.sync_journal_links
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.sync_journal_links', false);

create table acct.sync_attachment_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  instance_id uuid not null references acct.connector_instances (id),
  ticket_id uuid not null references acct.tickets (id),
  attachment_id uuid,
  external_attachment_sys_id text not null,
  direction text not null check (direction in ('in', 'out')),
  outcome text not null check (outcome in ('copied', 'linked', 'skipped')),
  created_at timestamptz not null default now()
);
create unique index ux_acct_sync_attachment_links_external on acct.sync_attachment_links (instance_id, external_attachment_sys_id);
create trigger trg_acct_sync_attachment_links_append_only before update or delete on acct.sync_attachment_links
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.sync_attachment_links', false);

-- ---------------------------------------------------------------------------
-- Sync runs: one row per attempt, append-only, partitioned by month.
-- ---------------------------------------------------------------------------
create table acct.sync_runs (
  id uuid not null default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  instance_id uuid not null,
  direction text not null check (direction in ('in', 'out', 'poll', 'webhook')),
  ticket_id uuid,
  external_sys_id text,
  outbox_id bigint,
  inbox_id bigint,
  attempt integer not null default 1,
  outcome text not null check (outcome in ('success', 'retried', 'dead_lettered', 'skipped_reflection', 'skipped_policy', 'skipped_mode', 'noop')),
  error_class text check (error_class in ('retryable', 'terminal')),
  error_text text,
  duration_ms integer,
  detail jsonb,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);
select sys.ensure_month_partitions('acct.sync_runs', date '2026-01-01', date '2028-12-01');
create index ix_acct_sync_runs_instance on acct.sync_runs (instance_id, created_at desc);
create index ix_acct_sync_runs_health on acct.sync_runs (instance_id, outcome, created_at desc);
create trigger trg_acct_sync_runs_append_only before update or delete on acct.sync_runs
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.sync_runs', false);

-- Inbox rows carry the instance they belong to; the unique key drops duplicates before any domain write.
create unique index if not exists ux_sys_inbox_key on sys.inbox (connector_instance_id, external_id, external_version);
create index if not exists ix_sys_inbox_pending on sys.inbox (connector_instance_id, id) where applied_at is null;

-- Inbox retries: a retryable failure leaves the row pending and counts an attempt; the fifth moves it to the dead letters.
alter table sys.inbox add column if not exists attempts integer not null default 0;

-- The API administers the inbox and the dead letters (replay, discard); the worker fills them.
grant select, insert, update on sys.inbox, sys.dead_letters, sys.outbox to xms_app;
grant usage, select on sequence sys.inbox_id_seq to xms_app;
