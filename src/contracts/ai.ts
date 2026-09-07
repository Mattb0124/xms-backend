import { z } from 'zod';

/**
 * The AI contract shared by the adapter, the worker and the web client
 * (AI functionality technical 2.5, 2.7). Capability keys, withheld reasons,
 * decisions and the payload schema per capability live here so a proposal
 * that does not match its schema is a typed `schema_error` withhold, never
 * a stored blob the UI has to guess at.
 */
export const AI_CAPABILITIES = [
  'classify',
  'prioritise',
  'duplicate',
  'summarise',
  'draft_reply',
  'wsr_narrative',
  'time_entry',
  'burn_anomaly',
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export const AI_TARGET_KINDS = ['ticket', 'report_run', 'person_day', 'contract_period', 'queue_query'] as const;
export type AiTargetKind = (typeof AI_TARGET_KINDS)[number];

export const WITHHELD_REASONS = [
  'below_threshold',
  'switch_off',
  'capability_off',
  'residency',
  'redaction_refused',
  'unavailable',
  'no_content',
  'schema_error',
] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

export const AI_DECISIONS = ['accepted', 'edited_accepted', 'rejected', 'expired', 'auto_applied'] as const;
export type AiDecision = (typeof AI_DECISIONS)[number];

export const REJECT_REASONS = ['wrong', 'unnecessary', 'already_done', 'unclear', 'other'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** The capabilities served in the day-30 cut; the rest are catalogued and switched off. */
export const CUT_CAPABILITIES: readonly AiCapability[] = [
  'classify',
  'prioritise',
  'duplicate',
  'summarise',
  'draft_reply',
];

/** Prompt versions, one constant per capability, stored on every suggestion (AI Integration section 6). */
export const PROMPT_VERSIONS: Record<AiCapability, string> = {
  classify: 'classify/2026-09-07.1',
  prioritise: 'prioritise/2026-09-07.1',
  duplicate: 'duplicate/2026-09-07.1',
  summarise: 'summarise/2026-09-07.1',
  draft_reply: 'draft_reply/2026-09-07.1',
  wsr_narrative: 'wsr_narrative/unbuilt',
  time_entry: 'time_entry/unbuilt',
  burn_anomaly: 'burn_anomaly/unbuilt',
};

export interface CapabilitySetting {
  readonly enabled: boolean;
  /** Confidence below this is withheld (AI-09); 0 for free-text capabilities. */
  readonly threshold: number;
  readonly auto_apply: boolean;
  readonly auto_min: number;
  readonly expires_minutes: number;
}

/** The operator defaults (config kind `ai`). */
export interface AiDefaults {
  readonly kill_switch: boolean;
  readonly harness_regions: readonly string[];
  readonly agents: Record<AiCapability, string>;
  readonly capabilities: Record<AiCapability, CapabilitySetting>;
}

const level = z.enum(['high', 'medium', 'low']);
const confidence = z.number().min(0).max(1);

export const PAYLOAD_SCHEMAS = {
  classify: z.object({
    category: z.string().min(1).max(120),
    ticket_type: z.enum(['incident', 'service_request', 'change', 'problem', 'project_task']).optional(),
    ci_ids: z.array(z.string().uuid()).max(10).default([]),
    reasons: z.record(z.string(), z.string().max(500)).default({}),
    confidence,
    field_confidence: z.record(z.string(), confidence).optional(),
  }),
  prioritise: z.object({
    impact: level,
    urgency: level,
    priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
    reason: z.string().max(1000),
    confidence,
  }),
  duplicate: z.object({
    candidates: z
      .array(z.object({ ticket_id: z.string().uuid(), similarity: confidence, reason: z.string().max(500) }))
      .max(10),
    merge_into: z.string().uuid().nullable(),
    confidence,
  }),
  summarise: z.object({
    situation: z.string().max(4000),
    done: z.string().max(4000),
    waiting_on: z.string().max(2000),
    next_step: z.string().max(2000),
    risks: z.string().max(2000).default(''),
    sources: z
      .object({
        comments: z.number().int().min(0),
        work_notes: z.number().int().min(0),
        events: z.number().int().min(0),
      })
      .default({ comments: 0, work_notes: 0, events: 0 }),
  }),
  draft_reply: z.object({
    text: z.string().min(1).max(20000),
    citations: z
      .array(z.object({ article_version_id: z.string().uuid() }))
      .max(10)
      .default([]),
    tone: z.enum(['plain', 'formal']).default('plain'),
  }),
  wsr_narrative: z.object({
    sections: z.array(z.object({ key: z.string(), headline: z.string().max(300), text: z.string().max(6000) })),
  }),
  time_entry: z.object({
    entries: z.array(
      z.object({
        ticket_id: z.string().uuid(),
        minutes: z.number().int().positive(),
        activity_type: z.string(),
        description: z.string().max(1000),
        evidence: z.array(z.string()).default([]),
      }),
    ),
    confidence,
  }),
  burn_anomaly: z.object({
    direction: z.enum(['over', 'under']),
    magnitude_pct: z.number(),
    likely_cause: z.string().max(2000),
    evidence: z.array(z.string()).default([]),
    confidence,
  }),
} as const;

export type AiPayload<C extends AiCapability> = z.infer<(typeof PAYLOAD_SCHEMAS)[C]>;

export interface ParsedProposal {
  readonly payload: Record<string, unknown>;
  /** Null for free-text capabilities that carry no confidence. */
  readonly confidence: number | null;
}

/** Validates a proposal against its capability schema; `problems` is set on failure. */
export function parseProposal(
  capability: AiCapability,
  raw: unknown,
): { ok: true; value: ParsedProposal } | { ok: false; problems: string[] } {
  const result = PAYLOAD_SCHEMAS[capability].safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      problems: result.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
    };
  }
  const payload = result.data as Record<string, unknown>;
  const value = payload.confidence;
  return { ok: true, value: { payload, confidence: typeof value === 'number' ? value : null } };
}

