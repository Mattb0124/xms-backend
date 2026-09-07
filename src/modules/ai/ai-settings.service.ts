import { BadRequestException, Injectable } from '@nestjs/common';
import type { RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService, type AuditEntry } from '../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import {
  AI_CAPABILITIES,
  mergeCapabilities,
  type AiCapability,
  type AiDefaults,
  type AiSettingsView,
  type CapabilitySetting,
} from '../../contracts/ai.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { ConfigService } from '../admin/config/config.service.js';
import { AiRepository, type AiSettingsRow } from './ai.repository.js';

export interface AiSettingsInput {
  enabled?: boolean;
  dpa_reference?: string | null;
  residency_region?: string;
  redaction_profile?: 'standard' | 'strict';
  draft_tone?: 'plain' | 'formal';
  capabilities?: Record<string, Partial<CapabilitySetting>>;
  auto_apply_approval_ref?: string | null;
  version?: number;
}

/** The switch as it applies right now, with the reason when it does not. */
export interface EffectiveSwitch {
  readonly on: boolean;
  readonly reason?: 'switch_off' | 'residency' | 'kill_switch';
  readonly settings?: AiSettingsRow;
  readonly defaults: AiDefaults;
  readonly capabilities: Record<AiCapability, CapabilitySetting>;
}

/**
 * The per-account AI switch and capability settings (AI-11, AI-12; AI
 * functionality technical 2.1, 2.7). Enabling needs a DPA reference and a
 * residency the harness serves; auto-apply needs an approval reference;
 * flipping the switch is audited and raises a security event; disabling
 * cascades in the database (open suggestions expire).
 */
