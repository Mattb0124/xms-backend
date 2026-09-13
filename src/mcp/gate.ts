import { Injectable } from '@nestjs/common';
import type { Principal } from '../common/auth/principal.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { redact, type Person, type RedactionProfile } from '../domain/ai/redaction.js';
import { AiSettingsService } from '../modules/ai/ai-settings.service.js';
import { TicketsService } from '../modules/tickets/tickets.service.js';

/** What the gate settled: which accounts, which profile, and whose names. */
export interface GateScope {
  readonly accountIds: string[];
  readonly profile: RedactionProfile;
  /**
   * The people whose names become role labels under the strict profile.
   *
   * `redact` only labels names it was handed, so a strict account would get
   * no more than credential masking unless this is populated. A ticket tool
   * can populate it, because the gate has already read the ticket and the
   * requester is on it, and the same list is used for every string in the
   * answer, so the labels stay consistent across fields. A tool spanning
   * accounts has no one ticket to take participants from and passes none:
   * strict there masks credentials but cannot label a name, which is recorded
   * here rather than left to be discovered.
   */
  readonly people: readonly Person[];
}

/** Why a tool answered nothing. The adapter's own vocabulary (AI-11, AI-12). */
export type WithheldReason = 'switch_off' | 'residency' | 'kill_switch' | 'redaction_refused';

export class ToolWithheld extends Error {
  constructor(readonly reason: WithheldReason) {
    super(reason);
    this.name = 'ToolWithheld';
  }
}

/** Under `strict`, a name is replaced by a role label, so the strictest wins. */
const strictest = (profiles: RedactionProfile[]): RedactionProfile =>
  profiles.includes('strict') ? 'strict' : 'standard';

/**
 * The gate every tool result passes through (AI-11, AI-12, AI Integration §6).
 *
 * Two things the MCP inherited from neither the guard nor the services, because
 * both are the ADAPTER's job and the MCP is a second adapter:
 *
 * 1. **The switch.** A client can turn AI off, and that has to hold at the data
 *    layer, not in a screen. `AiSettingsService.effective` answers it, covering
 *    the account's own switch, the residency rule and the operator kill switch
 *    in one call. Without this an account with AI off was still fully readable
 *    through a tool, which is the requirement inverted.
 *
 * 2. **Redaction.** Nothing leaves the boundary carrying a credential, a card
 *    or an IBAN, and under the strict profile a person's name leaves as a role
 *    label. `domain/ai/redaction` already does this and the Axel adapter
 *    already uses it; this applies the same function at the same profile, so
 *    there is one redaction policy in the product rather than two.
 *
 * The operator kill switch arrives through the same call, which is why the MCP
 * needs no switch of its own: `defaults.kill_switch` is already operator-wide,
 * which is the shape an account-scoped connector instance could never have had.
 *
 * One property of that worth knowing before it is relied on in an incident:
 * the defaults come through `ConfigService`, which caches for 60 seconds per
 * process, so the kill switch takes up to a minute to close the tools. Measured
 * on 2026-09-13 against the running stack, not inferred. That is the right
 * trade for a value read on every call, but an operator pulling the lever
 * expects it to bite at once, so either the expectation or the cache has to
 * give: cache invalidation across processes is the fix, not a shorter window.
 */
