-- 0051 Container-case detection (TM-27).
--
-- A container case is a ticket that has quietly become a project. Nobody
-- decided it; it accrued. It keeps taking time entries, it stays open for
-- weeks, the effort on it passes what anybody would call an incident, and
-- because it is one ticket it never appears in any conversation about what
-- the client is entitled to.
--
-- TM-11 already has the mechanism for that conversation: the out-of-scope
-- flag, raised by a person, decided by a contract manager. TM-27 is not a
-- second mechanism, it is a second way of raising the first one. The sweep
-- flags the ticket exactly as a consultant would, with a reason naming the
-- threshold it crossed, and the account owner (TM-23) is told, because the
-- owner is who answers for what the client is getting.
--
-- Three thresholds, each per account and each independently switchable.
-- Null means the account does not use that threshold; that is why they are
-- nullable rather than zero-defaulted, since zero would mean "flag
-- everything" and an account that has not thought about it should have
-- nothing happen.
--
-- `container_detected_at` is the latch. Without it, a consultant who
-- withdraws the flag (the ticket returns to `out_of_scope = 'none'`) would
-- find the sweep raising it again five minutes later, which is the system
-- arguing with a person who has already answered the question. Detected
-- once, and never again on that ticket.

alter table acct.account_settings
  add column container_time_entries integer check (container_time_entries is null or container_time_entries > 0),
  add column container_elapsed_days integer check (container_elapsed_days is null or container_elapsed_days > 0),
  add column container_effort_minutes integer check (container_effort_minutes is null or container_effort_minutes > 0);

comment on column acct.account_settings.container_time_entries is
  'TM-27: flag a ticket carrying at least this many time entries. Null switches the threshold off.';
comment on column acct.account_settings.container_elapsed_days is
  'TM-27: flag a ticket open at least this many days. Null switches the threshold off.';
comment on column acct.account_settings.container_effort_minutes is
  'TM-27: flag a ticket carrying at least this much logged effort. Null switches the threshold off.';

alter table acct.tickets
  add column container_detected_at timestamptz;

comment on column acct.tickets.container_detected_at is
  'TM-27: when the sweep judged this ticket a container case. Set once, so withdrawing the flag does not invite it back.';

-- The sweep reads open, undetected tickets; the partial index is the whole
-- working set and stays small because detection is one-way.
create index ix_acct_tickets_container_candidates
  on acct.tickets (account_id, created_at)
  where container_detected_at is null;
