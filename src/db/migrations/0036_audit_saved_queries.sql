-- 0036 Audit saved queries (Audit & Analytics 7.1: the audit search has
-- "saved queries" beside the condition builder, the record drawer and the
-- export; P2.11.5 cut). A saved query is a named condition set over
-- `rpt.events_v`, nothing more: it holds no rows and no account, so it
-- lives in the operator schema beside the other operator records rather
-- than in `acct`, and the isolation suite (which covers every `acct` and
-- `rpt` table carrying an account_id) correctly leaves it alone.
--
-- What a query may see is decided when it runs, by the grant clause the
-- search already applies to the searcher, never by the row: two readers
-- running the same shared query see their own accounts' events. That is
-- why the conditions can be shared without sharing anything else.
--
-- The conditions are stored as the array the search takes, validated by
-- `translateEvents` before every insert and update, so a saved query can
-- never hold a condition the search would refuse.

create table op.audit_saved_queries (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  -- The owner is a user, not an account: the audit search is operator scope.
  owner_user_id uuid not null references op.users (id) on delete cascade,
  -- A shared query is visible to every audit:read holder; a private one only
  -- to its owner. Sharing needs audit:export, enforced in the service.
  shared boolean not null default false,
  description text not null default '',
  conditions jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One name per owner: the list is picked from by name, and a duplicate
-- would leave the reader guessing which one they saved.
create unique index ux_op_audit_saved_queries_name on op.audit_saved_queries (owner_user_id, lower(name));
-- The list read is "mine plus the shared ones", ordered by name.
create index ix_op_audit_saved_queries_owner on op.audit_saved_queries (owner_user_id, name);
create index ix_op_audit_saved_queries_shared on op.audit_saved_queries (name) where shared;
create trigger trg_op_audit_saved_queries_updated before update on op.audit_saved_queries
  for each row execute function sys.set_updated_at();
