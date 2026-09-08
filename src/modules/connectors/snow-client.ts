import { readCappedJson, readCappedText } from '../../common/http/outbound.js';
import { classifyHttpStatus, type ErrorClass } from '../../domain/sync/rules.js';

/**
 * The ServiceNow Table API subset the connector uses (ServiceNow Sync
 * technical 3.1): query with a watermark, get, journal entries, the
 * dictionary for mapping, create and update for the outbound face. One
 * interface, one HTTP implementation, one stand-in for development and
 * tests. Timestamps cross the wire in ServiceNow's `YYYY-MM-DD HH:MM:SS`
 * UTC form; the client converts at the edge.
 */
export type SnowRecord = Record<string, unknown> & { sys_id: string; sys_updated_on: string };

export interface JournalEntry {
  readonly sys_id: string;
  readonly element: 'comments' | 'work_notes' | string;
  readonly element_id: string;
  readonly value: string;
  readonly sys_created_on: string;
  readonly sys_created_by: string;
}

export interface DictionaryEntry {
  readonly name: string;
  readonly mandatory: boolean;
  readonly type: string;
  readonly label?: string;
}

export interface SnowAuth {
  readonly kind: 'basic' | 'oauth_client_credentials';
  readonly username?: string;
  readonly password?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

export interface SnowClient {
  /** Records updated after the watermark, in (sys_updated_on, sys_id) order. */
  changedSince(table: string, watermark: Date, watermarkSysId: string | null, limit: number): Promise<SnowRecord[]>;
  get(table: string, sysId: string): Promise<SnowRecord | undefined>;
  journal(sysId: string, since: Date | null): Promise<JournalEntry[]>;
  dictionary(table: string): Promise<DictionaryEntry[]>;
  recent(table: string, limit: number): Promise<SnowRecord[]>;
  /** Records opened inside a date range, paged by offset in sys_id order (the migration extractor). */
  range(table: string, from: Date, to: Date, offset: number, limit: number): Promise<SnowRecord[]>;
  create(table: string, body: Record<string, unknown>): Promise<SnowRecord>;
  update(table: string, sysId: string, body: Record<string, unknown>): Promise<SnowRecord>;
  addJournal(table: string, sysId: string, element: 'comments' | 'work_notes', text: string): Promise<JournalEntry>;
}

export class SnowError extends Error {
  readonly errorClass: ErrorClass;

  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`ServiceNow ${status}: ${detail.slice(0, 200)}`);
    this.errorClass = classifyHttpStatus(status);
  }
}

