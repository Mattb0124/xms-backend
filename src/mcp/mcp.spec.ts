import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../common/auth/principal.js';
import type { Permission } from '../contracts/permissions.js';
import type { RequestContext } from '../common/auth/decorators.js';
import type { SuggestionService } from '../modules/ai/suggestion.service.js';
import type { ReportingService } from '../modules/reporting/reporting.service.js';
import type { KnowledgeService } from '../modules/knowledge/knowledge.module.js';
import type { TicketsService } from '../modules/tickets/tickets.service.js';
import type { TimeService } from '../modules/time/time.module.js';
import type { AiSettingsService, EffectiveSwitch } from '../modules/ai/ai-settings.service.js';
import type { UnitOfWork } from '../db/unit-of-work.js';
import type { SecurityEvent, SecurityEventsService } from '../common/events/security-events.service.js';
import { ToolGate } from './gate.js';
import { McpController, ToolRegistry } from './mcp.controller.js';
import { buildTools } from './tools.js';

function principal(permissions: Permission[]): Principal {
  return {
    kind: 'harness',
    userId: 'u1',
    email: 'ana@example.test',
    displayName: 'Ana Costa',
    accountIds: ['acc-1'],
    permissions: new Set(permissions),
    sessionId: 'sess-1',
    tokenType: 'harness',
  } as Principal;
}

const CTX: RequestContext = { requestId: 'req-1' };

/** The switch as `AiSettingsService.effective` answers it, on or off. */
const switchOn = (redaction: 'standard' | 'strict' = 'standard'): EffectiveSwitch =>
  ({
    on: true,
    settings: { redaction_profile: redaction },
    defaults: {},
    capabilities: {},
  }) as unknown as EffectiveSwitch;
const switchOff = (reason: 'switch_off' | 'residency' | 'kill_switch'): EffectiveSwitch =>
  ({ on: false, reason, defaults: {}, capabilities: {} }) as unknown as EffectiveSwitch;

