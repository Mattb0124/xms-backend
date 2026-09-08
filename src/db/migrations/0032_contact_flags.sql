-- 0032 Contact flags (Client Portal technical 2.1, functional 5.7): the
-- quarterly relationship survey goes to the account's portal admins and to
-- "any contacts flagged executive sponsor", so the contact needs the flag
-- set the specification already names. The vocabulary is closed: a typo
-- would silently drop someone from every future quarterly survey.

alter table acct.contacts
  add column flags text[] not null default '{}'
    check (flags <@ array['executive_sponsor', 'billing_contact', 'csat_recipient']::text[]);

-- The recipient sweep asks "which contacts of this account carry the flag",
-- so the index is on the array itself rather than on one value.
create index ix_acct_contacts_flags on acct.contacts using gin (flags);
