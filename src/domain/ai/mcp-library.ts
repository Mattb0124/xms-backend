/**
 * The MCP library: the connections XMS knows about, and which of them an
 * account gets (AI Integration section 4, ADR-19).
 *
 * A managed-services desk works several clients' estates, and they do not run
 * the same systems. One client has OneStream, the next has SAP, and Axel should
 * reach the one whose ticket is open and nothing else. So the operator keeps a
 * library of MCP connections and turns them on per account, rather than every
 * agent seeing every client's systems.
 *
 * This is the ninth configuration kind rather than a registry of its own, and
 * deliberately: `op.config_defaults` already gives a JSON-seeded operator
 * catalog with versions and activation, `acct.config_overrides` already gives
 * the per-account narrowing, and both already carry the audit, the admin routes
 * under `admin:config` and the Configuration tab that shows a default beside an
 * account's override. A second registry would be a second place to look, a
 * second thing to audit and a second thing to keep in step.
 *
 * **The library holds no secret.** A connection names where a credential lives
 * (`secret_ref`, a Secrets Manager entry) or leaves a `${VAR}` placeholder for
 * the resolver to substitute. Putting a bearer token in a configuration body
 * would put it in the version history, the audit diff and every export of it,
 * which is why `validateMcpLibrary` refuses one rather than trusting the author.
 */

/** How a connection is reached. The two the harness client understands. */
export type McpTransport = 'streamable_http' | 'stdio';

export interface McpServerDefinition {
  /** Stable identifier, and what an account's `enabled` list names. */
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly transport: McpTransport;
  /** `streamable_http` only. */
  readonly url?: string;
  /** `stdio` only. */
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Header and environment templates; values may carry `${VAR}` placeholders. */
  readonly headers?: Record<string, string>;
  readonly env?: Record<string, string>;
  /**
   * Where the credential lives, never the credential. A Secrets Manager name
   * under `xms/<env>/mcp/...`, resolved when a session is opened.
   */
  readonly secret_ref?: string | null;
  /**
   * True where the caller's own token is the authorization, as it is for a
   * connection XMS itself serves. Named for what it means here rather than for
   * the field app-api stores it in (`internalCallerToken`) or the one its
   * `resolve-session` emits (`useCallerToken`), because both of those are that
   * product's vocabulary and this is ours.
   */
  readonly caller_token?: boolean;
}

export interface McpLibraryBody {
  /** The catalog. Present on the operator default; omitted by an account override. */
  readonly servers?: readonly McpServerDefinition[];
  /** The slugs this scope turns on. */
  readonly enabled?: readonly string[];
}

const SLUG = /^[a-z][a-z0-9-]{1,48}$/;

/**
 * Values that must never hold a literal. A placeholder or a secret reference is
 * the only thing allowed through, because a configuration body is versioned,
 * diffed into the audit trail and readable wherever that trail is readable.
 */
const SECRET_ISH = /(secret|token|password|passwd|pwd|api[-_]?key|authorization|bearer)/i;
const PLACEHOLDER_ONLY = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

function checkTemplate(where: string, map: Record<string, string> | undefined, problems: string[]): void {
  for (const [key, value] of Object.entries(map ?? {})) {
    if (typeof value !== 'string') {
      problems.push(`${where}.${key} must be a string`);
      continue;
    }
    // A credential-shaped name may only carry a placeholder. Everything else is
    // free text, because a header like `X-Account: ${ACCOUNT}` is ordinary.
    if (SECRET_ISH.test(key) && !PLACEHOLDER_ONLY.test(value)) {
      problems.push(
        `${where}.${key} must be a \${PLACEHOLDER}, not a literal: a configuration body is versioned and audited, so a credential in it is a credential in the audit trail. Name it in secret_ref instead.`,
      );
    }
  }
}

