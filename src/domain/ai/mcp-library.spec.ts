import { describe, expect, it } from 'vitest';
import { enabledServersFor, validateMcpLibrary, type McpLibraryBody } from './mcp-library.js';

const xms = {
  slug: 'xms',
  name: 'XMS',
  transport: 'streamable_http' as const,
  url: 'https://xms-mcp.dev.example/mcp',
  caller_token: true,
};
const onestream = {
  slug: 'onestream-brk',
  name: 'OneStream (Brookfield)',
  transport: 'streamable_http' as const,
  url: 'https://onestream.brk.example/mcp',
  secret_ref: 'xms/dev/mcp/onestream-brk',
};

describe('the MCP library body', () => {
  it('accepts a catalog with its enabled list', () => {
    expect(validateMcpLibrary({ servers: [xms, onestream], enabled: ['xms'] })).toEqual([]);
  });

  it('accepts an account override that carries only the choice', () => {
    expect(validateMcpLibrary({ enabled: ['onestream-brk'] })).toEqual([]);
  });

  it('refuses a body that chooses nothing and defines nothing', () => {
    expect(validateMcpLibrary({})).toContain('body must carry servers, enabled, or both');
  });

  /**
   * The reason the check exists: a configuration body is versioned and diffed
   * into the audit trail, so a token written here is a token wherever that
   * trail is readable.
   */
  it('refuses a literal credential in a header, and names the alternative', () => {
    const problems = validateMcpLibrary({
      servers: [{ ...onestream, headers: { Authorization: 'Bearer sk_live_9f2b71c4ad' } }],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/must be a \$\{PLACEHOLDER\}/);
    expect(problems[0]).toMatch(/secret_ref/);
  });

  it('allows a placeholder in a credential header, and plain text in an ordinary one', () => {
    expect(
      validateMcpLibrary({
        servers: [{ ...onestream, headers: { Authorization: '${ONESTREAM_TOKEN}', 'X-Account': 'BRK' } }],
      }),
    ).toEqual([]);
  });

  it('requires https, because a tool call carries account data and the token that authorises it', () => {
    const problems = validateMcpLibrary({ servers: [{ ...onestream, url: 'http://onestream.brk.example/mcp' }] });
    expect(problems).toContain('servers[0].url must be an https URL');
  });

  it('refuses a duplicate slug and an enabled slug that names nothing', () => {
    expect(validateMcpLibrary({ servers: [xms, xms] })).toContain('servers[1].slug xms is used twice');
    expect(validateMcpLibrary({ servers: [xms], enabled: ['sap'] })).toContain(
      'enabled names sap, which is not in servers',
    );
  });

  it('requires the field the transport actually needs', () => {
    expect(validateMcpLibrary({ servers: [{ slug: 'local', name: 'Local', transport: 'stdio' }] })).toContain(
      'servers[0].command is required for a stdio connection',
    );
  });
});

describe('what one account gets', () => {
  const library: McpLibraryBody = { servers: [xms, onestream], enabled: ['xms'] };

  it('gives an account that has chosen nothing the operator default', () => {
    expect(enabledServersFor(library).servers.map((s) => s.slug)).toEqual(['xms']);
  });

  it('gives an account only what it turned on, from the operator catalog', () => {
    const { servers } = enabledServersFor(library, { enabled: ['xms', 'onestream-brk'] });
    expect(servers.map((s) => s.slug)).toEqual(['xms', 'onestream-brk']);
    // The definition comes from the library, so editing it there reaches every
    // account that enabled it rather than only the next one to be edited.
    expect(servers[1]?.secret_ref).toBe('xms/dev/mcp/onestream-brk');
  });

  it('keeps one client out of the systems belonging to another', () => {
    expect(enabledServersFor(library, { enabled: ['xms'] }).servers.map((s) => s.slug)).toEqual(['xms']);
  });

  /**
   * A connection retired from the library should stop being offered, not stop
   * every account that still lists it from working.
   */
  it('drops a slug the library no longer defines, and names it rather than failing', () => {
    const retired = enabledServersFor({ servers: [xms], enabled: ['xms'] }, { enabled: ['xms', 'onestream-brk'] });
    expect(retired.servers.map((s) => s.slug)).toEqual(['xms']);
    expect(retired.unknown).toEqual(['onestream-brk']);
  });
});

/**
 * The seed is read at boot by `ensureDefaults`, so a malformed one would first
 * be noticed by a failing start rather than by a failing build.
 */
describe('the shipped seed', () => {
  it('is a valid library, and turns on the XMS connection', async () => {
    const seed = (await import('../../config/seeds/mcp.json', { with: { type: 'json' } })).default;
    expect(validateMcpLibrary(seed)).toEqual([]);
    const { servers, unknown } = enabledServersFor(seed as McpLibraryBody);
    expect(servers.map((s) => s.slug)).toEqual(['xms']);
    expect(unknown).toEqual([]);
    // The one connection XMS serves itself authorises with the caller's token
    // and names no secret, because there is none to name.
    expect(servers[0]?.caller_token).toBe(true);
    expect(servers[0]?.secret_ref).toBeNull();
  });
});
