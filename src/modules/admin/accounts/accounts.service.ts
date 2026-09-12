import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { RequestContext } from '../../../common/auth/decorators.js';
import type { Principal } from '../../../common/auth/principal.js';
import { actorOf, AuditService } from '../../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../../common/events/security-events.service.js';
import { StaleVersionError } from '../../../db/repository.base.js';
import { UnitOfWork } from '../../../db/unit-of-work.js';
import {
  ACCOUNT_EDITABLE,
  AccountsRepository,
  SETTINGS_EDITABLE,
  type AccountRow,
  type AccountSettingsRow,
  type AccountSummaryRow,
} from './accounts.repository.js';
import type {
  ChangeAccountOwnerDto,
  CreateAccountDto,
  UpdateAccountDto,
  UpdateAccountSettingsDto,
} from './accounts.dto.js';

/**
 * Accounts and their settings (Accounts & Administration technical 3.3, 4).
 * Every mutation writes its audit event in the same transaction; settings
 * changes also write the matching admin security event (the AI switch has
 * its own event type because it is a data-egress decision).
 */
const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  onboarding: ['active', 'offboarding'],
  active: ['suspended', 'offboarding'],
  suspended: ['active', 'offboarding'],
  offboarding: ['offboarded'],
  offboarded: [],
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accounts: AccountsRepository,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
  ) {}

  list(principal: Principal, query: { status?: string; limit?: number; cursor?: string }): Promise<AccountRow[]> {
    const limit = Math.min(query.limit ?? 50, 200);
    return this.uow.operator((tx) => this.accounts.list(tx, { status: query.status, limit, cursor: query.cursor }));
  }

  /** Granted accounts for pickers; administrators see every account. */
  granted(principal: Principal): Promise<AccountSummaryRow[]> {
    return this.uow.operator((tx) => this.accounts.summariesByIds(tx, principal.accountIds));
  }

  get(principal: Principal, id: string): Promise<AccountRow> {
    return this.uow.operator((tx) => this.accounts.byId(tx, id));
  }

  async create(principal: Principal, ctx: RequestContext, dto: CreateAccountDto): Promise<AccountRow> {
    const account = await this.uow.operator((tx) => this.accounts.insert(tx, dto));
    // The settings row lives under RLS; the creating administrator is not
    // yet bound to the new account within this request, so the unit of work
    // widens the binding explicitly for this one write.
    await this.uow.runWithAccounts(principal, [account.id], async (tx) => {
      await this.accounts.insertSettings(tx, account.id);
      await this.audit.account(tx, account.id, actorOf(principal), ctx, [
        {
          entityKind: 'account',
          entityId: account.id,
          eventType: 'admin.account.created',
          newValue: { key: account.key, name: account.name },
        },
      ]);
      await this.security.write(
        {
          type: 'admin.account.created',
          outcome: 'success',
          accountId: account.id,
          actorKind: 'user',
          actorId: principal.userId,
          actorName: principal.displayName,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: 'account',
          entityId: account.id,
          attrs: { key: account.key },
        },
        tx,
      );
    });
    return account;
  }

  async update(principal: Principal, ctx: RequestContext, id: string, dto: UpdateAccountDto): Promise<AccountRow> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.accounts.byId(tx, id);
      const assignments: Record<string, unknown> = {};
      for (const field of ACCOUNT_EDITABLE) {
        if (dto[field] !== undefined)
          assignments[field] = field === 'branding' ? JSON.stringify(dto[field]) : dto[field];
      }
      if (assignments.isolation_tier && assignments.isolation_tier !== before.isolation_tier) {
        await this.security.write(
          {
            type: 'admin.account.isolation_tier_changed',
            outcome: 'success',
            accountId: id,
            actorKind: 'user',
            actorId: principal.userId,
            actorName: principal.displayName,
            principalKind: principal.kind,
            requestId: ctx.requestId,
            entityKind: 'account',
            entityId: id,
            attrs: { from: before.isolation_tier, to: assignments.isolation_tier },
          },
          tx,
        );
      }
      const after = await this.accounts.update(tx, id, dto.version, assignments);
      const entries = this.audit.diff('account', id, 'admin.account.updated', before as never, after as never, [
        ...ACCOUNT_EDITABLE,
      ]);
      if (entries.length > 0) await this.audit.account(tx, id, actorOf(principal), ctx, entries);
      return after;
    });
  }

  /**
   * Hand the account to a different owner (TM-23). Its own route because it
   * is its own decision: the candidate is checked, the change is refused
   * rather than silently applied when they cannot hold it, and both the
   * audit entry and the security event name the person leaving and the
   * person arriving.
   */
  async changeOwner(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    dto: ChangeAccountOwnerDto,
  ): Promise<AccountRow> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.accounts.byId(tx, id);
      const candidate = await this.accounts.ownerCandidate(tx, dto.owner_user_id, id);
      // A portal identity can never own an account: the owner is the CSM,
      // and the realms do not cross.
      if (!candidate || candidate.kind !== 'internal') {
        throw new BadRequestException({ code: 'owner_not_internal' });
      }
      if (candidate.status !== 'active') {
        throw new BadRequestException({ code: 'owner_not_active', status: candidate.status });
      }
      // An owner who cannot open the account cannot own it. The grant is the
      // thing that decides what an internal user may see (Security &
      // Tenancy 2.3), so the account is handed over only to somebody who
      // already holds one.
      if (!candidate.granted) {
        throw new BadRequestException({ code: 'owner_not_granted', account_id: id });
      }
      // A handover to the owner already in place changes nothing, but it is
      // still a write the caller made against a version they read. Refusing
      // the stale one here keeps the answer the same as it would be for any
      // other no-op edit, instead of reporting success to somebody whose copy
      // of the record is behind.
      if (before.owner_user_id === dto.owner_user_id) {
        if (before.version !== dto.version) throw new StaleVersionError('account', id);
        return before;
      }

      const previousName = await this.accounts.ownerName(tx, before.owner_user_id);
      const after = await this.accounts.update(tx, id, dto.version, { owner_user_id: dto.owner_user_id });
      await this.audit.account(tx, id, actorOf(principal), ctx, [
        {
          entityKind: 'account',
          entityId: id,
          eventType: 'admin.account.owner_changed',
          field: 'owner_user_id',
          oldValue: before.owner_user_id ? { user_id: before.owner_user_id, name: previousName } : null,
          newValue: { user_id: candidate.id, name: candidate.display_name, reason: dto.reason ?? null },
        },
      ]);
      await this.security.write(
        {
          type: 'admin.account.owner_changed',
          outcome: 'success',
          accountId: id,
          actorKind: 'user',
          actorId: principal.userId,
          actorName: principal.displayName,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: 'account',
          entityId: id,
          attrs: { from: before.owner_user_id, to: candidate.id },
        },
        tx,
      );
      return after;
    });
  }

  async transition(principal: Principal, ctx: RequestContext, id: string, to: string): Promise<AccountRow> {
    return this.uow.run(principal, async (tx) => {
      const before = await this.accounts.byId(tx, id);
      if (!STATUS_TRANSITIONS[before.status]?.includes(to)) {
        throw new ConflictException({ code: 'invalid_transition', from: before.status, to });
      }
      // Past onboarding, an account has an owner (TM-23), and migration 0050
      // will not let it be otherwise. Taking an account live is therefore
      // also the moment ownership is established: rather than refuse, the
      // person doing it becomes the owner, audited as such and changed
      // afterwards through the owner route like any other handover. That
      // keeps the invariant true by construction, and the fact it records
      // (this named administrator took the account live and answers for it
      // until they hand it on) is one that actually happened. A principal
      // who cannot hold the account is refused instead, with the thing to
      // fix named.
      if (before.owner_user_id === null && to !== 'onboarding') {
        const candidate = await this.accounts.ownerCandidate(tx, principal.userId, id);
        if (!candidate || candidate.kind !== 'internal' || candidate.status !== 'active' || !candidate.granted) {
          throw new ConflictException({ code: 'owner_required', account_id: id });
        }
        await this.accounts.update(tx, id, before.version, { owner_user_id: principal.userId });
        before.version += 1;
        before.owner_user_id = principal.userId;
        await this.audit.account(tx, id, actorOf(principal), ctx, [
          {
            entityKind: 'account',
            entityId: id,
            eventType: 'admin.account.owner_changed',
            field: 'owner_user_id',
            oldValue: null,
            newValue: { user_id: candidate.id, name: candidate.display_name, reason: 'set when the account went live' },
          },
        ]);
        await this.security.write(
          {
            type: 'admin.account.owner_changed',
            outcome: 'success',
            accountId: id,
            actorKind: 'user',
            actorId: principal.userId,
            actorName: principal.displayName,
            principalKind: principal.kind,
            requestId: ctx.requestId,
            entityKind: 'account',
            entityId: id,
            attrs: { from: null, to: candidate.id, at: 'activation' },
          },
          tx,
        );
      }
      const after = await this.accounts.update(tx, id, before.version, { status: to });
      await this.audit.account(tx, id, actorOf(principal), ctx, [
        {
          entityKind: 'account',
          entityId: id,
          eventType: 'admin.account.status_changed',
          field: 'status',
          oldValue: before.status,
          newValue: to,
        },
      ]);
      await this.security.write(
        {
          type: 'admin.account.status_changed',
          outcome: 'success',
          accountId: id,
          actorKind: 'user',
          actorId: principal.userId,
          actorName: principal.displayName,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: 'account',
          entityId: id,
          attrs: { from: before.status, to },
        },
        tx,
      );
      return after;
    });
  }

  settings(principal: Principal, id: string): Promise<AccountSettingsRow> {
    return this.uow.run(principal, (tx) => this.accounts.settings(tx, id));
  }

  async updateSettings(
    principal: Principal,
    ctx: RequestContext,
    id: string,
    dto: UpdateAccountSettingsDto,
  ): Promise<AccountSettingsRow> {
    const touchesAi = dto.ai_enabled !== undefined || dto.ai_opt_ins !== undefined;
    if (touchesAi && !principal.permissions.has('ai:configure')) {
      throw new ForbiddenException({ code: 'forbidden', permission: 'ai:configure' });
    }
    return this.uow.run(principal, async (tx) => {
      const before = await this.accounts.settings(tx, id);
      const assignments: Record<string, unknown> = {};
      for (const field of SETTINGS_EDITABLE) {
        const value = dto[field];
        if (value === undefined) continue;
        assignments[field] = field === 'ai_opt_ins' || field === 'email_branding' ? JSON.stringify(value) : value;
      }
      const after = await this.accounts.updateSettings(tx, before.id, dto.version, assignments);
      const entries = this.audit.diff(
        'account_settings',
        before.id,
        'admin.account.settings_changed',
        before as never,
        after as never,
        [...SETTINGS_EDITABLE],
      );
      await this.audit.account(tx, id, actorOf(principal), ctx, entries);
      const changed = entries.map((entry) => entry.field);
      if (changed.length > 0) {
        await this.security.write(
          {
            type: 'admin.account.settings_changed',
            outcome: 'success',
            accountId: id,
            actorKind: 'user',
            actorId: principal.userId,
            actorName: principal.displayName,
            principalKind: principal.kind,
            requestId: ctx.requestId,
            entityKind: 'account',
            entityId: id,
            attrs: { keys: changed },
          },
          tx,
        );
      }
      if (before.ai_enabled !== after.ai_enabled) {
        await this.security.write(
          {
            type: 'admin.account.ai_switch_changed',
            outcome: 'success',
            accountId: id,
            actorKind: 'user',
            actorId: principal.userId,
            actorName: principal.displayName,
            principalKind: principal.kind,
            requestId: ctx.requestId,
            entityKind: 'account',
            entityId: id,
            attrs: { enabled: after.ai_enabled },
          },
          tx,
        );
      }
      return after;
    });
  }
}
