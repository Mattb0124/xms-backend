import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A ServiceNow stand-in (ServiceNow Sync technical 3.8; Integration
 * Patterns section 6): the Table API subset the connector uses, with
 * `sys_updated_on` stamping, journal entries, a dictionary for the CSM and
 * ITSM profiles, an auto-echo mode that re-saves every update to simulate
 * reflections, and fault injection through the control endpoint (429, 500,
 * timeouts, invalid token). In-process for the tests, a process for local
 * development (`pnpm standin`). No fixture here resembles a real client.
 */
export interface StandInOptions {
  readonly username?: string;
  readonly password?: string;
  readonly autoEcho?: boolean;
  readonly profile?: 'csm' | 'itsm';
  readonly now?: () => Date;
  /** 0 (the default) picks a free port; the CLI uses STANDIN_PORT or 3005. */
  readonly port?: number;
}

export interface Fault {
  status?: number;
  times?: number;
  timeoutMs?: number;
  invalidToken?: boolean;
}

export interface StandIn {
  readonly server: Server;
  readonly url: string;
  readonly records: Map<string, Map<string, Record<string, unknown>>>;
  readonly journal: Record<string, unknown>[];
  readonly calls: { method: string; path: string; body?: unknown }[];
  fault: Fault;
  autoEcho: boolean;
  /** Creates a record the way a client user would, stamped at `at`. */
  seed(table: string, body: Record<string, unknown>, at?: Date): Record<string, unknown>;
  addJournal(sysId: string, element: string, value: string, by?: string, at?: Date): Record<string, unknown>;
  close(): Promise<void>;
}

const DICTIONARY: Record<
  'csm' | 'itsm',
  { element: string; mandatory: boolean; internal_type: string; column_label: string }[]
> = {
  csm: [
    { element: 'number', mandatory: false, internal_type: 'string', column_label: 'Number' },
    { element: 'short_description', mandatory: true, internal_type: 'string', column_label: 'Short description' },
    { element: 'description', mandatory: false, internal_type: 'string', column_label: 'Description' },
    { element: 'contact', mandatory: true, internal_type: 'reference', column_label: 'Contact' },
    { element: 'contact.email', mandatory: false, internal_type: 'email', column_label: 'Contact email' },
    { element: 'account', mandatory: false, internal_type: 'reference', column_label: 'Account' },
    { element: 'priority', mandatory: false, internal_type: 'integer', column_label: 'Priority' },
    { element: 'impact', mandatory: false, internal_type: 'integer', column_label: 'Impact' },
    { element: 'urgency', mandatory: false, internal_type: 'integer', column_label: 'Urgency' },
    { element: 'state', mandatory: false, internal_type: 'integer', column_label: 'State' },
    { element: 'category', mandatory: false, internal_type: 'string', column_label: 'Category' },
    { element: 'u_client_reference', mandatory: false, internal_type: 'string', column_label: 'Client reference' },
    { element: 'u_client_notes', mandatory: false, internal_type: 'string', column_label: 'Client notes' },
  ],
  itsm: [
    { element: 'number', mandatory: false, internal_type: 'string', column_label: 'Number' },
    { element: 'short_description', mandatory: true, internal_type: 'string', column_label: 'Short description' },
    { element: 'description', mandatory: false, internal_type: 'string', column_label: 'Description' },
    { element: 'caller_id', mandatory: true, internal_type: 'reference', column_label: 'Caller' },
    { element: 'caller_id.email', mandatory: false, internal_type: 'email', column_label: 'Caller email' },
    { element: 'priority', mandatory: false, internal_type: 'integer', column_label: 'Priority' },
    { element: 'impact', mandatory: false, internal_type: 'integer', column_label: 'Impact' },
    { element: 'urgency', mandatory: false, internal_type: 'integer', column_label: 'Urgency' },
    { element: 'state', mandatory: false, internal_type: 'integer', column_label: 'State' },
    { element: 'category', mandatory: false, internal_type: 'string', column_label: 'Category' },
  ],
};

const PREFIX: Record<string, string> = { sn_customerservice_case: 'CS', incident: 'INC' };

