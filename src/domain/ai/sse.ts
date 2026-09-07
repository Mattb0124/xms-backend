/**
 * The harness SSE wire format (XT_AXEL_API.md section 4), parsed
 * incrementally: comment frames are dropped, `data: [DONE]` ends the turn,
 * every other data frame is one JSON event. A frame without a `type` is
 * answer text (`content`). Frames that fail to parse are surfaced as
 * `unparsable` so a contract drift is visible instead of silently dropped.
 */
export type HarnessFrame =
  | { readonly type: 'done' }
  | { readonly type: 'text'; readonly content: string }
  | { readonly type: 'stream_started'; readonly stream_id: string; readonly model_id?: string; readonly build?: string }
  | { readonly type: 'thread_created'; readonly thread_id: string }
  | { readonly type: 'error'; readonly error: string; readonly code?: string }
  | { readonly type: 'cancelled'; readonly reason?: string }
  | {
      readonly type: 'attachment';
      readonly filename: string;
      readonly mimeType: string;
      readonly size: number;
      readonly contentBase64?: string;
      readonly s3Key?: string;
    }
  | { readonly type: 'unparsable'; readonly raw: string }
  | { readonly type: 'other'; readonly event: string; readonly data: Record<string, unknown> };

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];

  /** Feeds a chunk; returns the frames completed by it. */
  push(chunk: string): HarnessFrame[] {
    this.buffer += chunk;
    const frames: HarnessFrame[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line === '') {
        if (this.dataLines.length > 0) {
          frames.push(toFrame(this.dataLines.join('\n')));
          this.dataLines = [];
        }
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    return frames;
  }

  /** Flushes a trailing frame that was not followed by a blank line. */
  end(): HarnessFrame[] {
    const frames: HarnessFrame[] = [];
    if (this.buffer.trim().startsWith('data:')) this.dataLines.push(this.buffer.trim().slice(5).replace(/^ /, ''));
    if (this.dataLines.length > 0) frames.push(toFrame(this.dataLines.join('\n')));
    this.buffer = '';
    this.dataLines = [];
    return frames;
  }
}

function toFrame(data: string): HarnessFrame {
  if (data.trim() === '[DONE]') return { type: 'done' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return { type: 'unparsable', raw: data.slice(0, 500) };
  }
  if (typeof parsed !== 'object' || parsed === null) return { type: 'unparsable', raw: data.slice(0, 500) };
  const type = parsed.type;
  if (type === undefined) {
    return { type: 'text', content: typeof parsed.content === 'string' ? parsed.content : '' };
  }
  switch (type) {
    case 'stream_started':
      return {
        type: 'stream_started',
        stream_id: String(parsed.stream_id ?? ''),
        model_id: parsed.model_id ? String(parsed.model_id) : undefined,
        build: parsed.build ? String(parsed.build) : undefined,
      };
    case 'thread_created':
      return { type: 'thread_created', thread_id: String(parsed.thread_id ?? '') };
    case 'error':
      return {
        type: 'error',
        error: String(parsed.error ?? 'unknown'),
        code: parsed.code ? String(parsed.code) : undefined,
      };
    case 'cancelled':
      return { type: 'cancelled', reason: parsed.reason ? String(parsed.reason) : undefined };
    case 'attachment':
      return {
        type: 'attachment',
        filename: String(parsed.filename ?? 'file'),
        mimeType: String(parsed.mimeType ?? 'application/octet-stream'),
        size: Number(parsed.size ?? 0),
        contentBase64: typeof parsed.contentBase64 === 'string' ? parsed.contentBase64 : undefined,
        s3Key: typeof parsed.s3Key === 'string' ? parsed.s3Key : undefined,
      };
    default:
      return { type: 'other', event: String(type), data: parsed };
  }
}

/**
 * The structured proposal an agent ends its answer with: the last fenced
 * JSON block, or a trailing bare JSON object. Undefined when the answer
 * carries none (the caller withholds with `no_content`).
 */
export function extractProposal(text: string): Record<string, unknown> | undefined {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  const candidates = fences.map((match) => match[1]);
  const trimmed = text.trim();
  if (trimmed.endsWith('}')) {
    const start = trimmed.lastIndexOf('\n{');
    candidates.push(start >= 0 ? trimmed.slice(start + 1) : trimmed);
  }
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Answer text without the proposal block, for display. */
export function stripProposal(text: string): string {
  const match = [...text.matchAll(/```(?:json)?\s*\n[\s\S]*?\n```/g)].at(-1);
  if (!match || match.index === undefined) return text.trim();
  const tail = text.slice(match.index + match[0].length);
  return tail.trim() === '' ? text.slice(0, match.index).trim() : text.trim();
}
