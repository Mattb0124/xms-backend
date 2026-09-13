import { Body, Controller, Delete, ForbiddenException, Get, Injectable, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Authenticated, CurrentPrincipal, RequestCtx, type RequestContext } from '../common/auth/decorators.js';
import type { Principal } from '../common/auth/principal.js';
import { SuggestionService } from '../modules/ai/suggestion.service.js';
import { KnowledgeService } from '../modules/knowledge/knowledge.module.js';
import { ReportingService } from '../modules/reporting/reporting.service.js';
import { TicketsService } from '../modules/tickets/tickets.service.js';
import { TimeService } from '../modules/time/time.module.js';
import { SecurityEventsService } from '../common/events/security-events.service.js';
import { ToolGate, ToolWithheld, emptyTally, type GateScope, type WithheldReason } from './gate.js';
import { buildTools, type McpTool } from './tools.js';

/** JSON-RPC 2.0, the subset the Model Context Protocol uses over streamable HTTP. */
interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * The versions this endpoint speaks. A client that names one we do not is told
 * so rather than served a reply it may misread; a client that names none is
 * assumed to be on the version before the header existed, which is what the
 * specification asks for.
 */
const PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION, '2025-03-26'];

/** Whether a client explicitly named a media type, rather than accepting anything. */
const explicitlyAccepts = (header: string | undefined, type: string): boolean =>
  typeof header === 'string' && header.includes(type);

/** A JSON-RPC error object; the codes are the protocol's own. */
const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

@Injectable()
export class ToolRegistry {
  private readonly tools: Map<string, McpTool>;

  constructor(
    tickets: TicketsService,
    knowledge: KnowledgeService,
    time: TimeService,
    suggestions: SuggestionService,
    reporting: ReportingService,
  ) {
    const tools = buildTools({ tickets, knowledge, time, suggestions, reporting });
    // The gate reads a ticket-scoped tool's account out of the `key` it was
    // given, so a tool declaring that scope without that input would be gated
    // on nothing. Checked at construction, the way the API checks its routes:
    // a tool added without an account to gate on stops the entrypoint booting
    // rather than shipping a hole.
    const ungated = tools.filter((tool) => tool.scope === 'ticket' && !('key' in tool.input));
    if (ungated.length > 0) {
      throw new Error(`Ticket-scoped tools with no key to gate on: ${ungated.map((t) => t.name).join(', ')}`);
    }
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Every tool, in a stable order, for the catalog and for the tests. */
  list(): McpTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): McpTool | undefined {
    return this.tools.get(name);
  }

  /**
   * The tools this caller may use. A tool the caller cannot use is not listed
   * rather than listed and refused: an agent shown a tool will try it, and a
   * refusal it cannot act on is a turn spent saying no.
   */
  visibleTo(principal: Principal): McpTool[] {
    return this.list().filter((tool) => principal.permissions.has(tool.permission));
  }
}

/**
 * The MCP endpoint (ADR-19, AI Integration §4).
 *
 * It is an ordinary guarded controller, and that is the point: the harness
 * session token is resolved by the same `AuthGuard` that resolves a browser's,
 * through the same token verifiers and the same principal repository, writing
 * the same security events. There is no second identity path to keep in step
 * with the first, and no bearer forwarded to a service that resolves it again.
 *
 * `@Authenticated()` rather than one permission: this single route carries
 * every tool, and the permission that matters is the tool's own, declared in
 * the catalog and checked below. A caller holding nothing gets an empty tool
 * list and can call none of them.
 */
