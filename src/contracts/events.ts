/**
 * The event catalog (Audit & Analytics section 4). One typed union per
 * stream; an unknown event type is a build error, and the same lists feed
 * the Admin filter vocabulary and the telemetry validation.
 */
export const SECURITY_EVENT_TYPES = [
  // Authentication
  'auth.signin.success',
  'auth.signin.failed',
  'auth.signout',
  'auth.token.rejected',
  'auth.mfa.challenged',
  'auth.mfa.failed',
  'auth.session.exchanged',
  'auth.apikey.used',
  'auth.apikey.rejected',
  'auth.invite.sent',
  'auth.invite.accepted',
  'auth.bootstrap.completed',
  // Authorisation
  'authz.permission.denied',
  'authz.realm.denied',
  'authz.account.denied',
  'authz.isolation.filtered',
  'authz.record_rule.denied',
  // Administration
  'admin.user.created',
  'admin.user.role_changed',
  'admin.user.grants_changed',
  'admin.user.deactivated',
  'admin.user.pseudonymised',
  'admin.role.changed',
  'admin.group.changed',
  'admin.config.changed',
  'admin.account.created',
  'admin.account.status_changed',
  'admin.account.settings_changed',
  'admin.account.ai_switch_changed',
  'admin.account.isolation_tier_changed',
  'admin.connector.mode_changed',
  'admin.connector.kill_switch',
  'admin.map.activated',
  'admin.alias.disabled',
  'admin.offboarding.step',
  'admin.apikey.created',
  'admin.apikey.revoked',
  // Data movement
  'data.export.produced',
  'data.attachment.downloaded',
  'data.attachment.quarantined',
  'data.report_pack.sent',
  'data.billing_export.delivered',
  'data.import.batch_loaded',
  'data.webhook.delivered',
  // Abuse and integrity
  'abuse.rate_limited',
  'abuse.webhook.bad_signature',
  'abuse.email.loop_suspected',
  'abuse.upload.rejected',
  'abuse.csp_violation',
  'integrity.digest.written',
  'integrity.digest.mismatch',
  // AI
  'ai.turn.started',
  'ai.turn.failed',
  'ai.suggestion.withheld',
  'ai.egress.redacted',
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export const USAGE_EVENT_TYPES = [
  'screen.view',
  'screen.leave',
  'action.completed',
  'action.abandoned',
  'search.run',
  'axel.suggestion.shown',
  'axel.suggestion.decided',
  'axel.panel.opened',
  'axel.turn.completed',
  'api.request',
  'ui.error.shown',
] as const;

export type UsageEventType = (typeof USAGE_EVENT_TYPES)[number];

/** Domain audit event types registered so far; every module adds its own here. */
export const AUDIT_EVENT_TYPES = [
  'created',
  'updated',
  'deleted',
  'ticket.created',
  'ticket.updated',
  'ticket.transition',
  'ticket.assigned',
  'ticket.priority_overridden',
  'comment.created',
  'work_note.created',
  'attachment.created',
  'attachment.deleted',
  'sla.paused',
  'sla.resumed',
  'sla.breached',
  'sla.met',
  'admin.account.created',
  'admin.account.updated',
  'admin.account.status_changed',
  'admin.account.settings_changed',
  'admin.calendar.updated',
  'admin.config.activated',
  'admin.config.override_removed',
  'time.logged',
  'time.adjusted',
  'article.published',
  'article.retired',
  'attachment.quarantined',
  'ai.settings.changed',
  'ai.suggestion.offered',
  'ai.suggestion.applied',
  'ai.suggestion.rejected',
  'ai.suggestion.expired',
  'connector.created',
  'connector.updated',
  'connector.mode_changed',
  'connector.kill_switch',
  'connector.map.activated',
  'connector.watermark_rewound',
  'connector.dead_letter.replayed',
  'connector.dead_letter.discarded',
  'sync.applied',
  'budget.threshold_crossed',
  'roster.person.created',
  'roster.person.updated',
  'roster.person.imported',
  'roster.calendar.updated',
  'roster.skills.updated',
  'roster.certification.added',
  'roster.certification.removed',
  'capacity.pto.added',
  'capacity.pto.removed',
  'capacity.allocations.updated',
  'imported',
  'migration.batch.created',
  'migration.batch.run',
  'migration.report.explained',
  'migration.report.signed',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type ActorKind = 'user' | 'portal_user' | 'api_client' | 'system' | 'ai' | 'sync' | 'anonymous';
export type PrincipalKind = 'internal' | 'portal' | 'api_client' | 'harness';
export type Outcome = 'success' | 'denied' | 'failed' | 'withheld';

export function isSecurityEventType(value: string): value is SecurityEventType {
  return (SECURITY_EVENT_TYPES as readonly string[]).includes(value);
}

export function isUsageEventType(value: string): value is UsageEventType {
  return (USAGE_EVENT_TYPES as readonly string[]).includes(value);
}
