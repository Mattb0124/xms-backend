/**
 * The single egress to the harness (AI Integration section 3): one HTTP
 * client behind an interface so tests script the stream in process and
 * the contract test drives the real client against a local server that
 * asserts the wire shape. The request body carries only the fields
 * XT_AXEL_API.md section 2 lists (the schema is `extra = "forbid"`), the
 * Origin header is always explicit (the harness sniffs it for its
 * environment), and any non-200 answer is a typed `unavailable`.
 */
export interface HarnessTurnRequest {
  readonly session_id: string;
  readonly message: string;
  readonly thread_id?: string | null;
  readonly opportunity_id?: string | null;
  readonly images?: readonly { data: string; media_type: string; filename: string }[] | null;
}

export interface HarnessStream {
  readonly status: number;
  /** Decoded text chunks of the SSE body. */
  readonly chunks: AsyncIterable<string>;
}

export interface HarnessClient {
  stream(agentId: string, body: HarnessTurnRequest, token: string, signal?: AbortSignal): Promise<HarnessStream>;
  cancel(streamId: string, token: string): Promise<boolean>;
}

export const HARNESS_CLIENT = Symbol('HARNESS_CLIENT');

export class HarnessUnavailableError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`harness unavailable (${status}): ${detail.slice(0, 200)}`);
  }
}

const ALLOWED_FIELDS: readonly (keyof HarnessTurnRequest)[] = [
  'session_id',
  'message',
  'thread_id',
  'opportunity_id',
  'images',
];

/** The exact JSON body sent: allowed keys only, undefined dropped, null kept. */
export function harnessBody(body: HarnessTurnRequest): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ALLOWED_FIELDS) {
    if (body[key] !== undefined) result[key] = body[key];
  }
  return result;
}

export class FetchHarnessClient implements HarnessClient {
  constructor(
    private readonly baseUrl: string,
    private readonly origin: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async stream(agentId: string, body: HarnessTurnRequest, token: string, signal?: AbortSignal): Promise<HarnessStream> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/ai-execution/chat/stream/${encodeURIComponent(agentId)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          origin: this.origin,
        },
        body: JSON.stringify(harnessBody(body)),
        signal,
      });
    } catch (error) {
      throw new HarnessUnavailableError(0, (error as Error).message);
    }
    if (response.status !== 200 || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new HarnessUnavailableError(response.status, detail);
    }
    return { status: response.status, chunks: decode(response.body) };
  }

  async cancel(streamId: string, token: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/ai-execution/chat/stream/${encodeURIComponent(streamId)}/cancel`,
        { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: this.origin } },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

async function* decode(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** A client for deployments without a harness: every call is `unavailable`. */
export class NoHarnessClient implements HarnessClient {
  async stream(): Promise<HarnessStream> {
    throw new HarnessUnavailableError(0, 'HARNESS_BASE_URL is not configured');
  }

  async cancel(): Promise<boolean> {
    return false;
  }
}
