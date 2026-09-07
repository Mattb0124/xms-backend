-- 0019 Technologies on contracts (Time, Contracts & Budget technical 2.2
-- `technology_codes`; Capacity & Allocation CAP-07): the skills matrix's
-- account lens reads the technologies an account's active contracts
-- require from here. Codes reference op.skills.code by value so a contract
-- can name a technology before the skill row exists.

alter table acct.contracts
  add column technology_codes text[] not null default '{}';
