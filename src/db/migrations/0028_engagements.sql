-- 0028 Engagements and renewal alerts (Time, Contracts & Budget technical
-- 2.1 and section 3; functional 5.6, INT-03). The engagement is the
-- commercial envelope a contract lives inside: it carries the renewal date,
-- the notice period and the owner who must act on them. Contracts gain a
-- nullable engagement_id so the existing rows stay valid and the link is
-- made deliberately, never inferred.
--
-- `renewal_alerts_fired` is the once-per-lead-time ledger the daily worker
-- job reads and writes, the same shape as `contract_periods.thresholds_fired`
-- for budget thresholds: the lead time in days, or 0 for the notice-period
-- boundary, which is a date of its own rather than a lead time.

create table acct.engagements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references op.accounts (id),
  name text not null check (char_length(name) between 1 and 160),
  owner_user_id text,
  renewal_date date,
  notice_period_days integer check (notice_period_days is null or notice_period_days between 0 and 365),
  status text not null default 'active' check (status in ('active', 'expiring', 'ended')),
  -- Lead times already notified for the current renewal_date; 0 is the
  -- notice-period boundary. Cleared when the renewal date moves.
  renewal_alerts_fired integer[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index ix_acct_engagements_account on acct.engagements (account_id, status, name);
create index ix_acct_engagements_renewal on acct.engagements (renewal_date) where renewal_date is not null and status <> 'ended';
create trigger trg_acct_engagements_updated before update on acct.engagements
  for each row execute function sys.set_updated_at();
-- The renewal job moves status and stamps the ledger, so it writes an audit
-- row in the same transaction like any operator would (finding 29 shape).
create constraint trigger trg_acct_engagements_require_audit after update on acct.engagements
  deferrable initially deferred for each row execute function sys.require_audit();
select sys.apply_account_isolation('acct.engagements', false);

-- Nullable: every contract that exists today has no engagement, and the
-- delete rule is restrict because an engagement with contracts under it is
-- ended, never removed.
alter table acct.contracts
  add column engagement_id uuid references acct.engagements (id) on delete restrict;
create index ix_acct_contracts_engagement on acct.contracts (engagement_id) where engagement_id is not null;
