-- 0058 Portal may read the reopen window length on its own account.
--
-- GET /v1/portal/tickets/:key/transitions has to hide Reopen once the
-- window has elapsed. That length lives on acct.account_settings, which
-- 0003 revoked from xms_portal so AI, aliases and retention never reach
-- a client. Column-level SELECT plus a portal isolation policy lets the
-- route read only those two columns; `select *` still fails.

create policy acct_isolation_portal on acct.account_settings
  for select to xms_portal
  using (account_id = sys.account_id());

grant select (account_id, reopen_window_business_days) on acct.account_settings to xms_portal;
