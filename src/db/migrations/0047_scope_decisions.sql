-- 0047 The record of a scope decision, which nobody can edit afterwards.
--
-- TM-11 shipped the flag, the decision and the allowance, and kept all three
-- on the ticket row: `out_of_scope` for the state and `out_of_scope_detail`
-- for everything anybody said. That is fine for "what is true now" and no use
-- at all for "what was decided, by whom, and when", because raising a second
-- flag overwrites the first and an UPDATE can rewrite any of it.
--
-- Revision 3 asks for the decision to be immutable, visible to the client and
-- exportable. This is that record: one row per thing that happened, append
-- only, and the ticket columns keep their job of saying where the flag stands
-- right now.
--
-- Client-visible is a property of the row rather than of the reader. A flag
-- is an internal opinion until somebody with the authority decides it, so the
-- flag is written invisible and the decision is written visible: the client
-- sees what was agreed, not the argument that got there.

create table acct.scope_decisions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  ticket_id uuid not null references acct.tickets (id) on delete restrict,
  -- What happened, in the same vocabulary the ticket column uses, plus the
  -- withdrawal the column cannot express because it returns to 'none'.
  event text not null check (event in ('flagged', 'withdrawn', 'approved', 'declined')),
  -- Why it was raised, carried on every later row so a single row is a whole
  -- story and an export needs no join to read.
  reason text not null default '',
  -- What the decider said, where they said anything.
  note text,
  allowance_minutes integer not null default 0 check (allowance_minutes >= 0),
  contract_period_id uuid references acct.contract_periods (id),
  actor_id text not null,
  actor_name text not null default '',
  client_visible boolean not null default false,
  at timestamptz not null default now()
);

create index ix_acct_scope_decisions_ticket on acct.scope_decisions (ticket_id, at);
create index ix_acct_scope_decisions_account on acct.scope_decisions (account_id, at desc);

-- The whole point: written once, never changed, never deleted.
create trigger trg_acct_scope_decisions_append_only before update or delete on acct.scope_decisions
  for each row execute function sys.raise_append_only();

select sys.apply_account_isolation('acct.scope_decisions', true);

comment on table acct.scope_decisions is 'Append-only record of every out-of-scope flag, withdrawal and decision (TM-11).';
comment on column acct.scope_decisions.client_visible is 'A flag is internal; a decision is what the client is shown.';