export function toSnowTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function fromSnowTime(value: string | undefined | null): Date {
  if (!value) return new Date(0);
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/** How much of an error body is worth keeping for the run record. */
const ERROR_BODY_BYTES = 8 * 1024;

/**
 * The table and record segments are encoded, so a stored `table_name` can
 * never traverse out of /api/now/table/ or graft a query string on. The DTO
 * allowlist is the first gate; this is the second, at every use.
 */
export function tablePath(table: string, sysId?: string): string {
  const base = `/api/now/table/${encodeURIComponent(table)}`;
  return sysId ? `${base}/${encodeURIComponent(sysId)}` : base;
}

export class HttpSnowClient implements SnowClient {
  private token: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly auth: SnowAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async changedSince(
    table: string,
    watermark: Date,
    watermarkSysId: string | null,
    limit: number,
  ): Promise<SnowRecord[]> {
    const stamp = toSnowTime(watermark);
    const query = watermarkSysId
      ? `sys_updated_on>${stamp}^ORsys_updated_on=${stamp}^sys_id>${watermarkSysId}^ORDERBYsys_updated_on^ORDERBYsys_id`
      : `sys_updated_on>${stamp}^ORDERBYsys_updated_on^ORDERBYsys_id`;
    const result = await this.request<{ result: SnowRecord[] }>('GET', tablePath(table), {
      sysparm_query: query,
      sysparm_limit: String(limit),
      sysparm_display_value: 'all',
    });
    return result.result;
  }

  async get(table: string, sysId: string): Promise<SnowRecord | undefined> {
    try {
      const result = await this.request<{ result: SnowRecord }>('GET', tablePath(table, sysId), {
        sysparm_display_value: 'all',
      });
      return result.result;
    } catch (error) {
      if (error instanceof SnowError && error.status === 404) return undefined;
      throw error;
    }
  }

  async journal(sysId: string, since: Date | null): Promise<JournalEntry[]> {
    const query = since
      ? `element_id=${sysId}^sys_created_on>${toSnowTime(since)}^ORDERBYsys_created_on`
      : `element_id=${sysId}^ORDERBYsys_created_on`;
    const result = await this.request<{ result: JournalEntry[] }>('GET', '/api/now/table/sys_journal_field', {
      sysparm_query: query,
      sysparm_limit: '200',
    });
    return result.result;
  }

  async dictionary(table: string): Promise<DictionaryEntry[]> {
    const result = await this.request<{
      result: { element: string; mandatory: string | boolean; internal_type: string; column_label?: string }[];
    }>('GET', '/api/now/table/sys_dictionary', {
      sysparm_query: `name=${table}^elementISNOTEMPTY`,
      sysparm_limit: '500',
    });
    return result.result.map((row) => ({
      name: row.element,
      mandatory: row.mandatory === true || row.mandatory === 'true',
      type: row.internal_type,
      label: row.column_label,
    }));
  }

  async recent(table: string, limit: number): Promise<SnowRecord[]> {
    const result = await this.request<{ result: SnowRecord[] }>('GET', tablePath(table), {
      sysparm_query: 'ORDERBYDESCsys_updated_on',
      sysparm_limit: String(limit),
      sysparm_display_value: 'all',
    });
    return result.result;
  }

  async range(table: string, from: Date, to: Date, offset: number, limit: number): Promise<SnowRecord[]> {
    const result = await this.request<{ result: SnowRecord[] }>('GET', tablePath(table), {
      sysparm_query: `sys_created_on>=${toSnowTime(from)}^sys_created_on<=${toSnowTime(to)}^ORDERBYsys_id`,
      sysparm_limit: String(limit),
      sysparm_offset: String(offset),
      sysparm_display_value: 'all',
    });
    return result.result;
  }

  async create(table: string, body: Record<string, unknown>): Promise<SnowRecord> {
    return (await this.request<{ result: SnowRecord }>('POST', tablePath(table), {}, body)).result;
  }

  async update(table: string, sysId: string, body: Record<string, unknown>): Promise<SnowRecord> {
    return (await this.request<{ result: SnowRecord }>('PATCH', tablePath(table, sysId), {}, body)).result;
  }

  async addJournal(
    table: string,
    sysId: string,
    element: 'comments' | 'work_notes',
    text: string,
  ): Promise<JournalEntry> {
    await this.update(table, sysId, { [element]: text });
    const entries = await this.journal(sysId, null);
    return entries.filter((entry) => entry.element === element).at(-1)!;
  }

  private async request<T>(
    method: string,
    path: string,
    params: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    headers.authorization = await this.authorization();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        // A ServiceNow instance that answers 3xx is not answering: never
        // carry the connector's Authorization header to a new origin.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      throw new SnowError(0, (error as Error).name === 'AbortError' ? 'timeout' : (error as Error).message);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SnowError(response.status, 'redirect refused');
    }
    if (!response.ok) {
      const detail = await readCappedText(response, ERROR_BODY_BYTES).catch(() => '');
      if (response.status === 401) this.token = undefined;
      throw new SnowError(response.status, detail);
    }
    return readCappedJson<T>(response);
  }

  private async authorization(): Promise<string> {
    if (this.auth.kind === 'basic') {
      return `Basic ${Buffer.from(`${this.auth.username ?? ''}:${this.auth.password ?? ''}`).toString('base64')}`;
    }
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return `Bearer ${this.token.value}`;
    const response = await this.fetchImpl(new URL('/oauth_token.do', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.auth.clientId ?? '',
        client_secret: this.auth.clientSecret ?? '',
      }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) throw new SnowError(response.status, 'redirect refused');
    if (!response.ok)
      throw new SnowError(
        response.status,
        await readCappedText(response, ERROR_BODY_BYTES).catch(() => 'token refused'),
      );
    const token = await readCappedJson<{ access_token: string; expires_in?: number }>(response);
    this.token = { value: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 1800) * 1000 };
    return `Bearer ${this.token.value}`;
  }
}