function harness(
  overrides: {
    tickets?: Partial<TicketsService>;
    knowledge?: Partial<KnowledgeService>;
    suggestions?: Partial<SuggestionService>;
    /** The switch each account answers with. Every account is on by default. */
    ai?: (accountId: string) => EffectiveSwitch;
  } = {},
) {
  const tickets = {
    // Shaped rather than empty, because the gate reads this to learn whose AI
    // switch governs the call before the tool runs.
    get: vi.fn().mockResolvedValue({ id: 'tk-1', key: 'CS1000008', account_id: 'acc-1' }),
    list: vi.fn(),
    comments: vi.fn(),
    workNotes: vi.fn(),
    timeline: vi.fn(),
    addWorkNote: vi.fn(),
    ...overrides.tickets,
  } as unknown as TicketsService;
  const knowledge = {
    search: vi.fn(),
    get: vi.fn(),
    rail: vi.fn(),
    ...overrides.knowledge,
  } as unknown as KnowledgeService;
  const time = { unlogged: vi.fn() } as unknown as TimeService;
  const suggestions = { propose: vi.fn(), ...overrides.suggestions } as unknown as SuggestionService;
  const reporting = { operations: vi.fn(), account: vi.fn() } as unknown as ReportingService;
  const registry = new ToolRegistry(tickets, knowledge, time, suggestions, reporting);

  // The real gate over a fake unit of work, rather than a stubbed gate: the
  // thing worth testing is that the switch is read and the answer redacted,
  // and a stub would pass whether or not either happened.
  const effective = vi.fn(async (_tx: unknown, accountId: string) => (overrides.ai ?? (() => switchOn()))(accountId));
  const uow = { run: <T>(_p: unknown, fn: (tx: unknown) => Promise<T>) => fn({}) } as unknown as UnitOfWork;
  const settings = { effective } as unknown as AiSettingsService;
  const gate = new ToolGate(uow, settings, tickets);

  // The security stream is collected rather than stubbed away: ADR-16 asks that
  // every AI egress write an event, and an assertion on a mock that was never
  // called would pass whether or not one was written.
  const events: SecurityEvent[] = [];
  const security = {
    write: vi.fn(async (event: SecurityEvent) => {
      events.push(event);
    }),
  } as unknown as SecurityEventsService;

  return {
    controller: new McpController(registry, gate, security),
    events,
    registry,
    tickets,
    knowledge,
    time,
    suggestions,
    reporting,
    gate,
    effective,
  };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('the MCP endpoint', () => {
  it('answers the handshake with a protocol version and its tool capability', async () => {
    const { controller } = harness();
    const reply = (await controller.rpc(principal(['tickets:view']), CTX, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })) as { result: { protocolVersion: string; capabilities: unknown } };
    expect(reply.result.protocolVersion).toBe('2025-06-18');
    expect(reply.result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  /**
   * A tool the caller cannot use is not listed. An agent shown a tool will
   * try it, and a refusal it cannot act on is a turn spent saying no.
   */
  it('lists only the tools the caller holds the permission for', async () => {
    const { controller } = harness();
    const withTickets = (await controller.rpc(principal(['tickets:view']), CTX, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })) as { result: { tools: Array<{ name: string }> } };
    expect(withTickets.result.tools.map((tool) => tool.name)).toEqual([
      'find_similar_tickets',
      'get_account_metrics',
      'get_article',
      'get_contract_position',
      'get_ticket',
      'get_ticket_thread',
      'list_tickets',
      'search_solutions',
    ]);

    const withNothing = (await controller.rpc(principal([]), CTX, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
      result: { tools: unknown[] };
    };
    expect(withNothing.result.tools).toEqual([]);
  });

  it('calls the same service a route calls, with the principal the guard resolved', async () => {
    const who = principal(['tickets:view']);
    const { controller, tickets } = harness({
      tickets: { get: vi.fn().mockResolvedValue({ key: 'CS1000008', short_description: 'Slow report' }) },
    });

    const reply = (await controller.rpc(who, CTX, call('get_ticket', { key: 'CS1000008' }))) as {
      result: { structuredContent: { key: string } };
    };

    expect(tickets.get).toHaveBeenCalledWith(who, 'CS1000008');
    expect(reply.result.structuredContent.key).toBe('CS1000008');
  });

  // The permission is checked before the arguments are read, so a caller who
  // may not use a tool learns nothing from the shape of its input.
  it('refuses a tool the caller may not use, before reading its arguments', async () => {
    const { controller, tickets } = harness();
    await expect(controller.rpc(principal([]), CTX, call('get_ticket', { key: 'CS1000008' }))).rejects.toMatchObject({
      response: { code: 'forbidden', permission: 'tickets:view' },
    });
    expect(tickets.get).not.toHaveBeenCalled();
  });

  it('refuses arguments that do not match the declared shape, and calls nothing', async () => {
    const { controller, tickets } = harness();
    const reply = (await controller.rpc(principal(['tickets:view']), CTX, call('list_tickets', { limit: 5000 }))) as {
      error: { code: number };
    };
    expect(reply.error.code).toBe(-32602);
    expect(tickets.list).not.toHaveBeenCalled();
  });

  it('names an unknown tool rather than failing the transport', async () => {
    const { controller } = harness();
    const reply = (await controller.rpc(principal(['tickets:view']), CTX, call('drop_everything'))) as {
      error: { code: number; message: string };
    };
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.message).toContain('drop_everything');
  });

  /**
   * A refusal the domain already words comes back as a tool error, so the
   * agent can say what happened instead of the turn dying on a 500.
   */
  it('returns a domain refusal as a tool error, in the service own words', async () => {
    const { controller } = harness({
      tickets: { get: vi.fn().mockRejectedValue(new Error('This ticket is not visible to you.')) },
    });
    const reply = (await controller.rpc(
      principal(['tickets:view']),
      CTX,
      call('get_ticket', { key: 'CS9999999' }),
    )) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toBe('This ticket is not visible to you.');
  });
});

describe('writing', () => {
  it('writes a work note through the service the route uses, carrying the request context', async () => {
    const who = principal(['tickets:work']);
    const { controller, tickets } = harness({ tickets: { addWorkNote: vi.fn().mockResolvedValue({ id: 'm1' }) } });

    await controller.rpc(who, CTX, call('add_work_note', { key: 'CS1000008', body: 'Cube rebuilt.' }));

    // AI-10: an AI act is distinguishable from a person's in the record. The
    // service defaults this to 'user', so the tool has to say otherwise.
    expect(tickets.addWorkNote).toHaveBeenCalledWith(who, CTX, 'CS1000008', { body: 'Cube rebuilt.' }, undefined, {
      authorKind: 'ai',
      authorName: 'Axel (for Ana Costa)',
    });
  });

  /**
   * The point of a proposal: it writes a suggestion for a person to decide on
   * and never touches the ticket (AI Integration §4, AI-08).
   */
  it('turns a proposal into a suggestion against the ticket, and mutates nothing', async () => {
    const who = principal(['ai:use']);
    const { controller, suggestions, tickets } = harness({
      tickets: { get: vi.fn().mockResolvedValue({ id: 'tk-1', key: 'CS1000008' }) },
      suggestions: { propose: vi.fn().mockResolvedValue({ id: 'sg-1', status: 'offered' }) },
    });

    await controller.rpc(
      who,
      CTX,
      call('propose_priority', {
        key: 'CS1000008',
        impact: 'high',
        urgency: 'high',
        confidence: 0.8,
        reason: 'Month end.',
      }),
    );

    expect(suggestions.propose).toHaveBeenCalledWith(who, CTX, {
      capability: 'prioritise',
      target_kind: 'ticket',
      // resolved from the key through the same read the tools use, so the
      // caller is checked against the ticket before anything is written
      target_id: 'tk-1',
      payload: { impact: 'high', urgency: 'high', confidence: 0.8, reason: 'Month end.' },
    });
    expect(tickets.addWorkNote).not.toHaveBeenCalled();
  });

  it('refuses a proposal from a caller without ai:use, and resolves no ticket', async () => {
    const { controller, suggestions, tickets } = harness();
    await expect(
      controller.rpc(
        principal(['tickets:work']),
        CTX,
        call('propose_summary', { key: 'CS1000008', summary: 'x', confidence: 0.9 }),
      ),
    ).rejects.toMatchObject({ response: { code: 'forbidden', permission: 'ai:use' } });
    expect(suggestions.propose).not.toHaveBeenCalled();
    expect(tickets.get).not.toHaveBeenCalled();
  });
});

describe('the tool catalog', () => {
  const tools = buildTools({
    tickets: {} as TicketsService,
    knowledge: {} as KnowledgeService,
    time: {} as TimeService,
    suggestions: {} as SuggestionService,
    reporting: {} as ReportingService,
  });

  // The MCP is a second way to reach the data and must not become a second
  // way to authorise it. Every tool names the permission the route serving
  // the same data names, and the boot check cannot see these because they are
  // not routes, so this stands in for it.
  it('declares a permission for every tool', () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.permission, `${tool.name} declares no permission`).toBeTruthy();
    }
  });

  it('takes no account id from the caller, on any tool', () => {
    for (const tool of tools) {
      const fields = Object.keys(tool.input);
      expect(fields, `${tool.name} accepts an account id`).not.toContain('account_id');
      expect(fields, `${tool.name} accepts an account id`).not.toContain('accountId');
    }
  });

  /**
   * AI Integration §4: the only direct writes are `add_work_note` and
   * `create_article_draft`; everything else an agent wants to change is a
   * `propose_*` that a person decides on. Asserted against the catalog's own
   * flag rather than against the tool names, so a write tool added under any
   * name fails here.
   */
  it('lets only the two allowed tools write directly', () => {
    const writing = tools.filter((tool) => tool.writes).map((tool) => tool.name);
    expect(writing).toEqual(['add_work_note', 'create_article_draft']);
  });

  it('routes every proposal through ai:use, never through a ticket permission', () => {
    for (const tool of tools.filter((t) => t.name.startsWith('propose_'))) {
      expect(tool.permission, `${tool.name} is not on ai:use`).toBe('ai:use');
      expect(tool.writes, `${tool.name} claims a direct write`).toBeFalsy();
    }
  });

  it('gives every tool a name, a title and a description an agent can choose from', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});

