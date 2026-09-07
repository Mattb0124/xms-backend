-- 0015 After-hours class on time entries (Time, Contracts & Budget TB-13;
-- Calendars P3.26.1 remainder). The class is derived from the account
-- calendar when the entry is logged and frozen on the row; the contract
-- says how the class is handled (premium rate multiplier or comp time).

alter table acct.contracts
  add column after_hours_handling text not null default 'none'
    check (after_hours_handling in ('premium_rate', 'comp_time', 'none')),
  add column after_hours_multiplier numeric(5,3)
    check (after_hours_multiplier is null or after_hours_multiplier >= 1);

alter table acct.time_entries
  add column performed_start time,
  add column after_hours_class text not null default 'standard'
    check (after_hours_class in ('standard', 'after_hours', 'weekend', 'holiday')),
  add column rate_multiplier numeric(5,3) not null default 1.000 check (rate_multiplier >= 1);

-- Rows flagged by hand before the class existed keep their meaning.
alter table acct.time_entries disable trigger trg_acct_time_entries_append_only;
update acct.time_entries set after_hours_class = 'after_hours' where after_hours and after_hours_class = 'standard';
alter table acct.time_entries enable trigger trg_acct_time_entries_append_only;

create index ix_acct_time_entries_after_hours on acct.time_entries (account_id, performed_on)
  where after_hours_class <> 'standard';
