-- 0046 What a person costs, so an account's margin can be read.
--
-- TB-16 asks for profitability per account. Revenue is already computable:
-- the rate cards say what a role bills at on a date, and the time entries
-- say how many minutes of it were worked. The missing half is cost.
--
-- Cost belongs to the person, not to the account: the same consultant costs
-- the same whoever they are working for, and what they cost is our business
-- rather than the client's. That is why this lives in `op` with no account
-- isolation, and why it is answered to `finance:view-margin` rather than to
-- the `contracts:view` that opens the rate cards.
--
-- It is effective-dated for the same reason a rate card is. A margin for
-- last March computed at this March's cost is not a margin, it is a guess,
-- and this is money. The resolution rule is the rate card's: the latest row
-- whose effective_from is on or before the day worked.

create table op.person_cost_rates (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references op.people (id) on delete cascade,
  effective_from date not null,
  -- Per hour, in the currency the row names. Zero is a real answer: a
  -- subcontractor billed straight through costs the business nothing.
  cost_rate numeric(10, 2) not null check (cost_rate >= 0),
  currency char(3) not null default 'USD',
  note text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  -- One rate per person per day it takes effect; correcting a rate replaces
  -- the row for that date rather than adding a second one nobody can order.
  constraint ux_op_person_cost_rates_version unique (person_id, effective_from)
);

create index ix_op_person_cost_rates_lookup on op.person_cost_rates (person_id, effective_from desc);

comment on table op.person_cost_rates is 'What a person costs per hour from a date; operator-only, behind finance:view-margin.';
comment on column op.person_cost_rates.cost_rate is 'Per hour in this row''s currency; the rate in force is the latest on or before the day worked.';
