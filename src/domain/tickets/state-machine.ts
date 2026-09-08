/**
 * State machines as data (Ticket Management technical 3.1, functional 5.2).
 * A machine is a config version body; this value object validates it and
 * answers the questions the ticket service asks. No I/O.
 */
export type StateKind = 'intake' | 'active' | 'paused' | 'resolved' | 'terminal';

export interface StateEffects {
  /** Entering pauses both SLA clocks; a pause reason is required. */
  readonly pause?: boolean;
  /** Entering marks the response clock met (first In progress). */
  readonly responseMet?: boolean;
  /** Entering stops the resolution clock (resolved, fulfilled, completed, done). */
  readonly resolve?: boolean;
  /**
   * Entering touches production: a change may only enter it inside its
   * change window, or with the override permission and a reason (TM-18).
   */
  readonly deploy?: boolean;
  /** Entering closes the ticket. */
  readonly close?: boolean;
  /** Entering cancels the ticket. */
  readonly cancel?: boolean;
}

export interface StateDefinition {
  readonly key: string;
  readonly label: string;
  readonly kind: StateKind;
  readonly effects?: StateEffects;
}

export type TransitionRequirement =
  | 'pause_reason'
  | 'resolution'
  | 'solution_link'
  | 'time_logged'
  | 'implementation_plan'
  | 'backout_plan'
  | 'validation_notes'
  | 'change_window'
  | 'workaround_article'
  | 'approval';

export interface TransitionDefinition {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly requires?: readonly TransitionRequirement[];
  /** A portal user may perform this transition on a ticket they can see. */
  readonly portal?: boolean;
  /** Marks a reopen: the resolved-at is cleared, the breach latch stays. */
  readonly reopen?: boolean;
}

export interface StateMachineBody {
  readonly type: string;
  readonly initial: string;
  readonly states: readonly StateDefinition[];
  readonly transitions: readonly TransitionDefinition[];
}

export interface TransitionActor {
  readonly kind: 'internal' | 'portal' | 'system';
}

export class StateMachineError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid state machine: ${problems.join('; ')}`);
  }
}

export class StateMachine {
  private readonly stateMap: Map<string, StateDefinition>;
  private readonly byFrom: Map<string, TransitionDefinition[]>;

  constructor(readonly body: StateMachineBody) {
    const problems = validateMachine(body);
    if (problems.length > 0) throw new StateMachineError(problems);
    this.stateMap = new Map(body.states.map((state) => [state.key, state]));
    this.byFrom = new Map();
    for (const transition of body.transitions) {
      const list = this.byFrom.get(transition.from) ?? [];
      list.push(transition);
      this.byFrom.set(transition.from, list);
    }
  }

  get initial(): string {
    return this.body.initial;
  }

  state(key: string): StateDefinition | undefined {
    return this.stateMap.get(key);
  }

  isTerminal(key: string): boolean {
    return this.stateMap.get(key)?.kind === 'terminal';
  }

  transition(from: string, to: string): TransitionDefinition | undefined {
    return this.byFrom.get(from)?.find((candidate) => candidate.to === to);
  }

  canTransition(from: string, to: string, actor: TransitionActor): boolean {
    const found = this.transition(from, to);
    if (!found) return false;
    if (actor.kind === 'portal') return Boolean(found.portal);
    return true;
  }

  /** Transitions available to this actor from a state, in catalog order. */
  available(from: string, actor: TransitionActor): TransitionDefinition[] {
    return (this.byFrom.get(from) ?? []).filter((candidate) => actor.kind !== 'portal' || candidate.portal);
  }

  requirements(from: string, to: string): TransitionRequirement[] {
    return [...(this.transition(from, to)?.requires ?? [])];
  }

  effects(to: string): StateEffects {
    return this.stateMap.get(to)?.effects ?? {};
  }
}

/** Every problem with a machine body, so an editor can show them all at once. */
export function validateMachine(body: StateMachineBody): string[] {
  const problems: string[] = [];
  if (!body || !Array.isArray(body.states) || body.states.length === 0) return ['no states'];
  const keys = new Set<string>();
  for (const state of body.states) {
    if (!/^[a-z][a-z0-9_]*$/.test(state.key)) problems.push(`state key ${state.key} is not snake_case`);
    if (keys.has(state.key)) problems.push(`duplicate state ${state.key}`);
    keys.add(state.key);
  }
  if (!keys.has(body.initial)) problems.push(`initial state ${body.initial} is not defined`);
  const transitions = Array.isArray(body.transitions) ? body.transitions : [];
  const seen = new Set<string>();
  for (const transition of transitions) {
    if (!keys.has(transition.from)) problems.push(`transition from unknown state ${transition.from}`);
    if (!keys.has(transition.to)) problems.push(`transition to unknown state ${transition.to}`);
    if (transition.from === transition.to) problems.push(`self transition on ${transition.from}`);
    const pair = `${transition.from}>${transition.to}`;
    if (seen.has(pair)) problems.push(`duplicate transition ${pair}`);
    seen.add(pair);
  }
  const terminal = body.states.filter((state) => state.kind === 'terminal').map((state) => state.key);
  if (terminal.length === 0) problems.push('no terminal state');
  for (const state of body.states) {
    if (state.kind === 'terminal' && transitions.some((transition) => transition.from === state.key)) {
      problems.push(`terminal state ${state.key} has outgoing transitions`);
    }
    if (
      state.kind === 'paused' &&
      !transitions.filter((t) => t.to === state.key).every((t) => t.requires?.includes('pause_reason'))
    ) {
      problems.push(`transitions into paused state ${state.key} must require pause_reason`);
    }
  }
  // Reachability from the initial state.
  const reachable = new Set<string>();
  const stack = [body.initial];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const transition of transitions) if (transition.from === current) stack.push(transition.to);
  }
  for (const key of keys) if (!reachable.has(key)) problems.push(`state ${key} is unreachable from ${body.initial}`);
  for (const key of terminal) if (!reachable.has(key)) problems.push(`terminal state ${key} is unreachable`);
  return problems;
}
