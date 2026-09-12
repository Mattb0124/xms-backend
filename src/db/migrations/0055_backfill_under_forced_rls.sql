-- 0055 Make data migrations against account-scoped tables actually work.
--
-- Every `acct.*` table carries FORCE ROW LEVEL SECURITY (0003,
-- `sys.apply_account_isolation`) with policies naming `xms_app` and
-- `xms_worker` only. FORCE binds the table OWNER as well, and in RDS the
-- owner is `xms_migrator`, which does NOT hold BYPASSRLS (Matt, 2026-09-12,
-- and it should not: a role that can read every account's rows is what the
-- isolation model exists to prevent).
--
-- So a migration that writes to an `acct.*` table matches no policy and
-- updates ZERO ROWS WITH NO ERROR. Locally and in CI it looks fine, because
-- `docker/postgres/init/01-roles.sql` makes the local migrator a superuser
-- and the test harness migrates on the container's `postgres` connection.
-- The bug is invisible everywhere it is cheap to find and silent where it
-- costs something.
--
-- Three migrations were written without knowing this: 0038 (the `deploy`
-- effect on the change machine), 0052 (the report author backfill) and 0054
-- (the project-task gate and the `delivered` code). All three no-op against
-- account overrides on any database that already holds data.
--
-- On a database created from scratch the three are harmless, because the
-- tables they write to are empty when they run. The reason to fix it anyway
-- is that nothing about the failure announces itself, and the next data
-- migration will be written the same way unless the rule has somewhere to
-- live. So this migration does three things: it gives the rule a pair of
-- functions to call, it repeats the three affected statements through them,
-- and it refuses to finish if any table is left unforced.

-- ---------------------------------------------------------------------------
-- The pair every future data migration against acct.* should use
-- ---------------------------------------------------------------------------

create or replace function sys.begin_account_backfill(target regclass) returns void
language plpgsql as $$
begin
  execute format('alter table %s no force row level security', target::text);
end $$;
comment on function sys.begin_account_backfill(regclass) is
  'Lift FORCE RLS so the schema-owning migrator can write to an account-scoped table. Always paired with sys.end_account_backfill in the same migration.';

create or replace function sys.end_account_backfill(target regclass) returns void
language plpgsql as $$
begin
  execute format('alter table %s force row level security', target::text);
end $$;
comment on function sys.end_account_backfill(regclass) is
  'Put FORCE RLS back after a migrator backfill. Leaving a table unforced is worse than the bug the pair exists to fix.';

-- ---------------------------------------------------------------------------
-- Repeat what the three migrations meant to do
-- ---------------------------------------------------------------------------

do $$
declare
  moved integer;
begin
  perform sys.begin_account_backfill('acct.config_overrides');

  -- 0054: the project task gate. Appends rather than replaces, so an account
  -- that added a requirement of its own keeps it.
  update acct.config_overrides
     set body = jsonb_set(
       body,
       '{transitions}',
       (select jsonb_agg(
          case when transition->>'from' = 'in_progress' and transition->>'to' = 'done'
               then jsonb_set(transition, '{requires}',
                      coalesce(transition->'requires', '[]'::jsonb) || '["resolution"]'::jsonb)
               else transition
          end)
        from jsonb_array_elements(body->'transitions') as transition)
     )
   where kind = 'state_machine' and scope_key = 'project_task'
     and body->'transitions' @> '[{"from": "in_progress", "to": "done"}]'::jsonb
     and not body->'transitions' @> '[{"from": "in_progress", "to": "done", "requires": ["resolution"]}]'::jsonb;
  get diagnostics moved = row_count;
  raise notice '0055: project_task overrides given a resolution requirement: %', moved;

  -- 0054: the delivered code.
  update acct.config_overrides
     set body = jsonb_set(
       body,
       '{items}',
       (body->'items') || '[{"key": "delivered", "label": "Delivered as specified", "no_solution": false}]'::jsonb
     )
   where kind = 'resolution_codes'
     and not body->'items' @> '[{"key": "delivered"}]'::jsonb;
  get diagnostics moved = row_count;
  raise notice '0055: resolution-code overrides given the delivered code: %', moved;

  -- 0038: the deploying state of the change machine. The gate reads
  -- `effects.deploy` off the machine, so an override without it has no state
  -- that counts as touching production.
  update acct.config_overrides
     set body = jsonb_set(
       body,
       '{states}',
       (select jsonb_agg(
          case when state->>'key' = 'implementing'
               then jsonb_set(state, '{effects}', coalesce(state->'effects', '{}'::jsonb) || '{"deploy": true}'::jsonb)
               else state
          end)
        from jsonb_array_elements(body->'states') as state)
     )
   where kind = 'state_machine' and scope_key = 'change'
     and body->'states' @> '[{"key": "implementing"}]'::jsonb
     and not body->'states' @> '[{"key": "implementing", "effects": {"deploy": true}}]'::jsonb;
  get diagnostics moved = row_count;
  raise notice '0055: change overrides given the deploying state: %', moved;

  perform sys.end_account_backfill('acct.config_overrides');

  -- 0052: the report author backfill.
  perform sys.begin_account_backfill('acct.report_runs');
  update acct.report_runs r
     set author_user_id = a.owner_user_id::text
    from op.accounts a
   where a.id = r.account_id and a.owner_user_id is not null and r.author_user_id is null;
  get diagnostics moved = row_count;
  raise notice '0055: report runs given their author: %', moved;
  perform sys.end_account_backfill('acct.report_runs');
end $$;

-- Asserted rather than assumed: leaving an account-scoped table unforced is
-- the one outcome of this migration worse than the bug it repairs.
do $$
declare
  unforced text;
begin
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ')
    into unforced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'acct' and c.relkind = 'r'
     and c.relrowsecurity and not c.relforcerowsecurity;
  if unforced is not null then
    raise exception 'row level security left unforced on %', unforced;
  end if;
end $$;