@Controller('mcp')
@Authenticated()
export class McpController {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly gate: ToolGate,
    private readonly security: SecurityEventsService,
  ) {}

  /**
   * The security stream's record of one tool call (ADR-16: every AI egress
   * writes a security event; Audit & Analytics 4.1).
   *
   * The actor is `ai`, not the user whose token it is, because AI-10 asks that
   * an AI act be distinguishable from a person's; who it acted for is on
   * `actorId` and `actorName`, so both questions are answerable from one row.
   *
   * Written on a success as well as a refusal, and with a zero tally when
   * nothing needed masking. The event type is the catalog's name for "account
   * data went towards a model", not for "something was masked": a trail that
   * recorded only the calls that happened to carry a credential would be a
   * trail with holes exactly where nobody thought to look.
   */
  private async writeEgress(
    principal: Principal,
    ctx: RequestContext,
    tool: McpTool,
    outcome: 'success' | 'withheld' | 'failed',
    accountIds: readonly string[],
    attrs: Record<string, unknown>,
  ): Promise<void> {
    await this.security.write({
      type: outcome === 'success' ? 'ai.egress.redacted' : 'ai.turn.failed',
      outcome,
      // One account names itself; a tool spanning accounts carries them in
      // attrs rather than pretending the egress belonged to one of them.
      accountId: accountIds.length === 1 ? accountIds[0] : null,
      actorKind: 'ai',
      actorId: principal.userId,
      actorName: `Axel (for ${principal.displayName})`,
      principalKind: principal.kind,
      sessionId: principal.sessionId,
      requestId: ctx.requestId,
      entityKind: 'mcp_tool',
      entityId: tool.name,
      attrs: { tool: tool.name, scope: tool.scope, account_ids: [...accountIds], ...attrs },
    });
  }

  /**
   * Streamable HTTP, the transport the catalog row declares (AI Integration §4).
   *
   * **Stateless: no `Mcp-Session-Id` is issued and none is expected.** The
   * specification makes sessions optional, and this endpoint has nothing to keep
   * in one: the principal is resolved from the bearer on every request by the
   * same guard a browser call uses, and the account binding is set per
   * transaction in the data layer. A session id would add affinity to an ECS
   * service that runs more than one task behind an ALB, so it would need sticky
   * routing or shared state to buy something neither the auth nor the tenancy
   * needs. The house's other MCP server (`onestream_mcp`) runs FastMCP with
   * `stateless_http=True` for the same reason, against the same harness client.
   *
   * **No DNS-rebinding (Origin) check**, deliberately, and for the reason
   * `onestream_mcp` records: that protection targets a browser attacking a
   * localhost-bound dev server, and it 421s every request behind a reverse proxy
   * whose Host varies per environment. Nothing in a browser reaches this route;
   * it is server to server, gated on a bearer the guard verifies. The content
   * type is still checked, because that is the part that matters here.
   *
   * A reply goes back as SSE when the caller explicitly accepts it, which is
   * what the SDK client does and what the house's other server answers with, and
   * as plain JSON otherwise. Both are what the specification allows; nothing
   * here streams in pieces, because a tool call has one answer.
   */
  @Post()
  async post(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: RpcRequest,
  ): Promise<void> {
    const contentType = String(request.headers['content-type'] ?? '');
    if (!contentType.includes('application/json')) {
      response.status(415).json({ code: 'unsupported_media_type', detail: 'POST /mcp takes application/json.' });
      return;
    }

    const version = request.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !PROTOCOL_VERSIONS.includes(version)) {
      response.status(400).json({ code: 'unsupported_protocol_version', supported: PROTOCOL_VERSIONS });
      return;
    }

    const accept = typeof request.headers.accept === 'string' ? request.headers.accept : undefined;
    const wantsStream = explicitlyAccepts(accept, 'text/event-stream');
    const wantsJson = explicitlyAccepts(accept, 'application/json') || explicitlyAccepts(accept, '*/*');
    if (accept !== undefined && !wantsStream && !wantsJson) {
      response
        .status(406)
        .json({ code: 'not_acceptable', detail: 'This route answers application/json or text/event-stream.' });
      return;
    }

    const message = await this.rpc(principal, ctx, body);

    // A notification carries no id and expects no reply, so it is acknowledged
    // rather than answered. Returning a body here would be a response to
    // something that asked for none.
    if (message === null) {
      response.status(202).end();
      return;
    }

    if (wantsStream) {
      response.status(200);
      response.setHeader('content-type', 'text/event-stream; charset=utf-8');
      response.setHeader('cache-control', 'no-cache, no-transform');
      response.setHeader('x-accel-buffering', 'no');
      response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      response.end();
      return;
    }

    response.status(200).json(message);
  }

  /**
   * The specification allows a server that opens no server-to-server stream to
   * refuse the GET, and this one opens none: it declares `listChanged: false`
   * and has no request of its own to make of the agent, so a stream held open
   * for the life of a turn would carry nothing.
   */
  @Get()
  stream(@Res() response: Response): void {
    response.setHeader('allow', 'POST');
    response
      .status(405)
      .json({ code: 'method_not_allowed', detail: 'This endpoint opens no server-to-client stream; POST a request.' });
  }

  /** Nothing to end: the endpoint is stateless and issues no session. */
  @Delete()
  end(@Res() response: Response): void {
    response.setHeader('allow', 'POST');
    response
      .status(405)
      .json({ code: 'method_not_allowed', detail: 'This endpoint is stateless and holds no session to terminate.' });
  }

  /**
   * The JSON-RPC half, kept apart from the transport above so the protocol and
   * the plumbing can be read, and tested, one at a time. Answers `null` for a
   * notification, which the transport turns into a 202.
   */
  async rpc(principal: Principal, ctx: RequestContext, body: RpcRequest): Promise<unknown> {
    const { id = null, method } = body ?? {};
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'xms', version: '1' },
          },
        };

      case 'notifications/initialized':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: this.registry.visibleTo(principal).map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: schemaOf(tool),
            })),
          },
        };

      case 'tools/call':
        return this.call(principal, ctx, id, body.params ?? {});

      default:
        return rpcError(id, -32601, `Unknown method ${String(method)}`);
    }
  }

  /**
   * Which accounts a tool may answer from, and the profile to redact at.
   *
   * A ticket-scoped tool is gated on the one account behind the key it was
   * given. A caller-scoped tool is gated on every account the caller may see
   * that has AI on, and refused outright when none has: an empty list would
   * read to an agent as "nothing found", which is a different answer and an
   * untrue one.
   */
  private async scopeFor(principal: Principal, tool: McpTool, args: Record<string, unknown>): Promise<GateScope> {
    return tool.scope === 'ticket'
      ? this.gate.forTicket(principal, String(args.key ?? ''))
      : this.gate.accountsOn(principal);
  }

  private async call(
    principal: Principal,
    ctx: RequestContext,
    id: RpcRequest['id'],
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = this.registry.get(name);
    if (!tool) return rpcError(id, -32602, `Unknown tool ${name}`);

    // The permission is checked here, before the arguments are even read, so a
    // caller who may not use a tool learns nothing from the shape of its input.
    if (!principal.permissions.has(tool.permission)) {
      throw new ForbiddenException({ code: 'forbidden', permission: tool.permission });
    }

    const parsed = z.object(tool.input).safeParse(params.arguments ?? {});
    if (!parsed.success) {
      return rpcError(id, -32602, parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    let scope: GateScope | undefined;
    try {
      // The switch first, then the tool, then the redaction (AI-11, AI-12).
      // The switch is answered before the tool runs rather than after: reading
      // an account that turned AI off is itself the thing being refused, not
      // just the answer.
      scope = await this.scopeFor(principal, tool, parsed.data as Record<string, unknown>);
      const value = await tool.run(principal, parsed.data, ctx, { accountIds: scope.accountIds });
      // Confined, then redacted, in that order: a row from an account with AI
      // off is dropped before anything is masked, so one such row carrying a
      // private key cannot withhold an answer the caller was entitled to.
      // Across accounts the strictest profile in the set is the one used, so
      // an account asking for strict redaction gets it even in a shared
      // answer. That over-redacts the others, which is the right way to fail.
      const tally = emptyTally();
      const cleaned = this.gate.clean(
        this.gate.confine(value, scope.accountIds, tally),
        scope.profile,
        scope.people,
        tally,
      );
      await this.writeEgress(principal, ctx, tool, 'success', scope.accountIds, {
        profile: scope.profile,
        // Occurrences, not distinct secrets: see EgressTally.
        masked_matches: tally.maskedMatches,
        confined_rows: tally.confined,
        writes: tool.writes === true,
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(cleaned) }],
          structuredContent: cleaned,
        },
      };
    } catch (error) {
      // A withheld turn says which rule withheld it, in the adapter's own
      // vocabulary, so the agent can tell "AI is off for this account" from
      // "that ticket does not exist" and say so to the person.
      if (error instanceof ToolWithheld) {
        await this.writeEgress(
          principal,
          ctx,
          tool,
          'withheld',
          error.accountId ? [error.accountId] : (scope?.accountIds ?? []),
          { code: error.reason },
        );
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: withheldText(error.reason) }] },
        };
      }
      // A refusal the domain already words is returned as a tool error rather
      // than a transport failure, so the agent can say what happened instead
      // of the turn dying. The words are the service's own; nothing here
      // invents a reason or leaks one the caller should not see.
      const message = error instanceof Error ? error.message : 'The tool failed.';
      // The domain refused or broke. Recorded too: a tool that fails on every
      // call is a thing the security dashboard should be able to show, and the
      // wording is the service's own, which the reader is entitled to see.
      await this.writeEgress(principal, ctx, tool, 'failed', scope?.accountIds ?? [], { detail: message });
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } };
    }
  }
}

/** The reason a turn was withheld, worded so an agent can repeat it to a person. */
function withheldText(reason: WithheldReason): string {
  switch (reason) {
    case 'switch_off':
      return 'AI is switched off for that account, so there is nothing I can read there.';
    case 'residency':
      return "That account's data residency requirement is not met, so I cannot read it.";
    case 'kill_switch':
      return 'AI is switched off across the service right now.';
    case 'redaction_refused':
      return 'That answer could not be safely redacted, so it was withheld.';
  }
}

/** The tool's input shape as JSON Schema, which is what the protocol asks for. */
function schemaOf(tool: McpTool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(tool.input)) {
    const type = field instanceof z.ZodOptional ? field.unwrap() : field;
    properties[key] = {
      type: type instanceof z.ZodNumber ? 'number' : type instanceof z.ZodBoolean ? 'boolean' : 'string',
      ...(type.description ? { description: type.description } : {}),
    };
    if (!(field instanceof z.ZodOptional)) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