/**
 * The switch and the redaction are the adapter's job, and the MCP is a second
 * adapter (AI-11, AI-12, AI Integration section 6). Neither the guard nor the
 * services cover this: a service answers a question it was asked by someone
 * entitled to ask it, which is a different question from whether this
 * account's data may travel towards a model at all.
 */
describe('the AI switch and the redaction on the way out', () => {
  it('refuses a ticket tool for an account with AI off, and never reads the ticket itself', async () => {
    const { controller, tickets } = harness({ ai: () => switchOff('switch_off') });

    const reply = (await controller.rpc(
      principal(['tickets:view']),
      CTX,
      call('get_ticket', { key: 'CS1000008' }),
    )) as {
      result: { isError: boolean; content: { text: string }[] };
    };

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/AI is switched off for that account/);
    // Once, by the gate, to learn whose switch to read. The tool never ran, so
    // nothing about the ticket beyond which account owns it was looked at.
    expect(tickets.get).toHaveBeenCalledTimes(1);
  });

  /**
   * C-07. The operator kill switch arrives through the same call the account
   * switch does, which is why the MCP needs no switch of its own: one lever
   * already stops every account, and it stops the tools with them.
   */
  it('refuses every tool while the operator kill switch is on, and says which switch it was', async () => {
    const { controller, knowledge } = harness({ ai: () => switchOff('kill_switch') });

    for (const request of [call('get_ticket', { key: 'CS1000008' }), call('search_solutions', { q: 'vpn' })]) {
      const reply = (await controller.rpc(principal(['tickets:view']), CTX, request)) as {
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toMatch(/switched off across the service/);
    }
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  it('masks a credential in what a tool returns, leaving the shape an agent reads', async () => {
    const { controller } = harness({
      tickets: {
        get: vi.fn().mockResolvedValue({
          key: 'CS1000008',
          account_id: 'acc-1',
          state: 'in_progress',
          short_description: 'Reset the sync job, api_key=sk_live_9f2b71c4ad and AKIAIOSFODNN7EXAMPLE',
        }),
      },
    });

    const reply = (await controller.rpc(
      principal(['tickets:view']),
      CTX,
      call('get_ticket', { key: 'CS1000008' }),
    )) as {
      result: { structuredContent: { key: string; state: string; short_description: string } };
    };

    const answer = reply.result.structuredContent;
    expect(answer.short_description).toBe('Reset the sync job, api_key=[redacted:credential] and [redacted:aws_key]');
    // Walked rather than applied to the serialised whole: the fields an agent
    // reads as fields come through intact.
    expect(answer.key).toBe('CS1000008');
    expect(answer.state).toBe('in_progress');
  });

  it('withholds an answer carrying a private key rather than sending a masked one', async () => {
    const { controller } = harness({
      tickets: {
        get: vi.fn().mockResolvedValue({
          key: 'CS1000008',
          account_id: 'acc-1',
          short_description: [
            'Key rotation',
            '-----BEGIN RSA PRIVATE KEY-----',
            'MIIEow==',
            '-----END RSA PRIVATE KEY-----',
          ].join('\n'),
        }),
      },
    });

    const reply = (await controller.rpc(
      principal(['tickets:view']),
      CTX,
      call('get_ticket', { key: 'CS1000008' }),
    )) as {
      result: { isError: boolean; content: { text: string }[] };
    };

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/could not be safely redacted/);
    expect(JSON.stringify(reply)).not.toContain('PRIVATE KEY');
  });

  it('narrows a tool that spans accounts to the ones with AI on', async () => {
    const who = { ...principal(['tickets:view']), accountIds: ['acc-1', 'acc-2', 'acc-3'] } as Principal;
    const { controller, tickets } = harness({
      tickets: { list: vi.fn().mockResolvedValue({ items: [], next_cursor: null, stats: {} }) },
      ai: (accountId) => (accountId === 'acc-2' ? switchOff('switch_off') : switchOn()),
    });

    await controller.rpc(who, CTX, call('list_tickets', { q: 'vpn' }));

    expect(tickets.list).toHaveBeenCalledWith(who, expect.objectContaining({ account_id: ['acc-1', 'acc-3'] }));
  });

  /**
   * Two tools span accounts without taking an account filter, so the switch
   * cannot be pushed down into the query. The answer is confined on the way
   * out instead, rather than the gap being left open.
   */
  it('drops a row belonging to an account with AI off from an answer it could not filter', async () => {
    const who = { ...principal(['tickets:view']), accountIds: ['acc-1', 'acc-2'] } as Principal;
    const { controller } = harness({
      knowledge: {
        search: vi.fn().mockResolvedValue([
          { key: 'KB100001', account_id: 'acc-1', title: 'Reset the VPN profile' },
          { key: 'KB100002', account_id: 'acc-2', title: 'Rotate the gateway certificate' },
          { key: 'KB100003', account_id: null, title: 'The global runbook' },
        ]),
      },
      ai: (accountId) => (accountId === 'acc-2' ? switchOff('switch_off') : switchOn()),
    });

    const reply = (await controller.rpc(who, CTX, call('search_solutions', { q: 'vpn' }))) as {
      result: { structuredContent: { key: string }[] };
    };

    // The global library has no account of its own, so it is not one account's
    // data and it stays.
    expect(reply.result.structuredContent.map((row) => row.key)).toEqual(['KB100001', 'KB100003']);
  });

  it('refuses outright when no account the caller can see has AI on, rather than answering nothing found', async () => {
    const { controller, knowledge } = harness({ ai: () => switchOff('residency') });

    const reply = (await controller.rpc(principal(['tickets:view']), CTX, call('search_solutions', { q: 'vpn' }))) as {
      result: { isError: boolean; content: { text: string }[] };
    };

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/residency/);
    expect(knowledge.search).not.toHaveBeenCalled();
  });

  /**
   * A write is gated the way a read is. An account that turned AI off must not
   * find an AI-authored note on its ticket.
   */
  it('refuses a write to an account with AI off before the note is added', async () => {
    const { controller, tickets } = harness({ ai: () => switchOff('switch_off') });

    const reply = (await controller.rpc(
      principal(['tickets:work']),
      CTX,
      call('add_work_note', { key: 'CS1000008', body: 'Checked the tunnel.' }),
    )) as { result: { isError: boolean } };

    expect(reply.result.isError).toBe(true);
    expect(tickets.addWorkNote).not.toHaveBeenCalled();
  });
});

