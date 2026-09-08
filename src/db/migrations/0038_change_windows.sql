-- 0038 Ticket groups: projects and change windows (TM-10, TM-18; Ticket
-- Management technical 2.4, functional 5.9 and 5.13; Data Model 3.2).
--
-- A group is a named container with a schedule that a ticket tree belongs
-- to: one tree per Azure Files cutover weekend. The schedule is an explicit
-- start and end plus freeze windows, exactly as functional 5.9 words it, so
-- there is no recurrence column: a repeating window is repeated records.
--
-- Membership is the `ticket_group_id` column migration 0004 already put on
-- the ticket, which now gains its foreign key. The data model also names an
-- `acct.ticket_group_members` join table; it is not created, because a
-- ticket belongs to at most one group and two records of one fact can
-- disagree. The group's ticket list is a query on the column.

create table acct.ticket_groups (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  kind text not null check (kind in ('project', 'change_window')),
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '',
  owner_user_id text,
  -- Nullable so a project can exist before it is scheduled; a change window
  -- is refused without both ends by the service, which is where the rule
  -- can say why.
  starts_at timestamptz,
  ends_at timestamptz,
  -- [{ "starts_at": ..., "ends_at": ..., "reason": ... }]: spans during
  -- which nothing may be scheduled (TM-18).
  freeze_windows jsonb not null default '[]'::jsonb,
  status text not null default 'planned' check (status in ('planned', 'active', 'closed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ck_ticket_groups_span check (starts_at is null or ends_at is null or ends_at > starts_at),
  constraint ck_ticket_groups_freezes check (jsonb_typeof(freeze_windows) = 'array')
);
create index ix_acct_ticket_groups_account on acct.ticket_groups (account_id, kind, status, name);
-- The change calendar reads a date range across accounts.
create index ix_acct_ticket_groups_schedule on acct.ticket_groups (starts_at, ends_at)
  where kind = 'change_window' and status <> 'cancelled';
create trigger trg_acct_ticket_groups_updated before update on acct.ticket_groups
  for each row execute function sys.set_updated_at();
-- Moving a window moves work people have planned around, so every change to
-- one carries its audit row in the same transaction.
create constraint trigger trg_acct_ticket_groups_require_audit after update on acct.ticket_groups
  deferrable initially deferred for each row execute function sys.require_audit();
select sys.apply_account_isolation('acct.ticket_groups', false);

-- Restrict: a window with tickets in it is cancelled, never deleted out from
-- under the work that names it.
alter table acct.tickets
  add constraint fk_acct_tickets_ticket_group foreign key (ticket_group_id)
    references acct.ticket_groups (id) on delete restrict;
create index ix_acct_tickets_ticket_group on acct.tickets (ticket_group_id) where ticket_group_id is not null;

-- The deploying state of the change machine (TM-18). The gate that refuses
-- implementation outside the window reads `effects.deploy` off the machine
-- rather than a state key written into the service, so an account whose
-- machine names its states differently can say which of them is the one
-- that touches production. The seed carries the flag for new databases;
-- this updates the machines already stored.
update op.config_defaults
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
   and body->'states' @> '[{"key": "implementing"}]'::jsonb;

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
   and body->'states' @> '[{"key": "implementing"}]'::jsonb;
