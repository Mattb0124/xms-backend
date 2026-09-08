-- 0039 Non-ticket time (TB-12; Time, Contracts & Budget technical 2.7,
-- functional 5.3 and 5.8). The bucket table has existed since migration
-- 0006 with a key, a label and a billable class; what technical 2.7 also
-- names is a `code` on a closed vocabulary and the contract the bucket's
-- time belongs to.
--
-- The code is the taxonomy the workbook lists (governance, QBR preparation,
-- account management, escalation handling) plus `custom` for the buckets an
-- operator adds per account, so reporting can group the same kind of work
-- across accounts whatever a client's own bucket is called. Existing rows
-- take the code their key already says where it matches, and `custom`
-- otherwise.
--
-- `contract_id` is nullable: a bucket that names one logs its time against
-- that contract; a bucket that does not falls back to the account's single
-- active contract, which is what the service did for every bucket before.

alter table acct.non_ticket_buckets
  add column code text not null default 'custom'
    check (code in ('governance', 'qbr_prep', 'account_mgmt', 'escalation', 'custom')),
  add column contract_id uuid references acct.contracts (id) on delete restrict;

update acct.non_ticket_buckets set code = case
    when key in ('governance', 'qbr_prep', 'account_mgmt', 'escalation') then key
    when key in ('qbr', 'qbr_preparation') then 'qbr_prep'
    when key in ('account_management', 'account_mgt') then 'account_mgmt'
    when key in ('escalation_handling', 'escalations') then 'escalation'
    else 'custom'
  end;

create index ix_acct_non_ticket_buckets_contract on acct.non_ticket_buckets (contract_id)
  where contract_id is not null;