/** The permission a decision on a capability requires (AI functionality technical section 4). */
export function decisionPermissionFor(
  capability: AiCapability,
): 'tickets:work' | 'time:log' | 'reports:manage' | 'ai:use' {
  switch (capability) {
    case 'classify':
    case 'prioritise':
    case 'duplicate':
      return 'tickets:work';
    case 'time_entry':
    case 'burn_anomaly':
      return 'time:log';
    case 'wsr_narrative':
      return 'reports:manage';
    default:
      return 'ai:use';
  }
}

export interface AiSettingsView {
  readonly account_id: string;
  readonly enabled: boolean;
  readonly dpa_reference: string | null;
  readonly residency_region: string;
  readonly redaction_profile: 'standard' | 'strict';
  readonly draft_tone: 'plain' | 'formal';
  readonly capabilities: Record<AiCapability, CapabilitySetting>;
  readonly auto_apply_approval_ref: string | null;
  readonly version: number;
  /** Why the switch cannot be, or is not, effective right now. */
  readonly effective: { on: boolean; reason?: 'switch_off' | 'residency' | 'kill_switch' };
}

/** Merges the operator defaults with an account's capability overrides. */
export function mergeCapabilities(
  defaults: AiDefaults,
  overrides: Partial<Record<string, Partial<CapabilitySetting>>>,
): Record<AiCapability, CapabilitySetting> {
  const result = {} as Record<AiCapability, CapabilitySetting>;
  for (const capability of AI_CAPABILITIES) {
    const base = defaults.capabilities[capability];
    const override = overrides[capability] ?? {};
    result[capability] = {
      enabled: override.enabled ?? base.enabled,
      threshold: override.threshold ?? base.threshold,
      auto_apply: override.auto_apply ?? base.auto_apply,
      auto_min: override.auto_min ?? base.auto_min,
      expires_minutes: override.expires_minutes ?? base.expires_minutes,
    };
  }
  return result;
}

export function validateAiDefaults(body: unknown): string[] {
  const problems: string[] = [];
  const value = body as Partial<AiDefaults> | null;
  if (!value || typeof value !== 'object') return ['body must be an object'];
  if (typeof value.kill_switch !== 'boolean') problems.push('kill_switch must be a boolean');
  if (!Array.isArray(value.harness_regions) || value.harness_regions.length === 0)
    problems.push('harness_regions must be a non-empty list');
  for (const capability of AI_CAPABILITIES) {
    const setting = value.capabilities?.[capability];
    if (!setting) {
      problems.push(`capabilities.${capability} missing`);
      continue;
    }
    if (typeof setting.enabled !== 'boolean') problems.push(`capabilities.${capability}.enabled must be a boolean`);
    if (typeof setting.threshold !== 'number' || setting.threshold < 0 || setting.threshold > 1)
      problems.push(`capabilities.${capability}.threshold must be between 0 and 1`);
    if (typeof setting.expires_minutes !== 'number' || setting.expires_minutes <= 0)
      problems.push(`capabilities.${capability}.expires_minutes must be positive`);
    if (!value.agents?.[capability]) problems.push(`agents.${capability} missing`);
  }
  return problems;
}