@Injectable()
export class AiSettingsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: AiRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
  ) {}

  defaults(tx: Tx): Promise<AiDefaults> {
    return this.config.resolve<AiDefaults>(tx, 'ai', '*').then((resolved) => resolved.body);
  }

  async effective(tx: Tx, accountId: string): Promise<EffectiveSwitch> {
    const defaults = await this.defaults(tx);
    const settings = await this.repo.settings(tx, accountId);
    const capabilities = mergeCapabilities(
      defaults,
      (settings?.capabilities ?? {}) as Record<string, Partial<CapabilitySetting>>,
    );
    if (defaults.kill_switch) return { on: false, reason: 'kill_switch', settings, defaults, capabilities };
    if (!settings?.enabled) return { on: false, reason: 'switch_off', settings, defaults, capabilities };
    if (!defaults.harness_regions.includes(settings.residency_region))
      return { on: false, reason: 'residency', settings, defaults, capabilities };
    return { on: true, settings, defaults, capabilities };
  }

  get(principal: Principal, accountId: string): Promise<AiSettingsView> {
    return this.uow.run(principal, (tx) => this.view(tx, accountId));
  }

  async update(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    input: AiSettingsInput,
  ): Promise<AiSettingsView> {
    return this.uow.run(principal, async (tx) => {
      const defaults = await this.defaults(tx);
      const before = await this.repo.settings(tx, accountId);
      const next = {
        enabled: input.enabled ?? before?.enabled ?? false,
        dpa_reference: input.dpa_reference === undefined ? (before?.dpa_reference ?? null) : input.dpa_reference,
        residency_region: input.residency_region ?? before?.residency_region ?? 'us',
        redaction_profile: input.redaction_profile ?? before?.redaction_profile ?? 'standard',
        draft_tone: input.draft_tone ?? before?.draft_tone ?? 'plain',
        capabilities: input.capabilities ?? (before?.capabilities as Record<string, Partial<CapabilitySetting>>) ?? {},
        auto_apply_approval_ref:
          input.auto_apply_approval_ref === undefined
            ? (before?.auto_apply_approval_ref ?? null)
            : input.auto_apply_approval_ref,
      };
      this.validate(next, defaults);
      const after = before
        ? await this.repo.updateSettings(tx, before.id, input.version ?? before.version, next)
        : await this.repo.insertSettings(tx, accountId, next as Partial<AiSettingsRow>);
      const changed: AuditEntry[] = (
        [
          'enabled',
          'dpa_reference',
          'residency_region',
          'redaction_profile',
          'draft_tone',
          'auto_apply_approval_ref',
        ] as const
      )
        .filter((field) => (before?.[field] ?? null) !== (after[field] ?? null))
        .map((field) => ({
          entityKind: 'ai_settings',
          entityId: after.id,
          eventType: 'ai.settings.changed' as const,
          field,
          oldValue: before?.[field] ?? null,
          newValue: after[field] ?? null,
        }));
      if (JSON.stringify(before?.capabilities ?? {}) !== JSON.stringify(after.capabilities)) {
        changed.push({
          entityKind: 'ai_settings',
          entityId: after.id,
          eventType: 'ai.settings.changed',
          field: 'capabilities',
          oldValue: before?.capabilities ?? {},
          newValue: after.capabilities,
        });
      }
      // The audit guard requires an event on every update; a no-op write still records the intent.
      await this.audit.account(
        tx,
        accountId,
        actorOf(principal),
        ctx,
        changed.length > 0
          ? changed
          : [{ entityKind: 'ai_settings', entityId: after.id, eventType: 'ai.settings.changed', field: 'touched' }],
      );
      if ((before?.enabled ?? false) !== after.enabled) {
        await this.security.write(
          {
            type: 'admin.account.ai_switch_changed',
            outcome: 'success',
            accountId,
            actorKind: 'user',
            actorId: principal.userId,
            actorName: principal.displayName,
            principalKind: principal.kind,
            requestId: ctx.requestId,
            entityKind: 'account',
            entityId: accountId,
            attrs: { enabled: after.enabled, dpa_reference: after.dpa_reference, residency: after.residency_region },
          },
          tx,
        );
      }
      return this.view(tx, accountId);
    });
  }

  private validate(next: Omit<Required<AiSettingsInput>, 'version'>, defaults: AiDefaults): void {
    if (next.enabled && !next.dpa_reference) throw new BadRequestException({ code: 'dpa_required' });
    if (next.enabled && !defaults.harness_regions.includes(next.residency_region))
      throw new BadRequestException({
        code: 'residency_unsupported',
        region: next.residency_region,
        served: defaults.harness_regions,
      });
    const problems: string[] = [];
    for (const [key, setting] of Object.entries(next.capabilities ?? {})) {
      if (!(AI_CAPABILITIES as readonly string[]).includes(key)) {
        problems.push(`unknown capability ${key}`);
        continue;
      }
      if (!setting || typeof setting !== 'object') {
        problems.push(`${key}: must be an object`);
        continue;
      }
      for (const [field, value] of Object.entries(setting)) {
        if (field === 'enabled' || field === 'auto_apply') {
          if (typeof value !== 'boolean') problems.push(`${key}.${field}: must be a boolean`);
        } else if (field === 'threshold' || field === 'auto_min') {
          if (typeof value !== 'number' || value < 0 || value > 1)
            problems.push(`${key}.${field}: must be between 0 and 1`);
        } else if (field === 'expires_minutes') {
          if (typeof value !== 'number' || value <= 0) problems.push(`${key}.${field}: must be positive`);
        } else {
          problems.push(`${key}.${field}: unknown field`);
        }
      }
      if ((setting as Partial<CapabilitySetting>).auto_apply && !next.auto_apply_approval_ref)
        problems.push(`${key}: auto_apply requires auto_apply_approval_ref`);
    }
    if (problems.length > 0) throw new BadRequestException({ code: 'invalid_capabilities', problems });
  }

  private async view(tx: Tx, accountId: string): Promise<AiSettingsView> {
    const effective = await this.effective(tx, accountId);
    const settings = effective.settings;
    return {
      account_id: accountId,
      enabled: settings?.enabled ?? false,
      dpa_reference: settings?.dpa_reference ?? null,
      residency_region: settings?.residency_region ?? 'us',
      redaction_profile: settings?.redaction_profile ?? 'standard',
      draft_tone: settings?.draft_tone ?? 'plain',
      capabilities: effective.capabilities,
      auto_apply_approval_ref: settings?.auto_apply_approval_ref ?? null,
      version: settings?.version ?? 0,
      effective: effective.on ? { on: true } : { on: false, reason: effective.reason },
    };
  }
}
