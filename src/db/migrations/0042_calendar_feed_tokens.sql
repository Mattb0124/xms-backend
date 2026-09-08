-- 0042 Calendar feed tokens (INT-05; Integrations functional 5.6 and 5, and
-- the register's "push change windows and scheduled work to Outlook").
--
-- The specification's calendar integration is a Microsoft Graph push per
-- consenting user, which needs an application registration, a consent flow
-- and stored refresh tokens (`op.calendar_consents` in the integrations
-- technical spec, not created here). A subscribed ICS feed reaches the same
-- calendars with none of that: the person subscribes their own Outlook,
-- Google or Apple calendar to a URL, and XMS holds no credential of theirs.
--
-- One row per feed the person minted. The token itself is never stored: the
-- column is its SHA-256, exactly as the CSAT one-time link works, so a
-- database read gives nobody a working subscription. A revoked feed keeps
-- its row so the revocation is a fact with a time on it rather than a
-- missing record, and the partial unique index lets the same person mint a
-- fresh feed after revoking the old one.

create table op.calendar_feed_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references op.users (id) on delete cascade,
  -- sha256 hex of the secret in the URL; the secret exists only in the
  -- response that minted it and in the subscriber's calendar client.
  token_hash text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create unique index ux_op_calendar_feed_tokens_hash on op.calendar_feed_tokens (token_hash);
create index ix_op_calendar_feed_tokens_user on op.calendar_feed_tokens (user_id) where revoked_at is null;

-- The portal role receives nothing in op (migration 0002); repeated here
-- because a table added later does not inherit that revoke.
revoke all on op.calendar_feed_tokens from xms_portal;
