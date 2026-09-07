import type { HarnessClient, HarnessStream, HarnessTurnRequest } from '../../src/modules/ai/harness-client.js';
import { HarnessUnavailableError } from '../../src/modules/ai/harness-client.js';

/**
 * An in-process harness for the AI suites: scripted SSE turns in the exact
 * wire shape of XT_AXEL_API.md section 4 (envelope, text fragments without
 * a type, thread_created, attachment, [DONE]), delivered in deliberately
 * awkward chunks so the parser is exercised across frame boundaries. Every
 * request is recorded for the contract assertions. No network, no secret.
 */
export interface RecordedRequest {
  readonly agentId: string;
  readonly body: HarnessTurnRequest;
  readonly token: string;
}

export type Script = (agentId: string, body: HarnessTurnRequest) => string | Error;

export function frames(events: (Record<string, unknown> | string)[]): string {
  return events
    .map((event) => (typeof event === 'string' ? `data: ${event}\n\n` : `data: ${JSON.stringify(event)}\n\n`))
    .join('');
}

/** A complete turn: envelope, optional thread, text fragments, [DONE]. */
export function turn(
  text: string,
  options: { streamId?: string; threadId?: string; modelId?: string; attachment?: boolean; error?: string } = {},
): string {
  const events: (Record<string, unknown> | string)[] = [
    {
      type: 'stream_started',
      stream_id: options.streamId ?? 'stream-1',
      model_id: options.modelId ?? 'anthropic.claude-haiku-4-5',
    },
  ];
  if (options.threadId) events.push({ type: 'thread_created', thread_id: options.threadId });
  events.push({ type: 'thinking', content: 'Reading the ticket.' });
  events.push({ type: 'tool_call', toolCall: { id: 't1', name: 'think', args: {} } });
  for (const fragment of split(text, 17)) events.push({ content: fragment });
  if (options.attachment)
    events.push({
      type: 'attachment',
      filename: 'summary.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 3,
      contentBase64: 'AAAA',
    });
  if (options.error) events.push({ type: 'error', error: options.error, code: 'recursion_limit' });
  events.push('[DONE]');
  return `: keepalive\n\n${frames(events)}`;
}

export function proposal(explanation: string, body: Record<string, unknown>): string {
  return `${explanation}\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``;
}

function split(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

export class FakeHarness implements HarnessClient {
  readonly requests: RecordedRequest[] = [];
  readonly cancelled: string[] = [];
  script: Script = () => turn('No proposal here.');

  async stream(agentId: string, body: HarnessTurnRequest, token: string): Promise<HarnessStream> {
    this.requests.push({ agentId, body, token });
    const result = this.script(agentId, body);
    if (result instanceof Error) throw result;
    return { status: 200, chunks: chunked(result) };
  }

  async cancel(streamId: string): Promise<boolean> {
    this.cancelled.push(streamId);
    return true;
  }

  unavailable(status = 503, detail = 'upstream down'): void {
    this.script = () => new HarnessUnavailableError(status, detail);
  }

  reset(): void {
    this.requests.length = 0;
    this.cancelled.length = 0;
    this.script = () => turn('No proposal here.');
  }
}

/** Yields the SSE text in uneven chunks that cut through lines and frames. */
async function* chunked(text: string): AsyncIterable<string> {
  const sizes = [7, 13, 29, 3, 61];
  let index = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const size = sizes[index % sizes.length];
    yield text.slice(cursor, cursor + size);
    cursor += size;
    index += 1;
  }
}
