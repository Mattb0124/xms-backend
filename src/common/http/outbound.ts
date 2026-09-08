import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { endpointProblem, isPrivateAddress, type EndpointProblem } from '../../domain/integrations/webhooks.js';

/**
 * The delivery-time half of the outbound guard (Integrations Patterns, the
 * network section; Security & Tenancy section 9). Registration checks the
 * literal a person typed; this checks what the name actually resolves to at
 * the moment of the call, because a host that passed registration can answer
 * with 127.0.0.1 an hour later. Callers pair it with `redirect: 'manual'`,
 * since the guard cannot follow the request across a hop it never sees, and
 * with `readCappedText`, so a hostile receiver cannot return a body large
 * enough to exhaust a worker.
 */
export type OutboundProblem = EndpointProblem | 'unresolved_host' | 'private_address';

export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

const resolveHost: HostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Registration checks plus the resolved addresses of the host name. */
export async function outboundProblem(
  url: string,
  allowPrivate = false,
  lookup: HostLookup = resolveHost,
): Promise<OutboundProblem | null> {
  const registration = endpointProblem(url, allowPrivate);
  if (registration) return registration;
  if (allowPrivate) return null;
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  // A literal address was already judged as itself; there is nothing to resolve.
  if (isIP(hostname) !== 0) return null;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return 'unresolved_host';
  }
  if (addresses.length === 0) return 'unresolved_host';
  return addresses.some((entry) => isPrivateAddress(entry.address)) ? 'private_address' : null;
}

/** 2 MB is more than any integration answer XMS reads and far less than a worker's headroom. */
export const MAX_OUTBOUND_BODY_BYTES = 2 * 1024 * 1024;

export class OutboundBodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`response body exceeds ${limit} bytes`);
    this.name = 'OutboundBodyTooLarge';
  }
}

/**
 * Reads a response body through a byte cap, cancelling the stream past it.
 *
 * A missing `content-length` is unknown, not zero: `Headers.get` answers
 * `null` for an absent header and a chunked response carries none at all,
 * so the pre-check is skipped and the reader loop is what holds the line.
 * Nothing is ever materialised past the limit, which is the difference
 * between refusing an oversized answer and buying it first.
 */
export async function readCappedBytes(response: Response, limit = MAX_OUTBOUND_BODY_BYTES): Promise<Buffer> {
  const header = response.headers.get('content-length');
  const declared = header === null ? undefined : Number(header);
  if (declared !== undefined && Number.isFinite(declared) && declared > limit) {
    await discardBody(response);
    throw new OutboundBodyTooLarge(limit);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new OutboundBodyTooLarge(limit);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function readCappedText(response: Response, limit = MAX_OUTBOUND_BODY_BYTES): Promise<string> {
  return (await readCappedBytes(response, limit)).toString('utf8');
}

export async function readCappedJson<T>(response: Response, limit = MAX_OUTBOUND_BODY_BYTES): Promise<T> {
  return JSON.parse(await readCappedText(response, limit)) as T;
}

/** Releases a response whose body is of no interest, so the connection is not held open. */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
