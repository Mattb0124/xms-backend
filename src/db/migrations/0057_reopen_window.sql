-- 0057 Reopen window after Resolved (Email Intake functional 5.3).
--
-- A reply that matches a Resolved or Closed ticket reopens it while the
-- window is open, and becomes a new related ticket once the window has
-- elapsed. The length is an account setting in working days on the
-- account calendar. Zero means never reopen, including the resolve day.
-- A type may override the account on its state-machine body; Change is
-- seeded at zero so a completed change is not reopened by inbound mail.

alter table acct.account_settings
  add column reopen_window_business_days integer not null default 5
    check (reopen_window_business_days >= 0 and reopen_window_business_days <= 365);

comment on column acct.account_settings.reopen_window_business_days is
  'Working days after resolved_at (else closed_at) during which the ticket may reopen. Zero never reopens.';
