import { AI_CAPABILITIES, PROMPT_VERSIONS, type AiCapability } from '../../contracts/ai.js';

/**
 * Capability drivers (AI functionality technical section 3): each builds
 * the single-shot request from XMS data already redacted by the caller,
 * names the JSON shape the agent must end with, and says how long the
 * proposal lives. The agents in the harness carry the reasoning prompt;
 * these messages carry the facts and the output contract only, so a prompt
 * change on either side is visible in `prompt_version`.
 */
export interface TicketFacts {
  readonly key: string;
  readonly type: string;
  readonly state: string;
  readonly short_description: string;
  readonly description: string;
  readonly category: string | null;
  readonly impact: string | null;
  readonly urgency: string | null;
  readonly priority: string;
  readonly requester_label: string;
  readonly created_at: string;
  readonly comments: readonly { author: string; kind: string; at: string; body: string }[];
  readonly work_notes: readonly { author: string; at: string; body: string }[];
}

export interface CapabilityContext {
  readonly ticket: TicketFacts;
  readonly categories?: readonly string[];
  readonly candidates?: readonly {
    ticket_id: string;
    key: string;
    short_description: string;
    state: string;
    similarity: number;
  }[];
  readonly tone?: 'plain' | 'formal';
  readonly instruction?: string;
}

export interface BuiltRequest {
  readonly message: string;
  readonly promptVersion: string;
}

const MAX_BODY = 4000;

function clip(text: string, max = MAX_BODY): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} characters]` : text;
}

function ticketBlock(ticket: TicketFacts, includeWorkNotes: boolean): string {
  const lines = [
    `Ticket ${ticket.key} (${ticket.type}, state ${ticket.state}, priority ${ticket.priority})`,
    `Requester: ${ticket.requester_label}`,
    `Created: ${ticket.created_at}`,
    `Category: ${ticket.category ?? 'none'}; impact: ${ticket.impact ?? 'unset'}; urgency: ${ticket.urgency ?? 'unset'}`,
    `Short description: ${ticket.short_description}`,
    'Description:',
    clip(ticket.description || '(none)'),
  ];
  if (ticket.comments.length > 0) {
    lines.push('', 'Conversation (oldest first):');
    for (const comment of ticket.comments.slice(-20)) {
      lines.push(`- [${comment.at}] ${comment.author} (${comment.kind}): ${clip(comment.body, 1500)}`);
    }
  }
  if (includeWorkNotes && ticket.work_notes.length > 0) {
    lines.push('', 'Internal work notes (never quote to the requester):');
    for (const note of ticket.work_notes.slice(-20)) {
      lines.push(`- [${note.at}] ${note.author}: ${clip(note.body, 1500)}`);
    }
  }
  return lines.join('\n');
}

function contract(shape: string): string {
  return [
    '',
    'Answer with a short explanation, then end your reply with exactly one fenced ```json block of this shape and nothing after it:',
    shape,
  ].join('\n');
}

export const CAPABILITY_BUILDERS: Record<AiCapability, ((context: CapabilityContext) => BuiltRequest) | undefined> = {
  classify: (context) => ({
    promptVersion: PROMPT_VERSIONS.classify,
    message: [
      'Classify this support ticket. Choose the category from the list when one fits; otherwise propose a short new one.',
      context.categories?.length ? `Known categories: ${context.categories.join(', ')}` : 'Known categories: none yet',
      '',
      ticketBlock(context.ticket, false),
      contract(
        '{"category": "<text>", "ticket_type": "incident|service_request|change|problem|project_task", "ci_ids": [], "reasons": {"category": "<why>"}, "confidence": 0.0}',
      ),
    ].join('\n'),
  }),
  prioritise: (context) => ({
    promptVersion: PROMPT_VERSIONS.prioritise,
    message: [
      'Assess the impact (how many people or how much of the business is affected) and urgency (how soon it must be fixed) of this ticket. Levels are high, medium, low.',
      '',
      ticketBlock(context.ticket, false),
      contract(
        '{"impact": "high|medium|low", "urgency": "high|medium|low", "reason": "<one or two sentences>", "confidence": 0.0}',
      ),
    ].join('\n'),
  }),
  duplicate: (context) => ({
    promptVersion: PROMPT_VERSIONS.duplicate,
    message: [
      'Decide whether this ticket duplicates one of the candidate tickets from the same account. Only propose merge_into when the candidate describes the same underlying issue; otherwise set it to null.',
      '',
      ticketBlock(context.ticket, false),
      '',
      'Candidates:',
      ...(context.candidates ?? []).map(
        (candidate) =>
          `- ${candidate.ticket_id} ${candidate.key} (${candidate.state}, text similarity ${candidate.similarity.toFixed(2)}): ${candidate.short_description}`,
      ),
      contract(
        '{"candidates": [{"ticket_id": "<uuid>", "similarity": 0.0, "reason": "<why>"}], "merge_into": "<uuid or null>", "confidence": 0.0}',
      ),
    ].join('\n'),
  }),
  summarise: (context) => ({
    promptVersion: PROMPT_VERSIONS.summarise,
    message: [
      'Summarise this ticket for a consultant taking it over. Be concrete and short; say what is unknown rather than guessing.',
      '',
      ticketBlock(context.ticket, true),
      contract(
        '{"situation": "<text>", "done": "<text>", "waiting_on": "<text>", "next_step": "<text>", "risks": "<text>", "sources": {"comments": 0, "work_notes": 0, "events": 0}}',
      ),
    ].join('\n'),
  }),
  draft_reply: (context) => ({
    promptVersion: PROMPT_VERSIONS.draft_reply,
    message: [
      `Draft the next public reply to the requester in a ${context.tone ?? 'plain'} tone. Never reveal internal work notes. Do not promise dates or scope that the conversation does not support.`,
      context.instruction ? `Consultant instruction: ${clip(context.instruction, 1000)}` : '',
      '',
      ticketBlock(context.ticket, true),
      contract('{"text": "<the reply>", "citations": [], "tone": "plain|formal"}'),
    ].join('\n'),
  }),
  wsr_narrative: undefined,
  time_entry: undefined,
  burn_anomaly: undefined,
};

export function isBuilt(capability: string): capability is AiCapability {
  return (
    (AI_CAPABILITIES as readonly string[]).includes(capability) &&
    CAPABILITY_BUILDERS[capability as AiCapability] !== undefined
  );
}