export function stamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function startStandIn(options: StandInOptions = {}): Promise<StandIn> {
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  const journal: Record<string, unknown>[] = [];
  const calls: StandIn['calls'] = [];
  const now = options.now ?? (() => new Date());
  let counter = 1000;
  const state = { fault: {} as Fault, autoEcho: options.autoEcho ?? false };

  const tableOf = (table: string): Map<string, Record<string, unknown>> => {
    let map = records.get(table);
    if (!map) {
      map = new Map();
      records.set(table, map);
    }
    return map;
  };

  const seed = (table: string, body: Record<string, unknown>, at = now()): Record<string, unknown> => {
    counter += 1;
    const record = {
      sys_id: randomUUID().replace(/-/g, ''),
      number: `${PREFIX[table] ?? 'REC'}${String(counter).padStart(7, '0')}`,
      sys_created_on: stamp(at),
      sys_updated_on: stamp(at),
      sys_created_by: 'client.user',
      sys_updated_by: 'client.user',
      state: '1',
      ...body,
    };
    tableOf(table).set(record.sys_id, record);
    return record;
  };

  const addJournal = (
    sysId: string,
    element: string,
    value: string,
    by = 'client.user',
    at = now(),
  ): Record<string, unknown> => {
    const entry = {
      sys_id: randomUUID().replace(/-/g, ''),
      element,
      element_id: sysId,
      value,
      sys_created_on: stamp(at),
      sys_created_by: by,
    };
    journal.push(entry);
    return entry;
  };

  const authorised = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization ?? '';
    if (state.fault.invalidToken) return false;
    if (options.username) {
      const expected = `Basic ${Buffer.from(`${options.username}:${options.password ?? ''}`).toString('base64')}`;
      return header === expected || header.startsWith('Bearer ');
    }
    return header.length > 0;
  };

  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://stand-in');
      const body = raw ? (safeJson(raw) as Record<string, unknown>) : undefined;
      calls.push({ method: request.method ?? 'GET', path: url.pathname + url.search, body });
      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (url.pathname === '/control' && request.method === 'POST') {
        state.fault = (body as Fault) ?? {};
        if (typeof (body as { autoEcho?: boolean })?.autoEcho === 'boolean')
          state.autoEcho = (body as { autoEcho: boolean }).autoEcho;
        json(200, { ok: true, fault: state.fault, autoEcho: state.autoEcho });
        return;
      }
      if (url.pathname === '/oauth_token.do') {
        if (state.fault.invalidToken) {
          json(401, { error: 'invalid_client' });
          return;
        }
        json(200, { access_token: `tok_${randomUUID()}`, expires_in: 1800, token_type: 'Bearer' });
        return;
      }
      if (!authorised(request)) {
        json(401, { error: { message: 'User Not Authenticated' } });
        return;
      }
      // Fault injection: a status for the next N calls, or a timeout.
      if (state.fault.timeoutMs) {
        const wait = state.fault.timeoutMs;
        state.fault = { ...state.fault, times: (state.fault.times ?? 1) - 1 };
        if (state.fault.times! < 0) state.fault = {};
        setTimeout(() => json(200, { result: [] }), wait);
        return;
      }
      if (state.fault.status) {
        const remaining = (state.fault.times ?? 1) - 1;
        const status = state.fault.status;
        state.fault = remaining > 0 ? { ...state.fault, times: remaining } : {};
        json(status, { error: { message: `injected ${status}` } });
        return;
      }

      const match = url.pathname.match(/^\/api\/now\/table\/([a-z0-9_.]+)(?:\/([a-z0-9]+))?$/i);
      if (!match) {
        json(404, { error: { message: 'not found' } });
        return;
      }
      const [, table, sysId] = match;
      const query = url.searchParams.get('sysparm_query') ?? '';
      const limit = Number(url.searchParams.get('sysparm_limit') ?? 200);
      const offset = Number(url.searchParams.get('sysparm_offset') ?? 0);

      if (table === 'sys_dictionary' && request.method === 'GET') {
        const name = /name=([a-z0-9_]+)/i.exec(query)?.[1] ?? '';
        const profile = name === 'incident' ? 'itsm' : (options.profile ?? 'csm');
        json(200, { result: DICTIONARY[profile].map((row) => ({ ...row, name })) });
        return;
      }
      if (table === 'sys_journal_field' && request.method === 'GET') {
        const elementId = /element_id=([a-z0-9]+)/i.exec(query)?.[1];
        const since = /sys_created_on>([0-9-]+ [0-9:]+)/.exec(query)?.[1];
        const rows = journal
          .filter((entry) => entry.element_id === elementId)
          .filter((entry) => !since || String(entry.sys_created_on) > since)
          .sort((a, b) => String(a.sys_created_on).localeCompare(String(b.sys_created_on)))
          .slice(0, limit);
        json(200, { result: rows });
        return;
      }

      const rows = tableOf(table);
      if (request.method === 'GET' && sysId) {
        const record = rows.get(sysId);
        if (!record) json(404, { error: { message: 'No Record found' } });
        else json(200, { result: record });
        return;
      }
      if (request.method === 'GET') {
        json(200, { result: applyQuery([...rows.values()], query).slice(offset, offset + limit) });
        return;
      }
      if (request.method === 'POST') {
        const record = seed(table, {
          ...body,
          sys_created_by: 'xms.integration',
          sys_updated_by: 'xms.integration',
        });
        json(201, { result: record });
        return;
      }
      if (request.method === 'PATCH' && sysId) {
        const record = rows.get(sysId);
        if (!record) {
          json(404, { error: { message: 'No Record found' } });
          return;
        }
        const at = now();
        for (const [key, value] of Object.entries(body ?? {})) {
          if (key === 'comments' || key === 'work_notes') addJournal(sysId, key, String(value), 'xms.integration', at);
          else record[key] = value;
        }
        record.sys_updated_on = stamp(at);
        record.sys_updated_by = 'xms.integration';
        if (state.autoEcho) {
          // A business rule on the client side re-saves the record a moment later.
          record.sys_updated_on = stamp(new Date(at.getTime() + 1000));
          record.sys_updated_by = 'client.rule';
        }
        json(200, { result: record });
        return;
      }
      json(405, { error: { message: 'method not allowed' } });
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    url,
    records,
    journal,
    calls,
    get fault() {
      return state.fault;
    },
    set fault(value: Fault) {
      state.fault = value;
    },
    get autoEcho() {
      return state.autoEcho;
    },
    set autoEcho(value: boolean) {
      state.autoEcho = value;
    },
    seed,
    addJournal,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The encoded query subset: `field>value`, `field=value`, `^OR`, `^ORDERBYfield`, `^ORDERBYDESCfield`. */