@Injectable()
export class ToolGate {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settings: AiSettingsService,
    private readonly tickets: TicketsService,
  ) {}

  /**
   * The account behind a ticket key, and the profile to redact its answer at.
   *
   * The ticket is read here as well as in the tool, which is one more indexed
   * read by key. That is deliberate: the switch has to be answered before the
   * tool runs, and the only honest way to know whose switch to read is to look
   * at the row. The read is the caller's own and checked by the policy, so a
   * key naming an account the caller may not see is refused here on the ticket
   * rather than through the switch, and says so.
   */
  async forTicket(principal: Principal, key: string): Promise<GateScope> {
    const ticket = (await this.tickets.get(principal, key)) as {
      account_id: string;
      requester?: { email: string; display_name?: string | null } | null;
    };
    const profile = await this.profileFor(principal, ticket.account_id);
    // The same list the suggestion service builds for a capability request, so
    // a name is labelled the same way whichever adapter asked.
    const people: Person[] = ticket.requester
      ? [{ email: ticket.requester.email, name: ticket.requester.display_name ?? undefined, role: 'requester' }]
      : [];
    return { accountIds: [ticket.account_id], profile, people };
  }

  /**
   * The profile to redact at for one account, or a refusal. Reads the switch
   * inside the caller's own unit of work, so the settings row is read under
   * the same binding as everything else the tool touches.
   */
  async profileFor(principal: Principal, accountId: string): Promise<RedactionProfile> {
    return this.uow.run(principal, async (tx) => {
      const effective = await this.settings.effective(tx, accountId);
      if (!effective.on) throw new ToolWithheld(effective.reason ?? 'switch_off');
      return (effective.settings?.redaction_profile ?? 'standard') as RedactionProfile;
    });
  }

  /**
   * The accounts this caller may see that have AI on, and the profile to use
   * across them. A tool that spans accounts must not answer from an account
   * whose switch is off, so the ids come back for the tool to filter on, and
   * a caller with no account switched on is refused outright rather than
   * answered with an empty list that reads as "nothing found".
   */
  async accountsOn(principal: Principal): Promise<GateScope> {
    return this.uow.run(principal, async (tx) => {
      const on: string[] = [];
      const profiles: RedactionProfile[] = [];
      let lastReason: WithheldReason = 'switch_off';
      for (const accountId of principal.accountIds) {
        const effective = await this.settings.effective(tx, accountId);
        if (!effective.on) {
          lastReason = effective.reason ?? 'switch_off';
          continue;
        }
        on.push(accountId);
        profiles.push((effective.settings?.redaction_profile ?? 'standard') as RedactionProfile);
      }
      if (on.length === 0) throw new ToolWithheld(lastReason);
      return { accountIds: on, profile: strictest(profiles), people: [] };
    });
  }

  /**
   * Every string in a tool's answer, redacted at the account's profile.
   *
   * Walked rather than applied to the serialised whole so the shape survives:
   * an agent reads `state` and `key` as fields, and redacting the JSON text
   * would mask inside them. A payload still carrying a hard block after
   * masking is refused, which is the one case where the right answer is to
   * send nothing at all.
   */
  clean<T>(value: T, profile: RedactionProfile, people: readonly Person[] = []): T {
    return this.walk(value, profile, people) as T;
  }

  /**
   * The answer narrowed to the accounts whose switch is on.
   *
   * Three tools span accounts without taking an account filter, so the switch
   * cannot be pushed into the query. Rather than leave that, the answer is
   * confined on the way out: a row belonging to an account with AI off is
   * dropped from a list, and refuses a single object outright. A row with no
   * account of its own (the global knowledge library, a portfolio total) is
   * not account data and passes.
   *
   * A figure already totalled across accounts is the one thing this cannot
   * take apart, which is why `get_period_metrics` is gated on the operator
   * permission `reports:view-portfolio`: a total over accounts is what that
   * permission is for, and it carries no account's content.
   */
  confine<T>(value: T, accountIds: string[]): T {
    const allowed = new Set(accountIds);
    const ownedByOther = (item: unknown): boolean => {
      if (!item || typeof item !== 'object') return false;
      const owner = (item as { account_id?: unknown }).account_id;
      return typeof owner === 'string' && !allowed.has(owner);
    };
    const prune = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.filter((entry) => !ownedByOther(entry)).map(prune);
      if (item && typeof item === 'object' && !(item instanceof Date)) {
        return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, prune(entry)]));
      }
      return item;
    };
    if (ownedByOther(value)) throw new ToolWithheld('switch_off');
    return prune(value) as T;
  }

  private walk(value: unknown, profile: RedactionProfile, people: readonly Person[]): unknown {
    if (typeof value === 'string') {
      const result = redact(value, profile, people);
      if (result.refused) throw new ToolWithheld('redaction_refused');
      return result.text;
    }
    if (Array.isArray(value)) return value.map((item) => this.walk(item, profile, people));
    if (value && typeof value === 'object') {
      if (value instanceof Date) return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.walk(item, profile, people)]));
    }
    return value;
  }
}
