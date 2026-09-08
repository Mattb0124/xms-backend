import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reply stripping (Email Intake & Outbound technical 2.8): quoted history,
 * signatures and disclaimers are removed from the text body before it
 * becomes a comment. The patterns are data (patterns/*.json) so a new mail
 * client is supported without a code change; every pattern has a corpus
 * sample in test/kit/email.
 */
interface Patterns {
  readonly quote_headers: string[];
  readonly signature_markers: string[];
  readonly disclaimer_lexicon: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
let cached: { quote: RegExp[]; signature: RegExp[]; disclaimer: RegExp[] } | undefined;

function patterns(): NonNullable<typeof cached> {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(here, 'patterns', 'reply-patterns.json'), 'utf8')) as Patterns;
  cached = {
    quote: raw.quote_headers.map((pattern) => new RegExp(pattern, 'im')),
    signature: raw.signature_markers.map((pattern) => new RegExp(pattern, 'im')),
    disclaimer: raw.disclaimer_lexicon.map((pattern) => new RegExp(pattern, 'i')),
  };
  return cached;
}

export interface StripResult {
  readonly text: string;
  readonly removed: { quoted: boolean; signature: boolean; disclaimer: boolean };
}

/**
 * Beyond this the body is quoted history or an attachment transcription,
 * not a reply, and every pattern here is linear in the input.
 */
export const MAX_STRIP_CHARS = 512 * 1024;

export function stripReply(body: string): StripResult {
  const { quote, signature, disclaimer } = patterns();
  let text = body.slice(0, MAX_STRIP_CHARS).replace(/\r\n/g, '\n');
  let quoted = false;
  let sig = false;
  let disc = false;

  // 1. Quoted history: cut at the earliest reply header.
  let cut = -1;
  for (const pattern of quote) {
    const match = text.match(pattern);
    if (match && match.index !== undefined && (cut === -1 || match.index < cut)) cut = match.index;
  }
  // Lines starting with ">" from the first such line to the end.
  // `\s` matches a newline, so `^\s*>` crosses line boundaries and
  // backtracks from every line start on a body that is one long whitespace
  // run: quadratic. A quote marker is always at the start of its own line.
  const firstQuoteLine = text.search(/^[ \t]*>/m);
  if (firstQuoteLine !== -1 && (cut === -1 || firstQuoteLine < cut)) cut = firstQuoteLine;
  if (cut > 0) {
    text = text.slice(0, cut);
    quoted = true;
  }

  // 2. Signature: cut at the first signature marker after the first line.
  let sigCut = -1;
  for (const pattern of signature) {
    const match = text.match(pattern);
    if (match && match.index !== undefined && match.index > 0 && (sigCut === -1 || match.index < sigCut))
      sigCut = match.index;
  }
  if (sigCut > 0) {
    text = text.slice(0, sigCut);
    sig = true;
  }

  // 3. Disclaimers: drop paragraphs over 400 characters that match the lexicon.
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => {
    const long = paragraph.length > 400;
    const matches = disclaimer.some((pattern) => pattern.test(paragraph));
    if (long && matches) {
      disc = true;
      return false;
    }
    return true;
  });
  text = paragraphs
    .join('\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return { text, removed: { quoted, signature: sig, disclaimer: disc } };
}
