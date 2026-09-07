-- 0003 The first account-scoped tables with the RLS framework, the audit
-- guard, and the security event stream (Implementation Plan P1.3.2, P1.3.6,
-- P1.3.8; Data Model section 3; Audit & Analytics sections 3 to 6).
--
-- Every acct.* table created here follows the same block: account_id NOT
-- NULL, ENABLE and FORCE ROW LEVEL SECURITY, the operator policy with USING
-- and WITH CHECK, and the portal policy only where the portal may read.
-- The isolation suite (test/isolation) fails the build if a later migration
-- forgets any part of that block.

-- Reusable policy installer so no migration hand-types the policies.
create or replace function sys.apply_account_isolation(target regclass, portal_read boolean default false) returns void
language plpgsql as $$
declare
  schema_name text;
  table_name text;
begin
  select n.nspname, c.relname into schema_name, table_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = target;
  execute format('alter table %I.%I enable row level security', schema_name, table_name);
  execute format('alter table %I.%I force row level security', schema_name, table_name);
  execute format(
    'create policy acct_isolation_operator on %I.%I to xms_app, xms_worker
       using (account_id = any (sys.account_ids()))
       with check (account_id = any (sys.account_ids()))',
    schema_name, table_name);
  if portal_read then
    execute format(
      'create policy acct_isolation_portal on %I.%I to xms_portal
         using (account_id = sys.account_id())
         with check (account_id = sys.account_id())',
      schema_name, table_name);
    execute format('grant select on %I.%I to xms_portal', schema_name, table_name);
  else
    execute format('revoke all on %I.%I from xms_portal', schema_name, table_name);
  end if;
end $$;

-- Existence probe for the isolation-filtered signal (Audit & Analytics 5.1):
-- returns only whether a row with that id exists in the table, regardless of
-- the session's account set. SECURITY DEFINER so it bypasses RLS; the
-- allowlist of tables keeps it from becoming an oracle for anything else.
create or replace function sys.row_exists(target text, row_id uuid) returns boolean
language plpgsql security definer set search_path = pg_catalog, acct, sys as $$
declare
  found boolean;
begin
  if target !~ '^acct\.[a-z_]+$' then
    raise exception 'row_exists: unsupported table %', target using errcode = 'invalid_parameter_value';
  end if;
  execute format('select exists (select 1 from %s where id = $1)', target) into found using row_id;
  return found;
end $$;
revoke all on function sys.row_exists(text, uuid) from public;
grant execute on function sys.row_exists(text, uuid) to xms_app, xms_worker;

-- ---------------------------------------------------------------------------
-- acct.account_settings (one row per account)
-- ---------------------------------------------------------------------------
create table acct.account_settings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  portal_enabled boolean not null default false,
  consumption_visible boolean not null default false,
  csat_enabled boolean not null default false,
  sync_mode text not null default 'off' check (sync_mode in ('off', 'ingest_only', 'bidirectional')),
  ai_enabled boolean not null default false,
  ai_opt_ins jsonb not null default '{}'::jsonb,
  ai_region_ok boolean not null default true,
  email_branding jsonb not null default '{}'::jsonb,
  outbound_identity text,
  inbound_aliases text[] not null default '{}',
  retention_days integer not null default 2555,
  attachment_max_bytes bigint not null default 26214400,
  usage_analytics_portal boolean not null default true,
  store_search_terms boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_account_settings_account on acct.account_settings (account_id);
create trigger trg_acct_account_settings_updated before update on acct.account_settings for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.account_settings', false);