/**
 * The strict profile only labels names it was handed, so the gate has to hand
 * them over or strict quietly means nothing more than standard. A ticket tool
 * can, because the gate has already read the ticket to find the account.
 */
describe('the strict redaction profile', () => {
  it('labels the requester by role everywhere the name appears, and keeps the label the same', async () => {
    const { controller } = harness({
      tickets: {
        get: vi.fn().mockResolvedValue({
          key: 'CS1000008',
          account_id: 'acc-1',
          requester: { email: 'jo.tan@client.test', display_name: 'Jo Tan' },
          short_description: 'Jo Tan cannot reach the gateway',
          description: 'Raised by jo.tan@client.test after the failover. Jo Tan tried twice.',
        }),
      },
      ai: () => switchOn('strict'),
    });

    const reply = (await controller.rpc(
      principal(['tickets:view']),
      CTX,
      call('get_ticket', { key: 'CS1000008' }),
    )) as {
      result: { structuredContent: { short_description: string; description: string } };
    };

    const answer = reply.result.structuredContent;
    expect(answer.short_description).toBe('[requester] cannot reach the gateway');
    expect(answer.description).toBe('Raised by [requester] after the failover. [requester] tried twice.');
    expect(JSON.stringify(answer)).not.toContain('Jo Tan');
    expect(JSON.stringify(answer)).not.toContain('jo.tan@client.test');
  });

  it('leaves the name alone under the standard profile, which masks credentials only', async () => {
    const { controller } = harness({
      tickets: {
        get: vi.fn().mockResolvedValue({
          key: 'CS1000008',
          account_id: 'acc-1',
          requester: { email: 'jo.tan@client.test', display_name: 'Jo Tan' },
          short_description: 'Jo Tan cannot reach the gateway',
        }),
      },
    });

    const reply = (await controller.rpc(
      principal(['tickets:view']),
      CTX,
      call('get_ticket', { key: 'CS1000008' }),
    )) as {
      result: { structuredContent: { short_description: string } };
    };

    expect(reply.result.structuredContent.short_description).toBe('Jo Tan cannot reach the gateway');
  });
});

