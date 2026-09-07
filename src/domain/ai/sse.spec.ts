import { describe, expect, it } from 'vitest';
import { extractProposal, SseParser, stripProposal } from './sse.js';

const STREAM = [
  'data: {"type":"stream_started","stream_id":"abc123"}\n\n',
  ': keepalive\n\n',
  'data: {"type":"thread_created","thread_id":"thr_9"}\n\n',
  'data: {"content":"Hello, "}\n\n',
  'data: {"content":"world."}\n\n',
  'data: {"type":"tool_call","toolCall":{"id":"1","name":"think","args":{}}}\n\n',
  'data: {"type":"attachment","filename":"deck.pptx","mimeType":"application/x","size":3,"contentBase64":"AAAA"}\n\n',
  'data: not json\n\n',
  'data: [DONE]\n\n',
].join('');

describe('harness SSE parser', () => {
  it('parses the documented frame kinds and ignores comments', () => {
    const parser = new SseParser();
    const frames = parser.push(STREAM);
    expect(frames.map((frame) => frame.type)).toEqual([
      'stream_started',
      'thread_created',
      'text',
      'text',
      'other',
      'attachment',
      'unparsable',
      'done',
    ]);
    expect(frames[0]).toMatchObject({ stream_id: 'abc123' });
    expect(frames[2]).toMatchObject({ content: 'Hello, ' });
    expect(frames[5]).toMatchObject({ filename: 'deck.pptx', contentBase64: 'AAAA' });
  });

  it('is byte-boundary safe: any chunking yields the same frames', () => {
    const whole = new SseParser().push(STREAM);
    for (const size of [1, 2, 5, 11, 64]) {
      const parser = new SseParser();
      const frames = [];
      for (let index = 0; index < STREAM.length; index += size)
        frames.push(...parser.push(STREAM.slice(index, index + size)));
      frames.push(...parser.end());
      expect(frames, `chunk size ${size}`).toEqual(whole);
    }
  });

  it('flushes a trailing frame without a blank line on end()', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"content":"tail"}')).toEqual([]);
    expect(parser.end()).toEqual([{ type: 'text', content: 'tail' }]);
  });

  it('handles CRLF line endings', () => {
    const frames = new SseParser().push('data: {"content":"a"}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(frames).toEqual([{ type: 'text', content: 'a' }, { type: 'done' }]);
  });
});

describe('proposal extraction', () => {
  it('takes the last fenced JSON block', () => {
    const text =
      'Thinking...\n```json\n{"draft": 1}\n```\nFinal:\n```json\n{"category": "VPN", "confidence": 0.9}\n```';
    expect(extractProposal(text)).toEqual({ category: 'VPN', confidence: 0.9 });
    expect(stripProposal(text)).toBe('Thinking...\n```json\n{"draft": 1}\n```\nFinal:');
  });

  it('accepts a bare trailing object and returns undefined without one', () => {
    expect(extractProposal('Answer.\n{"impact": "high"}')).toEqual({ impact: 'high' });
    expect(extractProposal('Just prose, no proposal.')).toBeUndefined();
    expect(extractProposal('```json\n[1,2]\n```')).toBeUndefined();
  });
});
