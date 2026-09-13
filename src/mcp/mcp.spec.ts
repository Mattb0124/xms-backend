import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../common/auth/principal.js';
import type { Permission } from '../contracts/permissions.js';
import type { RequestContext } from '../common/auth/decorators.js';
import type { SuggestionService } from '../modules/ai/suggestion.service.js';
import type { ReportingService } from '../modules/reporting/reporting.service.js';
import type { KnowledgeService } from '../modules/knowledge/knowledge.module.js';
import type { TicketsService } from '../modules/tickets/tickets.service.js';
import type { TimeService } from '../modules/time/time.module.js';
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

function harness(
  overrides: {
    tickets?: Partial<TicketsService>;
    knowledge?: Partial<KnowledgeService>;
    suggestions?: Partial<SuggestionService>;
  } = {},
) {
  const tickets = {
    get: vi.fn(),
    list: vi.fn(),
    comments: vi.fn(),
    workNotes: vi.fn(),
    timeline: vi.fn(),
    addWorkNote: vi.fn(),
    ...overrides.tickets,
  } as unknown as TicketsService;
  const knowledge = { search: vi.fn(), get: vi.fn(), rail: vi.fn(), ...overrides.knowledge } as unknown as KnowledgeService;
  const time = { unlogged: vi.fn() } as unknown as TimeService;
  const suggestions = { propose: vi.fn(), ...overrides.suggestions } as unknown as SuggestionService;
  const reporting = { operations: vi.fn(), account: vi.fn() } as unknown as ReportingService;
  const registry = new ToolRegistry(tickets, knowledge, time, suggestions, reporting);
  return { controller: new McpController(registry), registry, tickets, knowledge, time, suggestions, reporting };
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
    const reply = (await controller.rpc(principal(['tickets:view']), CTX, { jsonrpc: '2.0', id: 1, method: 'initialize' })) as { result: { protocolVersion: string; capabilities: unknown } };
    expect(reply.result.protocolVersion).toBe('2025-06-18');
    expect(reply.result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  /**
   * A tool the caller cannot use is not listed. An agent shown a tool will
   * try it, and a refusal it cannot act on is a turn spent saying no.
   */
  it('lists only the tools the caller holds the permission for', async () => {
    const { controller } = harness();
    const withTickets = (await controller.rpc(principal(['tickets:view']), CTX, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: Array<{ name: string }> } };
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

    const withNothing = (await controller.rpc(principal([]), CTX, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: unknown[] } };
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
    const reply = (await controller.rpc(principal(['tickets:view']), CTX, call('get_ticket', { key: 'CS9999999' }))) as {
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
      call('propose_priority', { key: 'CS1000008', impact: 'high', urgency: 'high', confidence: 0.8, reason: 'Month end.' }),
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
      controller.rpc(principal(['tickets:work']), CTX, call('propose_summary', { key: 'CS1000008', summary: 'x', confidence: 0.9 })),
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
