-- 0033 The operator audit stream in the unified events view (Audit &
-- Analytics 2, 7.1; XA-03). `rpt.events_v` carried three of the four
-- tables the audit search is meant to answer from: the account audit, the
-- security stream and the usage stream. Everything an administrator does
-- to a user, a role, a group or a configuration catalog is written to
-- `op.audit_events` instead, because those entities have no account, and
-- that half was invisible to the search.
--
-- The operator rows join the same `audit` stream rather than a fourth one:
-- the stream says what kind of record it is, and `account_id` (null here)
-- already says the change was portfolio-wide. A new stream value would
-- have to be taught to every filter, the export and the digest.

create or replace view rpt.events_v with (security_invoker = true) as
  select e.id, 'audit'::text as stream, e.created_at as occurred_at, e.event_type, e.account_id,
         e.actor_kind, e.actor_id, e.actor_name, null::text as principal_kind, null::text as session_id, e.request_id, e.correlation_id,
         e.entity_kind, e.entity_id, 'success'::text as outcome,
         jsonb_build_object('field', e.field, 'old_value', e.old_value, 'new_value', e.new_value, 'ticket_id', e.ticket_id) as attrs
    from acct.audit_events e
  union all
  select o.id, 'audit', o.created_at, o.event_type, null::uuid,
         o.actor_kind, o.actor_id, o.actor_name, null::text, null::text, o.request_id, o.correlation_id,
         o.entity_kind, o.entity_id, 'success'::text,
         jsonb_build_object('field', o.field, 'old_value', o.old_value, 'new_value', o.new_value, 'scope', 'operator')
    from op.audit_events o
  union all
  select s.id, 'security', s.occurred_at, s.event_type, s.account_id,
         s.actor_kind, s.actor_id, s.actor_name, s.principal_kind, s.session_id, s.request_id, s.correlation_id,
         s.entity_kind, s.entity_id, s.outcome, s.attrs
    from sys.security_events s
  union all
  select u.id, 'usage', u.occurred_at, u.event_type, u.account_id,
         u.actor_kind, u.actor_id, null::text, u.principal_kind, u.session_id, u.request_id, null::text,
         u.entity_kind, u.entity_id, u.outcome, u.attrs
    from rpt.usage_events u;
grant select on rpt.events_v to xms_app, xms_worker;
revoke all on rpt.events_v from xms_portal;
