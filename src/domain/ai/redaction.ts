/**
 * Redaction before egress (AI Integration section 6; AI functionality
 * technical section 3). Pure functions over text: credential-shaped
 * strings, card and IBAN numbers are masked as `[redacted:<kind>]`; under
 * the strict profile the named people are replaced by role labels with a
 * reversible map the caller keeps in memory only. A payload that still
 * carries a hard-block pattern (a private key block) after masking is
 * refused, and the caller withholds with `redaction_refused`.
 */
export type RedactionProfile = 'standard' | 'strict';

export interface RedactionResult {
  readonly text: string;
  /** Count of masked matches per kind; empty when nothing was masked. */
  readonly counts: Record<string, number>;
  readonly refused: boolean;
  /** Strict profile only: label -> original, for rendering a reply back. */
  readonly roleMap: Record<string, string>;
}

export interface Person {
  readonly email: string;
  readonly name?: string | null;
  readonly role: string;
}

const HARD_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

interface Rule {
  readonly kind: string;
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string | null;
}

const RULES: readonly Rule[] = [
  { kind: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => '[redacted:aws_key]' },
  {
    kind: 'token',
    pattern: /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{8,}=*/g,
    replace: () => 'Bearer [redacted:token]',
  },
  {
    kind: 'token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => '[redacted:token]',
  },
  {
    kind: 'credential',
    pattern:
      /\b(api[_-]?key|secret|password|passwd|pwd|token|client[_-]?secret|access[_-]?key)\b(\s*[:=]\s*)["']?([^\s"',;]{4,})/gi,
    replace: (_match, key: string, separator: string) => `${key}${separator}[redacted:credential]`,
  },
  {
    kind: 'credential',
    pattern: /(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/g,
    replace: (_match, scheme: string) => `${scheme}[redacted:credential]@`,
  },
  {
    kind: 'card',
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    replace: (match) => (luhn(match.replace(/[ -]/g, '')) ? '[redacted:card]' : null),
  },
  {
    kind: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g,
    replace: (match) => (iban(match.replace(/ /g, '')) ? '[redacted:iban]' : null),
  },
];

export function redact(
  input: string,
  profile: RedactionProfile = 'standard',
  people: readonly Person[] = [],
): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      const replacement = rule.replace(match, ...(groups as string[]));
      if (replacement === null) return match;
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      return replacement;
    });
  }
  const roleMap: Record<string, string> = {};
  if (profile === 'strict') {
    const used = new Map<string, number>();
    for (const person of people) {
      const ordinal = (used.get(person.role) ?? 0) + 1;
      used.set(person.role, ordinal);
      const label = ordinal === 1 ? `[${person.role}]` : `[${person.role} ${ordinal}]`;
      roleMap[label] = person.name ? `${person.name} <${person.email}>` : person.email;
      const targets = [person.email, ...(person.name ? [person.name] : [])];
      for (const target of targets) {
        const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const before = text;
        text = text.replace(new RegExp(escaped, 'gi'), label);
        if (before !== text) counts.person = (counts.person ?? 0) + 1;
      }
    }
  }
  return { text, counts, refused: HARD_BLOCK.test(text), roleMap };
}

/** Restores role labels in a reply rendered from a strict-profile turn. */
export function restoreRoles(text: string, roleMap: Record<string, string>): string {
  let result = text;
  for (const [label, original] of Object.entries(roleMap)) {
    result = result.split(label).join(original.replace(/ <.*>$/, ''));
  }
  return result;
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function iban(candidate: string): boolean {
  if (candidate.length < 15 || candidate.length > 34) return false;
  const rearranged = candidate.slice(4) + candidate.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
