import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestContext } from '../../../common/auth/decorators.js';
import type { Principal } from '../../../common/auth/principal.js';
import { actorOf, AuditService, SYSTEM_ACTOR } from '../../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../../common/events/security-events.service.js';
import { RepositoryBase, type Tx } from '../../../db/repository.base.js';
import { UnitOfWork } from '../../../db/unit-of-work.js';
import { PriorityMatrix, validateMatrix, type PriorityMatrixBody } from '../../../domain/tickets/priority-matrix.js';
import { StateMachine, validateMachine, type StateMachineBody } from '../../../domain/tickets/state-machine.js';

/**
 * Configuration catalogs as versioned data (Accounts & Administration
 * technical 2.3, 3.4). `ensureDefaults` loads the seed JSON as version 1
 * when a (kind, scope) has no version yet; `ConfigResolver.resolve` returns
 * the active override for the account if present, else the active default,
 * cached per process for 60 seconds.
 */
export type ConfigKind =
  'state_machine' | 'priority_matrix' | 'sla_policy' | 'activity_types' | 'billable_classes' | 'resolution_codes';
export const CONFIG_KINDS: readonly ConfigKind[] = [
  'state_machine',
  'priority_matrix',
  'sla_policy',
  'activity_types',
  'billable_classes',
  'resolution_codes',
];
export const TICKET_TYPES = ['incident', 'service_request', 'change', 'problem', 'project_task'] as const;

export interface ConfigVersionRow {
  id: string;
  account_id?: string;
  kind: ConfigKind;
  scope_key: string;
  version: number;
  body: unknown;
  status: 'draft' | 'active' | 'retired';
  activated_at: string | null;
  activated_by: string | null;
  created_at: string;
}

export interface ResolvedConfig<T = unknown> {
  readonly versionId: string;
  readonly source: 'default' | 'override';
  readonly version: number;
  readonly body: T;
}

const here = dirname(fileURLToPath(import.meta.url));
const SEEDS = join(here, '..', '..', '..', 'config', 'seeds');

export function loadSeed<T>(name: string): T {
  return JSON.parse(readFileSync(join(SEEDS, `${name}.json`), 'utf8')) as T;
}

@Injectable()
export class ConfigRepository extends RepositoryBase {
  activeDefault(tx: Tx, kind: ConfigKind, scopeKey: string): Promise<ConfigVersionRow | undefined> {
    return this.maybeOne<ConfigVersionRow>(
      tx,
      `select * from op.config_defaults where kind = $1 and scope_key = $2 and status = 'active'`,
      [kind, scopeKey],
    );
  }

  activeOverride(tx: Tx, accountId: string, kind: ConfigKind, scopeKey: string): Promise<ConfigVersionRow | undefined> {
    return this.maybeOne<ConfigVersionRow>(
      tx,
      `select * from acct.config_overrides where account_id = $1 and kind = $2 and scope_key = $3 and status = 'active'`,
      [accountId, kind, scopeKey],
    );
  }

  versions(tx: Tx, kind: ConfigKind, scopeKey: string): Promise<ConfigVersionRow[]> {
    return this.many<ConfigVersionRow>(
      tx,
      `select * from op.config_defaults where kind = $1 and scope_key = $2 order by version desc`,
      [kind, scopeKey],
    );
  }

  versionById(tx: Tx, id: string): Promise<ConfigVersionRow> {
    return this.one<ConfigVersionRow>(tx, 'config_version', 'select * from op.config_defaults where id = $1', [id]);
  }

  async insertDefault(
    tx: Tx,
    kind: ConfigKind,
    scopeKey: string,
    body: unknown,
    status: 'draft' | 'active',
    activatedBy: string,
  ): Promise<ConfigVersionRow> {
    const next = await this.maybeOne<{ next: number }>(
      tx,
      `select coalesce(max(version), 0) + 1 as next from op.config_defaults where kind = $1 and scope_key = $2`,
      [kind, scopeKey],
    );
    return this.one<ConfigVersionRow>(
      tx,
      'config_version',
      `insert into op.config_defaults (kind, scope_key, version, body, status, activated_at, activated_by)
       values ($1, $2, $3, $4, $5, case when $5 = 'active' then now() end, case when $5 = 'active' then $6 end) returning *`,
      [kind, scopeKey, next?.next ?? 1, JSON.stringify(body), status, activatedBy],
    );
  }

  async activate(
    tx: Tx,
    id: string,
    activatedBy: string,
  ): Promise<{ previous?: ConfigVersionRow; current: ConfigVersionRow }> {
    const target = await this.versionById(tx, id);
    const previous = await this.activeDefault(tx, target.kind, target.scope_key);
    if (previous && previous.id !== id) {
      await tx.query(`update op.config_defaults set status = 'retired' where id = $1`, [previous.id]);
    }
    const current = await this.one<ConfigVersionRow>(
      tx,
      'config_version',
      `update op.config_defaults set status = 'active', activated_at = now(), activated_by = $2 where id = $1 returning *`,
      [id, activatedBy],
    );
    return { previous, current };
  }
}

