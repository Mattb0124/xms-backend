-- 0001 Foundation: extensions, the four schemas, the four roles, shared
-- functions and grants (Data Model sections 1, 2, 5).
--
-- Roles: in AWS and in docker compose the login roles already exist; here
-- they are created NOLOGIN only when missing so grants can be written in
-- every environment (the test harness creates login roles before migrating).

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_trgm;
create extension if not exists btree_gist;
create extension if not exists vector;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'xms_app') then create role xms_app nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'xms_worker') then create role xms_worker nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'xms_portal') then create role xms_portal nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'xms_migrator') then create role xms_migrator nologin; end if;
end $$;

create schema if not exists op;
create schema if not exists acct;
create schema if not exists sys;
create schema if not exists rpt;

grant usage on schema op, acct, sys, rpt to xms_app, xms_worker;
grant usage on schema acct, rpt to xms_portal;
-- The portal role may read a whitelist of operator rows through views only
-- (created by the modules that need them); it gets schema usage for that.
grant usage on schema op to xms_portal;

-- Default privileges for tables created by later migrations. The portal
-- role receives nothing by default: every grant to it is explicit in the
-- migration that creates the table (security definition of done).
alter default privileges in schema op grant select, insert, update, delete on tables to xms_app, xms_worker;
alter default privileges in schema acct grant select, insert, update, delete on tables to xms_app, xms_worker;
alter default privileges in schema sys grant select, insert, update, delete on tables to xms_worker;
alter default privileges in schema sys grant select, insert on tables to xms_app;
alter default privileges in schema rpt grant select, insert, update, delete on tables to xms_worker;
alter default privileges in schema rpt grant select, insert on tables to xms_app;
alter default privileges in schema op, acct, sys, rpt grant usage, select on sequences to xms_app, xms_worker;
alter default privileges in schema acct grant usage, select on sequences to xms_portal;

-- Session binding helpers. `current_setting(..., true)` returns NULL (not an
-- error) when the variable is unset, so a connection that skipped the
-- repository base sees no rows instead of failing loudly; both are safe, and
-- the isolation suite asserts the former.
create or replace function sys.account_ids() returns uuid[]
language sql stable parallel safe as $$
  select coalesce(nullif(current_setting('xms.account_ids', true), '')::uuid[], '{}'::uuid[])
$$;

create or replace function sys.account_id() returns uuid
language sql stable parallel safe as $$
  select nullif(current_setting('xms.account_id', true), '')::uuid
$$;

-- Append-only guard (Data Model section 1): applied to audit, security and
-- usage events, time entries, adjustments, pauses, inbound messages,
-- snapshots, suggestions, outbox, inbox and import records.
create or replace function sys.raise_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'table %.% is append-only (% not allowed)', tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;

-- updated_at maintenance for mutable rows.
create or replace function sys.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Monthly partition helper for the event streams. Creates the partition for
-- every month between the two dates (inclusive) if it does not exist. The
-- worker calls it monthly for the next quarter; migrations call it for the
-- first three years.
create or replace function sys.ensure_month_partitions(parent regclass, from_date date, to_date date) returns int
language plpgsql as $$
declare
  month_start date := date_trunc('month', from_date)::date;
  created int := 0;
  part_name text;
  schema_name text;
  table_name text;
begin
  select n.nspname, c.relname into schema_name, table_name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = parent;
  while month_start <= to_date loop
    part_name := format('%s_%s', table_name, to_char(month_start, 'YYYYMM'));
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = schema_name and c.relname = part_name
    ) then
      execute format('create table %I.%I partition of %I.%I for values from (%L) to (%L)',
        schema_name, part_name, schema_name, table_name, month_start, (month_start + interval '1 month')::date);
      created := created + 1;
    end if;
    month_start := (month_start + interval '1 month')::date;
  end loop;
  return created;
end $$;

-- Metadata of the last isolation-suite run (Test Strategy section 3).
create table sys.schema_checks (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  tables_checked int not null,
  tables_failed int not null,
  detail jsonb not null default '{}'::jsonb
);
