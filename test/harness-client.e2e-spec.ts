import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchHarnessClient, harnessBody, HarnessUnavailableError } from '../src/modules/ai/harness-client.js';
import { consume } from '../src/modules/ai/suggestion.service.js';
import { turn } from './kit/harness.js';

/**
 * The harness contract test (AI Integration section 7; P1.7.4): the real
 * HTTP client against a local server that enforces the wire shape of
 * XT_AXEL_API.md, so a schema drift on either side fails here, not in a
 * pilot. The server refuses, like the harness does with `extra="forbid"`,
 * any body field outside the published list, and answers the recorded
 * fixture stream in chunks.
 */
const ALLOWED = new Set(['session_id', 'message', 'thread_id', 'opportunity_id', 'images']);

let server: Server;
let baseUrl: string;
const seen: { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    request.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path: request.url ?? '', headers: request.headers, body });
      if (request.url?.endsWith('/cancel')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ cancelled: true }));
        return;
      }
      if (!request.headers.authorization?.startsWith('Bearer ')) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: 'Not authenticated' }));
        return;
      }
      const extra = Object.keys(body).filter((key) => !ALLOWED.has(key));
      if (extra.length > 0 || typeof body.session_id !== 'string' || typeof body.message !== 'string') {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ detail: [{ loc: ['body', extra[0] ?? 'message'], msg: 'extra fields not permitted' }] }),
        );
        return;
      }
      if (body.message === 'drift') {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: [{ loc: ['body', 'message'], msg: 'extra fields not permitted' }] }));
        return;
      }
      if (request.url?.includes('/down')) {
        response.writeHead(503);
        response.end('maintenance');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const stream = turn('Streamed answer.\n```json\n{"category":"Net","confidence":0.8}\n```', {
        streamId: 'srv-1',
        threadId: String(body.thread_id ?? '') || undefined,
      });
      let cursor = 0;
      const tick = (): void => {
        if (cursor >= stream.length) {
          response.end();
          return;
        }
        response.write(stream.slice(cursor, cursor + 23));
        cursor += 23;
        setTimeout(tick, 1);
      };
      tick();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('FetchHarnessClient against the wire contract', () => {
  it('posts to the chat stream route with bearer, Origin and Accept, and drains the SSE body', async () => {
    const client = new FetchHarnessClient(baseUrl, 'http://xms.test');
    const stream = await client.stream(
      'xms-triage',
      { session_id: 'sess-1', message: 'hi', thread_id: 'thr-1', opportunity_id: 'solution:xms', images: undefined },
      'token-abc',
    );
    expect(stream.status).toBe(200);
    const outcome = await consume(stream.chunks);
    expect(outcome.streamId).toBe('srv-1');
    expect(outcome.threadId).toBe('thr-1');
    expect(outcome.content).toContain('Streamed answer.');
    expect(outcome.error).toBeUndefined();
    const sent = seen.at(-1)!;
    expect(sent.path).toBe('/api/ai-execution/chat/stream/xms-triage');
    expect(sent.headers.authorization).toBe('Bearer token-abc');
    expect(sent.headers.origin).toBe('http://xms.test');
    expect(sent.headers.accept).toBe('text/event-stream');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(Object.keys(sent.body).sort()).toEqual(['message', 'opportunity_id', 'session_id', 'thread_id']);
  });

  it('never sends a field outside the published schema', () => {
    const body = harnessBody({
      session_id: 's',
      message: 'm',
      thread_id: null,
      ...({ tenant_slug: 'x', account_id: 'y' } as object),
    } as never);
    expect(Object.keys(body).sort()).toEqual(['message', 'session_id', 'thread_id']);
    expect(body.thread_id).toBeNull();
  });

  it('turns a 401, a 422 and a 503 into a typed unavailable error carrying the body', async () => {
    const client = new FetchHarnessClient(baseUrl, 'http://xms.test');
    await expect(client.stream('xms-triage', { session_id: 's', message: 'm' }, '')).rejects.toMatchObject({
      status: 401,
    });
    const drift = client.stream('xms-triage', { session_id: 's', message: 'drift' }, 't');
    await expect(drift).rejects.toBeInstanceOf(HarnessUnavailableError);
    await expect(drift).rejects.toMatchObject({ status: 422, detail: expect.stringContaining('extra fields') });
    await expect(client.stream('down', { session_id: 's', message: 'm' }, 't')).rejects.toMatchObject({
      status: 503,
      detail: 'maintenance',
    });
  });

  it('reports a network failure as unavailable with status 0 and cancels through the cancel route', async () => {
    const dead = new FetchHarnessClient('http://127.0.0.1:1', 'http://xms.test');
    await expect(dead.stream('x', { session_id: 's', message: 'm' }, 't')).rejects.toMatchObject({ status: 0 });
    const client = new FetchHarnessClient(baseUrl, 'http://xms.test');
    expect(await client.cancel('srv-1', 't')).toBe(true);
    expect(seen.at(-1)!.path).toBe('/api/ai-execution/chat/stream/srv-1/cancel');
    expect(await dead.cancel('srv-1', 't')).toBe(false);
  });
});
