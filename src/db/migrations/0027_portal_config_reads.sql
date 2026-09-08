-- 0027 The portal reads the configuration it renders (REVIEW-frontend
-- 2026-09-08 finding 2). GET /v1/portal/tickets and most request detail
-- pages answered 404 for every portal role: the portal path builds a ticket
-- view through the account's state machine, which resolves through
-- `op.config_defaults` and `acct.config_overrides`, and 0002 revoked all of
-- the operator schema from xms_portal while 0003 marked the overrides not
-- portal readable. The detail page looked intermittent only because the
-- configuration cache is per process and shared: whichever ticket type an
-- internal request had already resolved answered, and the rest did not.
--
-- Granted here is exactly what the portal reads: the active catalog bodies.
-- Neither table carries client content; §4.4's list of what the portal must
-- never reach is work notes, time entries, rate cards and AI suggestions,
-- and none of them is touched.

-- The installer becomes re-runnable, so a table can change its portal
-- readability later without a migration hand-typing the policies. The
-- policy bodies are unchanged from 0003.
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
  execute format('drop policy if exists acct_isolation_operator on %I.%I', schema_name, table_name);
  execute format(
    'create policy acct_isolation_operator on %I.%I to xms_app, xms_worker
       using (account_id = any (sys.account_ids()))
       with check (account_id = any (sys.account_ids()))',
    schema_name, table_name);
  execute format('drop policy if exists acct_isolation_portal on %I.%I', schema_name, table_name);
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

-- The operator defaults are global rows with no account column, so a plain
-- select grant is the whole of it; the portal writes nothing.
grant select on op.config_defaults to xms_portal;

-- The per-account overrides are account scoped, so they go through the
-- installer rather than a hand-written grant: it adds the portal policy
-- bound to `xms.account_id` alongside the operator policy and grants select
-- only. The isolation suite then proves a portal connection bound to one
-- account sees that account's overrides and no other's.
select sys.apply_account_isolation('acct.config_overrides', true);