/** Problems with a library body, empty when it is sound. */
export function validateMcpLibrary(body: unknown): string[] {
  const problems: string[] = [];
  if (!body || typeof body !== 'object') return ['body must be an object'];
  const { servers, enabled } = body as McpLibraryBody;

  if (servers !== undefined) {
    if (!Array.isArray(servers)) return ['servers must be an array'];
    const seen = new Set<string>();
    servers.forEach((server, index) => {
      const at = `servers[${index}]`;
      if (!server || typeof server !== 'object') {
        problems.push(`${at} must be an object`);
        return;
      }
      if (typeof server.slug !== 'string' || !SLUG.test(server.slug)) {
        problems.push(`${at}.slug must be lower-case letters, digits and hyphens`);
      } else if (seen.has(server.slug)) {
        problems.push(`${at}.slug ${server.slug} is used twice`);
      } else {
        seen.add(server.slug);
      }
      if (typeof server.name !== 'string' || server.name.trim() === '') problems.push(`${at}.name is required`);
      if (server.transport !== 'streamable_http' && server.transport !== 'stdio') {
        problems.push(`${at}.transport must be streamable_http or stdio`);
      }
      if (server.transport === 'streamable_http') {
        // https only: a tool call carries account data, and the token that
        // authorises it, to whatever answers this address.
        if (typeof server.url !== 'string' || !/^https:\/\//.test(server.url)) {
          problems.push(`${at}.url must be an https URL`);
        }
        if (server.command) problems.push(`${at}.command belongs to a stdio connection`);
      }
      if (server.transport === 'stdio' && (typeof server.command !== 'string' || server.command.trim() === '')) {
        problems.push(`${at}.command is required for a stdio connection`);
      }
      checkTemplate(`${at}.headers`, server.headers, problems);
      checkTemplate(`${at}.env`, server.env, problems);
      if (server.secret_ref !== undefined && server.secret_ref !== null && typeof server.secret_ref !== 'string') {
        problems.push(`${at}.secret_ref must be a Secrets Manager name or null`);
      }
    });
  }

  if (enabled !== undefined) {
    if (!Array.isArray(enabled) || enabled.some((slug) => typeof slug !== 'string')) {
      return [...problems, 'enabled must be an array of slugs'];
    }
    // Only checked against this body when it carries the catalog. An account
    // override names slugs from the operator library, which is not in scope
    // here; `enabledServersFor` is where an unknown slug is caught, because
    // that is the only place both halves are in hand.
    if (servers !== undefined) {
      const known = new Set(servers.map((server) => server.slug));
      for (const slug of enabled) {
        if (!known.has(slug)) problems.push(`enabled names ${slug}, which is not in servers`);
      }
    }
  }

  if (servers === undefined && enabled === undefined) {
    problems.push('body must carry servers, enabled, or both');
  }
  return problems;
}

/**
 * The connections one account gets: the operator's catalog, narrowed to what
 * that account turned on.
 *
 * The two halves are resolved apart rather than by taking whichever body the
 * override machinery returns. An account override carries `enabled` and not the
 * catalog, because restating every connection per account would mean a library
 * that drifts the moment one entry is edited; the catalog therefore always
 * comes from the operator default and only the choice is the account's. An
 * account that has chosen nothing gets the default's own `enabled` list, which
 * is how a new account starts with the connections the operator considers
 * standard rather than with none.
 *
 * A slug an account enabled that the library no longer defines is dropped and
 * named in `unknown`, rather than failing the turn: a connection retired from
 * the library should stop being offered, not stop every account that still
 * lists it from working.
 */
export function enabledServersFor(
  operatorDefault: McpLibraryBody,
  accountOverride?: McpLibraryBody,
): { servers: McpServerDefinition[]; unknown: string[] } {
  const catalog = operatorDefault.servers ?? [];
  const chosen = accountOverride?.enabled ?? operatorDefault.enabled ?? [];
  const bySlug = new Map(catalog.map((server) => [server.slug, server]));
  const servers: McpServerDefinition[] = [];
  const unknown: string[] = [];
  for (const slug of chosen) {
    const server = bySlug.get(slug);
    if (server) servers.push(server);
    else unknown.push(slug);
  }
  return { servers, unknown };
}
