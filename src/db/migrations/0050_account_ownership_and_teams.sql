-- 0050 One named owner per account, and the team construct (TM-23).
--
-- Three of the four halves of TM-23 land here. The fourth, ownership
-- driving default routing, waits on C-01: until the TM-08 question is
-- answered, "drives routing" has no agreed meaning and nothing is built
-- against a guess.
--
-- What was here before: `op.accounts.owner_user_id` as a nullable `text`
-- column with no foreign key, settable through the generic account PATCH.
-- Three things were wrong with that. The value was a user id in a column
-- the database did not know was a user id, so a deleted or mistyped person
-- stayed on the account. An account could be activated with no owner at
-- all, which is what "every account has exactly one named primary owner"
-- forbids. And the change rode the generic diff, so handing an account to
-- somebody else looked the same in the audit stream as editing its time
-- zone.
--
-- The column becomes `uuid references op.users`, and the check constraint
-- says an account past onboarding has an owner. Onboarding is exempt on
-- purpose: the wizard collects the first owner grant part-way through, and
-- an account being built is not yet an account anybody owns. `system` is
-- exempt because the GLOBAL knowledge account (0007) is not a client and
-- has no CSM. Activation is where the constraint bites, and the service
-- refuses the transition with a typed 409 before the constraint has to.
--
-- Teams are operator scope, beside `op.assignment_groups`: they carry no
-- account_id because grouping accounts is the point, so a team row belongs
-- to several accounts or none, and the isolation suite (which covers tables
-- carrying an account_id) correctly leaves them alone. The portal role gets
-- no grant, by the default privileges in 0001.
--
-- A team is deliberately not an assignment group. A group is a bag of
-- people you can assign a ticket to. A team is the unit that owns a book of
-- business: people and the accounts they are responsible for, which is the
-- thing an account owner belongs to and reports up through. Folding them
-- together would mean every skills directory entry implied a commercial
-- responsibility.

-- ---------------------------------------------------------------------------
-- The owner column, given a type and a constraint
-- ---------------------------------------------------------------------------

-- Existing values are user ids written as text (the seed casts `id::text`).
-- `nullif` keeps an empty string, which the text column allowed, from
-- failing the cast; it becomes the null it always meant.
alter table op.accounts
  alter column owner_user_id type uuid using nullif(owner_user_id, '')::uuid;

alter table op.accounts
  add constraint fk_op_accounts_owner foreign key (owner_user_id) references op.users (id);

-- Past onboarding, an account has an owner. Exactly one is structural: the
-- column holds a single value.
alter table op.accounts
  add constraint ck_op_accounts_owner_when_live
  check (status in ('onboarding', 'system') or owner_user_id is not null);

create index ix_op_accounts_owner on op.accounts (owner_user_id) where owner_user_id is not null;

comment on column op.accounts.owner_user_id is
  'The one named primary owner of the account (TM-23). Required past onboarding; changed only through the owner route, which audits it.';

-- ---------------------------------------------------------------------------
-- Teams: people and the accounts they are responsible for
-- ---------------------------------------------------------------------------

create table op.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  -- The person who runs the team. Nullable: a team can be stood up before
  -- its lead is decided, and a lead who leaves should not take the team
  -- with them.
  lead_user_id uuid references op.users (id),
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
-- One team per name, the way assignment groups are named (0002).
create unique index ux_op_teams_name on op.teams (lower(name));
create index ix_op_teams_status on op.teams (status, name);
create trigger trg_op_teams_updated before update on op.teams
  for each row execute function sys.set_updated_at();

create table op.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references op.teams (id) on delete cascade,
  user_id uuid not null references op.users (id) on delete cascade,
  added_by text not null,
  created_at timestamptz not null default now()
);
create unique index ux_op_team_members on op.team_members (team_id, user_id);
create index ix_op_team_members_user on op.team_members (user_id);

create table op.team_accounts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references op.teams (id) on delete cascade,
  account_id uuid not null references op.accounts (id) on delete cascade,
  added_by text not null,
  created_at timestamptz not null default now()
);
-- An account belongs to at most one team: "which team looks after this
-- client" has to have one answer, or the book of business does not add up.
-- A person may be on several teams, which is why the member index is not
-- unique on user_id.
create unique index ux_op_team_accounts_account on op.team_accounts (account_id);
create index ix_op_team_accounts_team on op.team_accounts (team_id);

comment on table op.teams is 'A team groups people and the accounts they are responsible for (TM-23). Not an assignment group: a group is a bag of people to assign work to.';
comment on table op.team_accounts is 'The book of business of a team. An account belongs to at most one team.';
