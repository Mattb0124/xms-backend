-- 0037 Assignment group routing defaults (TM-08; Accounts & Administration
-- functional 5.4 and 5.6: "a ticket type can name a default group",
-- "dispatch assigns to a group and optionally to a member").
--
-- The group catalog itself (op.assignment_groups, op.group_members) landed
-- with migration 0002 because it is operator-scoped: the same CSM, OneStream
-- Technical and Infrastructure teams work every account. What was missing is
-- the account's answer to "which group takes this kind of work", which is a
-- per-account override of an operator default and so is account-scoped with
-- forced RLS like everything else in `acct`.
--
-- A rule is (type, category) -> group. The category is nullable: null is the
-- rule for the type as a whole, and a rule naming a category wins over it.
-- The unique index treats null as the empty string so one account cannot
-- hold two rules for the same pair.

create table acct.group_routing_rules (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_type text not null check (ticket_type in ('incident', 'service_request', 'change', 'problem', 'project_task')),
  -- Null means "any category of this type"; a named category is the more
  -- specific rule and is chosen first.
  category text check (category is null or char_length(category) between 1 and 120),
  -- Restrict, not cascade: a group that routes work is retired, never
  -- deleted out from under the rule that names it.
  group_id uuid not null references op.assignment_groups (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create unique index ux_acct_group_routing_rules
  on acct.group_routing_rules (account_id, ticket_type, coalesce(category, ''));
create index ix_acct_group_routing_rules_group on acct.group_routing_rules (group_id);
create trigger trg_acct_group_routing_rules_updated before update on acct.group_routing_rules
  for each row execute function sys.set_updated_at();
select sys.apply_account_isolation('acct.group_routing_rules', false);