-- ---------------------------------------------------------------------------
-- acct.config_overrides (per-account catalog overrides; same shape as
-- op.config_defaults so ConfigResolver merges by kind and scope)
-- ---------------------------------------------------------------------------
create table acct.config_overrides (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  kind text not null check (kind in ('state_machine', 'priority_matrix', 'sla_policy', 'activity_types', 'billable_classes', 'resolution_codes')),
  scope_key text not null default '*',
  version integer not null,
  body jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  activated_at timestamptz,
  activated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ux_acct_config_overrides_version on acct.config_overrides (account_id, kind, scope_key, version);
create unique index ux_acct_config_overrides_active on acct.config_overrides (account_id, kind, scope_key) where status = 'active';
create trigger trg_acct_config_overrides_updated before update on acct.config_overrides for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.config_overrides', false);

-- ---------------------------------------------------------------------------
-- Business calendars (Accounts & Administration technical 2.4)
-- ---------------------------------------------------------------------------
create table acct.business_calendars (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  name text not null,
  time_zone text not null,
  effective_from date not null default current_date,
  holiday_calendar_id uuid,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_business_calendars_name on acct.business_calendars (account_id, lower(name));
create trigger trg_acct_business_calendars_updated before update on acct.business_calendars for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.business_calendars', true);

create table acct.calendar_hours (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  calendar_id uuid not null references acct.business_calendars (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_minute integer not null check (start_minute between 0 and 1440),
  end_minute integer not null check (end_minute between 0 and 1440),
  constraint ck_calendar_hours_order check (end_minute > start_minute),
  constraint ex_calendar_hours_overlap exclude using gist (
    calendar_id with =, weekday with =, int4range(start_minute, end_minute) with &&
  )
);
select sys.apply_account_isolation('acct.calendar_hours', true);

create table acct.calendar_holidays (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  calendar_id uuid not null references acct.business_calendars (id) on delete cascade,
  date date not null,
  label text not null
);
create unique index ux_acct_calendar_holidays on acct.calendar_holidays (calendar_id, date);
select sys.apply_account_isolation('acct.calendar_holidays', true);

-- ---------------------------------------------------------------------------
-- acct.audit_events: the domain audit stream (Security section 7), monthly
-- partitions, append-only, portal role has no grant.
-- ---------------------------------------------------------------------------
create table acct.audit_events (
  id uuid not null default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  entity_kind text not null,
  entity_id text not null,
  ticket_id uuid,
  event_type text not null,
  field text,
  old_value jsonb,
  new_value jsonb,
  actor_kind text not null check (actor_kind in ('user', 'portal_user', 'api_client', 'system', 'ai')),
  actor_id text not null,
  actor_name text,
  correlation_id text,
  request_id text,
  ai_suggestion_id uuid,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);
select sys.ensure_month_partitions('acct.audit_events', date '2026-01-01', date '2028-12-01');
create index ix_acct_audit_events_ticket on acct.audit_events (ticket_id, created_at);
create index ix_acct_audit_events_entity on acct.audit_events (entity_kind, entity_id, created_at);
create index ix_acct_audit_events_account_time on acct.audit_events (account_id, created_at);
create index ix_acct_audit_events_request on acct.audit_events (request_id);
create trigger trg_acct_audit_events_append_only before update or delete on acct.audit_events
  for each row execute function sys.raise_append_only();
select sys.apply_account_isolation('acct.audit_events', false);

-- The audit guard (Data Model section 5): a protected table rejects an
-- update whose transaction did not also insert an audit event. The service
-- layer sets the transaction-local flag `xms.audited` through the audit
-- writer; a trigger on the audit table sets it too, so the check cannot be
-- satisfied by a bare SET LOCAL without an actual audit row.
create or replace function sys.mark_audited() returns trigger
language plpgsql as $$
begin
  perform set_config('xms.audited', 'true', true);
  return new;
end $$;
create trigger trg_acct_audit_events_mark after insert on acct.audit_events
  for each row execute function sys.mark_audited();

create or replace function sys.require_audit() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('xms.audited', true), '') <> 'true' then
    raise exception 'update on %.% requires an audit event in the same transaction', tg_table_schema, tg_table_name
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end $$;
-- Applied to acct.tickets, acct.contracts and acct.solution_articles by the
-- migrations that create them: constraint trigger, deferred to commit time so
-- the audit row may be written after the update inside the transaction.
--   create constraint trigger trg_<t>_require_audit after update on acct.<t>
--     deferrable initially deferred for each row execute function sys.require_audit();
-- account_settings is protected from this migration on.
create constraint trigger trg_acct_account_settings_require_audit after update on acct.account_settings
  deferrable initially deferred for each row execute function sys.require_audit();

-- ---------------------------------------------------------------------------
-- sys.security_events: operator-scoped, account_id nullable, monthly
-- partitions, append-only (Audit & Analytics 4.1, 6). xms_app inserts and
-- reads (the audit search checks the permission in the service); the portal
-- role has no grant.
-- ---------------------------------------------------------------------------
create table sys.security_events (
  id uuid not null default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  event_type text not null,
  account_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'portal_user', 'api_client', 'system', 'ai', 'sync', 'anonymous')),
  actor_id text not null default 'anonymous',
  actor_name text,
  principal_kind text check (principal_kind in ('internal', 'portal', 'api_client', 'harness')),
  session_id text,
  request_id text,
  trace_id text,
  correlation_id text,
  entity_kind text,
  entity_id text,
  outcome text not null check (outcome in ('success', 'denied', 'failed', 'withheld')),
  attrs jsonb not null default '{}'::jsonb,
  ip_hash text,
  user_agent_family text,
  geo_country text,
  app_version text not null default 'dev',
  primary key (id, occurred_at)
) partition by range (occurred_at);
select sys.ensure_month_partitions('sys.security_events', date '2026-01-01', date '2028-12-01');
create index ix_sys_security_events_time on sys.security_events (occurred_at);
create index ix_sys_security_events_account on sys.security_events (account_id, occurred_at);
create index ix_sys_security_events_actor on sys.security_events (actor_id, occurred_at);
create index ix_sys_security_events_type on sys.security_events (event_type, occurred_at);
create index ix_sys_security_events_request on sys.security_events (request_id);
create trigger trg_sys_security_events_append_only before update or delete on sys.security_events
  for each row execute function sys.raise_append_only();
grant select, insert on sys.security_events to xms_app, xms_worker;
revoke all on sys.security_events from xms_portal;
revoke all on sys.schema_checks from xms_portal;
