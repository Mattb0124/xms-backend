-- 0002 Operator schema (Accounts & Administration technical section 2,
-- Implementation Plan P1.3.1). Operator tables have no account_id and no
-- RLS; the portal role gets no grant on any of them.

create table op.accounts (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  name text not null,
  legal_name text,
  status text not null default 'onboarding'
    check (status in ('onboarding', 'active', 'suspended', 'offboarding', 'offboarded')),
  isolation_tier text not null default 'shared' check (isolation_tier in ('shared', 'dedicated')),
  residency_region text not null default 'us-east-1',
  default_time_zone text not null default 'UTC',
  default_calendar_id uuid,
  branding jsonb not null default '{}'::jsonb,
  owner_user_id text,
  dedicated_db_ref text,
  offboarding jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_op_accounts_key on op.accounts (key);
create trigger trg_op_accounts_updated before update on op.accounts for each row execute function sys.set_updated_at();

create table op.users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text,
  kind text not null check (kind in ('internal', 'portal', 'service')),
  account_id uuid references op.accounts (id),
  email citext not null,
  first_name text not null default '',
  last_name text not null default '',
  title text,
  business_phone text,
  mobile_phone text,
  time_zone text not null default 'UTC',
  language text not null default 'en',
  date_format text not null default 'yyyy-MM-dd',
  status text not null default 'invited' check (status in ('invited', 'active', 'deactivated')),
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ck_op_users_portal_account check (kind <> 'portal' or account_id is not null)
);
create unique index ux_op_users_email on op.users (email);
create unique index ux_op_users_clerk on op.users (clerk_user_id) where clerk_user_id is not null;
create index ix_op_users_account on op.users (account_id) where account_id is not null;
create trigger trg_op_users_updated before update on op.users for each row execute function sys.set_updated_at();

create table op.roles (
  id uuid primary key default gen_random_uuid(),
  catalog text not null check (catalog in ('operator', 'portal')),
  name text not null,
  description text not null default '',
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_op_roles_name on op.roles (catalog, lower(name));
create trigger trg_op_roles_updated before update on op.roles for each row execute function sys.set_updated_at();

create table op.role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references op.users (id) on delete cascade,
  role_id uuid not null references op.roles (id) on delete cascade,
  account_id uuid references op.accounts (id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index ux_op_role_assignments on op.role_assignments
  (user_id, role_id, coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index ix_op_role_assignments_user on op.role_assignments (user_id);

create table op.account_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references op.users (id) on delete cascade,
  account_id uuid not null references op.accounts (id) on delete cascade,
  granted_by text not null,
  granted_at timestamptz not null default now()
);
create unique index ux_op_account_grants on op.account_grants (user_id, account_id);
create index ix_op_account_grants_account on op.account_grants (account_id);

create table op.assignment_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  service_line text,
  lead_user_id uuid references op.users (id),
  default_calendar_ref text,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_op_assignment_groups_name on op.assignment_groups (lower(name));
create trigger trg_op_assignment_groups_updated before update on op.assignment_groups for each row execute function sys.set_updated_at();

create table op.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references op.assignment_groups (id) on delete cascade,
  user_id uuid not null references op.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index ux_op_group_members on op.group_members (group_id, user_id);

create table op.api_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid references op.users (id),
  service_user_id uuid not null references op.users (id),
  key_prefix text not null,
  lookup_hash text not null,
  secret_hash text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_op_api_clients_lookup on op.api_clients (lookup_hash);
create trigger trg_op_api_clients_updated before update on op.api_clients for each row execute function sys.set_updated_at();

create table op.api_client_grants (
  id uuid primary key default gen_random_uuid(),
  api_client_id uuid not null references op.api_clients (id) on delete cascade,
  account_id uuid not null references op.accounts (id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index ux_op_api_client_grants on op.api_client_grants (api_client_id, account_id);

create table op.config_defaults (
  id uuid primary key default gen_random_uuid(),
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
create unique index ux_op_config_defaults_version on op.config_defaults (kind, scope_key, version);
create unique index ux_op_config_defaults_active on op.config_defaults (kind, scope_key) where status = 'active';
create trigger trg_op_config_defaults_updated before update on op.config_defaults for each row execute function sys.set_updated_at();

create table op.holiday_calendars (
  id uuid primary key default gen_random_uuid(),
  country text not null,
  name text not null,
  created_at timestamptz not null default now()
);
create unique index ux_op_holiday_calendars on op.holiday_calendars (country, lower(name));

create table op.holidays (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references op.holiday_calendars (id) on delete cascade,
  date date not null,
  label text not null
);
create unique index ux_op_holidays on op.holidays (calendar_id, date);

-- Operator-scoped audit (Accounts & Administration technical section 5):
-- same envelope as acct.audit_events, no RLS, append-only, monthly partitions.
create table op.audit_events (
  id uuid not null default gen_random_uuid(),
  entity_kind text not null,
  entity_id text not null,
  event_type text not null,
  field text,
  old_value jsonb,
  new_value jsonb,
  actor_kind text not null check (actor_kind in ('user', 'portal_user', 'api_client', 'system', 'ai')),
  actor_id text not null,
  actor_name text,
  correlation_id text,
  request_id text,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);
select sys.ensure_month_partitions('op.audit_events', date '2026-01-01', date '2028-12-01');
create index ix_op_audit_events_entity on op.audit_events (entity_kind, entity_id, created_at);
create index ix_op_audit_events_request on op.audit_events (request_id);
create trigger trg_op_audit_events_append_only before update or delete on op.audit_events
  for each row execute function sys.raise_append_only();

-- Explicit grants (default privileges cover xms_app and xms_worker; the
-- portal role receives nothing in op).
revoke all on all tables in schema op from xms_portal;