export function applyQuery(rows: Record<string, unknown>[], query: string): Record<string, unknown>[] {
  const parts = query.split('^').filter(Boolean);
  const orders: { field: string; desc: boolean }[] = [];
  const groups: { or: boolean; field: string; op: '>' | '<' | '>=' | '<=' | '='; value: string }[] = [];
  for (const part of parts) {
    if (part.startsWith('ORDERBYDESC')) orders.push({ field: part.slice(11), desc: true });
    else if (part.startsWith('ORDERBY')) orders.push({ field: part.slice(7), desc: false });
    else {
      const or = part.startsWith('OR');
      const condition = or ? part.slice(2) : part;
      const match = condition.match(/^([a-z0-9_.]+)(>=|<=|>|<|=)(.*)$/i);
      if (match) groups.push({ or, field: match[1], op: match[2] as '>' | '<' | '>=' | '<=' | '=', value: match[3] });
    }
  }
  // Conditions joined by ^ are AND; ^OR starts an alternative branch: (a AND b) OR (c AND d).
  const branches: (typeof groups)[] = [];
  for (const group of groups) {
    if (group.or || branches.length === 0) branches.push([group]);
    else branches[branches.length - 1].push(group);
  }
  const holds = (row: Record<string, unknown>, condition: (typeof groups)[number]): boolean => {
    const value = String(row[condition.field] ?? '');
    switch (condition.op) {
      case '>':
        return value > condition.value;
      case '<':
        return value < condition.value;
      case '>=':
        return value >= condition.value;
      case '<=':
        return value <= condition.value;
      default:
        return value === condition.value;
    }
  };
  let result =
    branches.length === 0 ? rows : rows.filter((row) => branches.some((branch) => branch.every((c) => holds(row, c))));
  for (const order of orders.reverse()) {
    result = [...result].sort((a, b) => {
      const left = String(a[order.field] ?? '');
      const right = String(b[order.field] ?? '');
      return order.desc ? right.localeCompare(left) : left.localeCompare(right);
    });
  }
  return result;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

if (process.argv[1] && /servicenow-stand-in\.(ts|js)$/.test(process.argv[1])) {
  const standIn = await startStandIn({
    username: 'xms.integration',
    password: 'stand-in',
    profile: 'csm',
    port: Number(process.env.STANDIN_PORT ?? 3005),
  });
  const seeded = standIn.seed('sn_customerservice_case', {
    short_description: 'Consolidation run fails at step 4',
    description: 'Error CE-4102 on the close.',
    contact: { value: 'u1', display_value: 'Pat Client' },
    'contact.email': 'pat.client@brookfield.test',
    impact: '2',
    urgency: '2',
    category: 'finance',
  });
  standIn.addJournal(String(seeded.sys_id), 'comments', 'Any update on this?');
  console.log(
    `ServiceNow stand-in listening on ${standIn.url} (basic xms.integration / stand-in), one case seeded: ${seeded.number}`,
  );
}