/**
 * ADR-16: every guard decision, admin change, export, download and AI egress
 * writes a security event. The MCP is an AI egress and wrote none until
 * 2026-09-13; the Axel adapter had been writing them all along, so the gap was
 * the MCP's alone rather than a missing mechanism.
 */
describe('the security stream', () => {
  it('records a successful tool call as an egress, with what was masked', async () => {
    const { controller, events } = harness({
      tickets: {
        get: vi.fn().mockResolvedValue({
          key: 'CS1000008',
          account_id: 'acc-1',
          short_description: 'Reset the sync job, api_key=sk_live_9f2b71c4ad and AKIAIOSFODNN7EXAMPLE',
        }),
      },
    });

    await controller.rpc(principal(['tickets:view']), CTX, call('get_ticket', { key: 'CS1000008' }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ai.egress.redacted',
      outcome: 'success',
      accountId: 'acc-1',
      // AI-10: the act is the AI's, and who it acted for is still answerable.
      actorKind: 'ai',
      actorId: 'u1',
      actorName: 'Axel (for Ana Costa)',
      principalKind: 'harness',
      entityKind: 'mcp_tool',
      entityId: 'get_ticket',
    });
    expect(events[0]?.attrs).toMatchObject({
      tool: 'get_ticket',
      profile: 'standard',
      masked_matches: { credential: 1, aws_key: 1 },
      confined_rows: 0,
      writes: false,
    });
  });

  it('writes the egress even when nothing needed masking, so the trail has no holes', async () => {
    const { controller, events } = harness({
      tickets: {
        get: vi.fn().mockResolvedValue({ key: 'CS1000008', account_id: 'acc-1', short_description: 'Printer jam' }),
      },
    });

    await controller.rpc(principal(['tickets:view']), CTX, call('get_ticket', { key: 'CS1000008' }));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('ai.egress.redacted');
    expect(events[0]?.attrs).toMatchObject({ masked_matches: {}, confined_rows: 0 });
  });

  it('records a refusal with the rule that caused it, and the account it was about', async () => {
    const { controller, events } = harness({ ai: () => switchOff('switch_off') });

    await controller.rpc(principal(['tickets:view']), CTX, call('get_ticket', { key: 'CS1000008' }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ai.turn.failed',
      outcome: 'withheld',
      accountId: 'acc-1',
      actorKind: 'ai',
      entityId: 'get_ticket',
    });
    expect(events[0]?.attrs).toMatchObject({ code: 'switch_off' });
  });

  it('counts the rows a cross-account answer dropped', async () => {
    const who = { ...principal(['tickets:view']), accountIds: ['acc-1', 'acc-2'] } as Principal;
    const { controller, events } = harness({
      knowledge: {
        search: vi.fn().mockResolvedValue([
          { key: 'KB100001', account_id: 'acc-1', title: 'Reset the VPN profile' },
          { key: 'KB100002', account_id: 'acc-2', title: 'Rotate the gateway certificate' },
        ]),
      },
      ai: (accountId) => (accountId === 'acc-2' ? switchOff('switch_off') : switchOn()),
    });

    await controller.rpc(who, CTX, call('search_solutions', { q: 'vpn' }));

    expect(events[0]?.attrs).toMatchObject({ confined_rows: 1, account_ids: ['acc-1'] });
    // One account is named on the row; a wider scope would live only in attrs.
    expect(events[0]?.accountId).toBe('acc-1');
  });

  it('records a tool that failed in the domain, with the wording the service chose', async () => {
    const { controller, events } = harness({
      tickets: { get: vi.fn().mockRejectedValue(new Error('This ticket is not visible to you.')) },
    });

    await controller.rpc(principal(['tickets:view']), CTX, call('get_ticket', { key: 'CS1000008' }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ai.turn.failed', outcome: 'failed' });
    expect(events[0]?.attrs).toMatchObject({ detail: 'This ticket is not visible to you.' });
  });

  it('writes nothing when the permission guard refused, because no tool ran', async () => {
    const { controller, events } = harness();

    await expect(
      controller.rpc(
        principal(['tickets:work']),
        CTX,
        call('propose_summary', { key: 'CS1000008', summary: 'x', confidence: 0.9 }),
      ),
    ).rejects.toMatchObject({ response: { code: 'forbidden' } });

    expect(events).toHaveLength(0);
  });
});

/**
 * The transport, apart from the protocol. Streamable HTTP is what the catalog
 * row declares, and the harness reaches it through the same SDK client that
 * already talks to the house's other MCP server.
 */
describe('the streamable HTTP transport', () => {
  /** Enough of an express pair to see what the transport did. */
  function http(headers: Record<string, string> = {}) {
    const sent = {
      status: 0,
      headers: {} as Record<string, string>,
      json: undefined as unknown,
      body: '',
      ended: false,
    };
    const response = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      setHeader(name: string, value: string) {
        sent.headers[name] = value;
      },
      json(payload: unknown) {
        sent.json = payload;
        sent.ended = true;
        return this;
      },
      write(chunk: string) {
        sent.body += chunk;
        return true;
      },
      end() {
        sent.ended = true;
      },
    };
    const request = { headers: { 'content-type': 'application/json', ...headers } };
    return { request, response, sent };
  }

  const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize' };

  it('answers a client that accepts SSE with one framed message, which is what the SDK asks for', async () => {
    const { controller } = harness();
    const { request, response, sent } = http({ accept: 'application/json, text/event-stream' });

    await controller.post(principal(['tickets:view']), CTX, request as never, response as never, INIT);

    expect(sent.status).toBe(200);
    expect(sent.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(sent.body).toMatch(/^event: message\ndata: /);
    expect(JSON.parse(sent.body.replace('event: message\ndata: ', '').trim())).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18' },
    });
    expect(sent.ended).toBe(true);
  });

  it('answers a client that does not name SSE with plain JSON', async () => {
    const { controller } = harness();
    const { request, response, sent } = http({ accept: '*/*' });

    await controller.post(principal(['tickets:view']), CTX, request as never, response as never, INIT);

    expect(sent.status).toBe(200);
    expect(sent.headers['content-type']).toBeUndefined();
    expect(sent.json).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18' } });
  });

  /**
   * Stateless on purpose: the bearer carries the identity on every request and
   * the account binding is per transaction, so a session would only add affinity
   * to a service that runs more than one task.
   */
  it('issues no session id, and refuses the calls that would manage one', async () => {
    const { controller } = harness();
    const { request, response, sent } = http({ accept: 'text/event-stream' });

    await controller.post(principal(['tickets:view']), CTX, request as never, response as never, INIT);
    expect(Object.keys(sent.headers).map((h) => h.toLowerCase())).not.toContain('mcp-session-id');

    for (const method of ['stream', 'end'] as const) {
      const refused = http();
      controller[method](refused.response as never);
      expect(refused.sent.status).toBe(405);
      expect(refused.sent.headers.allow).toBe('POST');
    }
  });

  it('acknowledges a notification with 202 and no body, because it asked for no reply', async () => {
    const { controller } = harness();
    const { request, response, sent } = http();

    await controller.post(principal(['tickets:view']), CTX, request as never, response as never, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(sent.status).toBe(202);
    expect(sent.json).toBeUndefined();
    expect(sent.body).toBe('');
    expect(sent.ended).toBe(true);
  });

  it('refuses a body that is not JSON, and a protocol version it does not speak', async () => {
    const { controller } = harness();

    const wrongType = http({ 'content-type': 'text/plain' });
    await controller.post(
      principal(['tickets:view']),
      CTX,
      wrongType.request as never,
      wrongType.response as never,
      INIT,
    );
    expect(wrongType.sent.status).toBe(415);

    const wrongVersion = http({ 'mcp-protocol-version': '2024-01-01' });
    await controller.post(
      principal(['tickets:view']),
      CTX,
      wrongVersion.request as never,
      wrongVersion.response as never,
      INIT,
    );
    expect(wrongVersion.sent.status).toBe(400);
    expect(wrongVersion.sent.json).toMatchObject({ code: 'unsupported_protocol_version' });
  });

  it('accepts the version before the header existed, which a client may still send', async () => {
    const { controller } = harness();
    const { request, response, sent } = http({ 'mcp-protocol-version': '2025-03-26' });

    await controller.post(principal(['tickets:view']), CTX, request as never, response as never, INIT);

    expect(sent.status).toBe(200);
  });

  it('carries a tool call through the transport, gate and all', async () => {
    const { controller, events } = harness({
      tickets: {
        get: vi.fn().mockResolvedValue({ key: 'CS1000008', account_id: 'acc-1', short_description: 'Slow report' }),
      },
    });
    const { request, response, sent } = http({ accept: 'text/event-stream' });

    await controller.post(principal(['tickets:view']), CTX, request as never, response as never, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_ticket', arguments: { key: 'CS1000008' } },
    });

    const framed = JSON.parse(sent.body.replace('event: message\ndata: ', '').trim());
    expect(framed).toMatchObject({ id: 7, result: { structuredContent: { key: 'CS1000008' } } });
    // The transport did not skip the gate: the egress was still recorded.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('ai.egress.redacted');
  });
});
