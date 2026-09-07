/**
 * The loop score (Email Intake & Outbound technical 2.7). Pure over the
 * headers and a few counts the service provides from the recent-window
 * indexes. At or above 100 the message is suppressed; 60 to 99 is processed
 * and flagged.
 */
export interface LoopInput {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly subject: string;
  readonly fromAddress: string;
  readonly references: readonly string[];
  readonly ownMessageIds: ReadonlySet<string>;
  readonly ownSenderAddresses: ReadonlySet<string>;
  readonly senderCountLast10Minutes: number;
  readonly sameSubjectCountLast10Minutes: number;
}

export interface LoopVerdict {
  readonly score: number;
  readonly signals: string[];
  readonly suppress: boolean;
  readonly flagged: boolean;
}

export const SUPPRESS_AT = 100;
export const FLAG_AT = 60;

const AUTO_SUBJECTS = [
  /^automatic reply/i,
  /^auto(?:matic)?[ -]?reply/i,
  /^out of (?:the )?office/i,
  /^autoresponse/i,
  /^abwesenheit/i,
  /^réponse automatique/i,
  /^respuesta automática/i,
  /^ausencia/i,
];

function header(headers: LoopInput['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function scoreLoop(input: LoopInput): LoopVerdict {
  let score = 0;
  const signals: string[] = [];
  const add = (points: number, signal: string): void => {
    score += points;
    signals.push(signal);
  };
  const autoSubmitted = header(input.headers, 'auto-submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') add(100, 'auto_submitted');
  for (const name of ['x-auto-response-suppress', 'x-autoreply', 'x-autorespond']) {
    if (header(input.headers, name)) {
      add(100, name.replace(/^x-/, ''));
      break;
    }
  }
  const precedence = header(input.headers, 'precedence')?.toLowerCase();
  if (precedence && ['bulk', 'list', 'junk'].includes(precedence)) add(100, `precedence_${precedence}`);
  else if (header(input.headers, 'list-id')) add(100, 'list_id');
  const reflected = input.references.filter((reference) => input.ownMessageIds.has(reference)).length;
  if (reflected >= 2) add(80, 'reflected_thread');
  if (input.senderCountLast10Minutes > 10) add(60, 'sender_rate');
  if (input.sameSubjectCountLast10Minutes >= 5) add(40, 'subject_burst');
  if (AUTO_SUBJECTS.some((pattern) => pattern.test(input.subject.trim()))) add(50, 'auto_reply_subject');
  if (input.ownSenderAddresses.has(input.fromAddress.toLowerCase())) add(100, 'self_reflection');
  return { score, signals, suppress: score >= SUPPRESS_AT, flagged: score >= FLAG_AT && score < SUPPRESS_AT };
}
