-- 0026 Security review hardening (REVIEW-security-2026-09-08 findings 29 and
-- 37): audit coverage on the commercial and integration tables the guard
-- missed, and least privilege for the worker in the operator schema.

-- ---------------------------------------------------------------------------
-- Finding 29: `sys.require_audit` was attached to six tables only, so an
-- update to a money row could commit with no audit event in its transaction.
-- Extended to the three that are mutable, commercial and always written
-- through an audited service path.
--
-- Deliberately not extended, and recorded as such:
--   acct.webhook_subscriptions  the delivery worker updates consecutive_failures
--                               on every attempt; that is bookkeeping, not an
--                               operator intent, and carries no audit event.
--   acct.comments               the migration importer backdates created_at on
--                               rows it has just created inside an import batch.
-- Both keep their append-only and isolation guards; only the audit constraint
-- is withheld.
-- ---------------------------------------------------------------------------
create constraint trigger trg_acct_billing_periods_require_audit after update on acct.billing_periods
  deferrable initially deferred for each row execute function sys.require_audit();

create constraint trigger trg_acct_rate_cards_require_audit after update on acct.rate_cards
  deferrable initially deferred for each row execute function sys.require_audit();

create constraint trigger trg_acct_finance_destinations_require_audit after update on acct.finance_destinations
  deferrable initially deferred for each row execute function sys.require_audit();

-- ---------------------------------------------------------------------------
-- Finding 37: 0001 gave xms_worker select, insert, update and delete on every
-- table in the operator schema, including op.users, op.roles,
-- op.role_assignments, op.account_grants and op.api_clients, none of which it
-- writes. A compromised worker could grant itself every account and every
-- permission. The worker reads the operator schema and writes exactly two
-- things: the certification notice stamp its expiry job sets, and the
-- operator audit stream.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on all tables in schema op from xms_worker;
alter default privileges in schema op revoke insert, update, delete on tables from xms_worker;

grant update on op.certifications to xms_worker;
grant insert on op.audit_events to xms_worker;