@Injectable()
export class ConfigService {
  private readonly cache = new Map<string, { at: number; value: ResolvedConfig }>();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: ConfigRepository,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
  ) {}

  /** Idempotent: inserts version 1 active from the seed for every (kind, scope) that has none. */
  async ensureDefaults(): Promise<string[]> {
    const created: string[] = [];
    await this.uow.operator(async (tx) => {
      const machines = loadSeed<Record<string, StateMachineBody>>('state-machines');
      for (const type of TICKET_TYPES) {
        if (!(await this.repo.activeDefault(tx, 'state_machine', type))) {
          await this.repo.insertDefault(tx, 'state_machine', type, machines[type], 'active', 'seed');
          created.push(`state_machine:${type}`);
        }
      }
      const singles: [ConfigKind, string][] = [
        ['priority_matrix', 'priority-matrix'],
        ['sla_policy', 'sla-policy'],
        ['activity_types', 'activity-types'],
        ['billable_classes', 'billable-classes'],
        ['resolution_codes', 'resolution-codes'],
      ];
      for (const [kind, file] of singles) {
        if (!(await this.repo.activeDefault(tx, kind, '*'))) {
          await this.repo.insertDefault(tx, kind, '*', loadSeed(file), 'active', 'seed');
          created.push(kind);
        }
      }
    });
    this.cache.clear();
    return created;
  }

  /** Active override for the account if present, else the active default. Requires a transaction bound to the account for overrides. */
  async resolve<T = unknown>(
    tx: Tx,
    kind: ConfigKind,
    scopeKey: string,
    accountId?: string,
  ): Promise<ResolvedConfig<T>> {
    const key = `${accountId ?? '*'}:${kind}:${scopeKey}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.value as ResolvedConfig<T>;
    const override = accountId ? await this.repo.activeOverride(tx, accountId, kind, scopeKey) : undefined;
    const row = override ?? (await this.repo.activeDefault(tx, kind, scopeKey));
    if (!row) throw new NotFoundException({ code: 'config_missing', kind, scopeKey });
    const value: ResolvedConfig<T> = {
      versionId: row.id,
      source: override ? 'override' : 'default',
      version: row.version,
      body: row.body as T,
    };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async stateMachine(tx: Tx, type: string, accountId?: string): Promise<{ machine: StateMachine; versionId: string }> {
    const resolved = await this.resolve<StateMachineBody>(tx, 'state_machine', type, accountId);
    return { machine: new StateMachine(resolved.body), versionId: resolved.versionId };
  }

  async priorityMatrix(tx: Tx, accountId?: string): Promise<{ matrix: PriorityMatrix; versionId: string }> {
    const resolved = await this.resolve<PriorityMatrixBody>(tx, 'priority_matrix', '*', accountId);
    return { matrix: new PriorityMatrix(resolved.body), versionId: resolved.versionId };
  }

  /** Admin read: the active default and the version history. */
  async describe(
    kind: ConfigKind,
    scopeKey: string,
  ): Promise<{ active?: ConfigVersionRow; versions: ConfigVersionRow[] }> {
    return this.uow.operator(async (tx) => ({
      active: await this.repo.activeDefault(tx, kind, scopeKey),
      versions: await this.repo.versions(tx, kind, scopeKey),
    }));
  }

  async createDraft(
    principal: Principal,
    ctx: RequestContext,
    kind: ConfigKind,
    scopeKey: string,
    body: unknown,
  ): Promise<ConfigVersionRow> {
    this.validate(kind, body);
    return this.uow.operator(async (tx) => {
      const row = await this.repo.insertDefault(tx, kind, scopeKey, body, 'draft', principal.userId);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: `config.${kind}`,
          entityId: row.id,
          eventType: 'created',
          newValue: { scopeKey, version: row.version },
        },
      ]);
      return row;
    });
  }

  async activateVersion(principal: Principal, ctx: RequestContext, id: string): Promise<ConfigVersionRow> {
    const result = await this.uow.operator(async (tx) => {
      const target = await this.repo.versionById(tx, id);
      this.validate(target.kind, target.body);
      const { previous, current } = await this.repo.activate(tx, id, principal.userId);
      await this.audit.operator(tx, actorOf(principal), ctx, [
        {
          entityKind: `config.${current.kind}`,
          entityId: current.id,
          eventType: 'admin.config.activated',
          oldValue: previous?.body ?? null,
          newValue: current.body,
        },
      ]);
      await this.security.write(
        {
          type: 'admin.config.changed',
          outcome: 'success',
          actorKind: 'user',
          actorId: principal.userId,
          actorName: principal.displayName,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: `config.${current.kind}`,
          entityId: current.id,
          attrs: {
            kind: current.kind,
            scopeKey: current.scope_key,
            version: current.version,
            previousVersion: previous?.version ?? null,
          },
        },
        tx,
      );
      return current;
    });
    this.cache.clear();
    return result;
  }

  private validate(kind: ConfigKind, body: unknown): void {
    let problems: string[] = [];
    if (kind === 'state_machine') problems = validateMachine(body as StateMachineBody);
    if (kind === 'priority_matrix') problems = validateMatrix(body as PriorityMatrixBody);
    if (['activity_types', 'billable_classes', 'resolution_codes'].includes(kind)) {
      const items = (body as { items?: unknown[] })?.items;
      if (!Array.isArray(items) || items.length === 0) problems = ['items must be a non-empty array'];
    }
    if (problems.length > 0) throw new BadRequestException({ code: 'invalid_config', problems });
  }

  static systemActorName(): string {
    return SYSTEM_ACTOR.name ?? 'XMS';
  }
}
