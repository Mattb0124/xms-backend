import { describe, expect, it } from 'vitest';
import seeds from '../../config/seeds/state-machines.json' with { type: 'json' };
import { StateMachine, validateMachine, type StateMachineBody } from './state-machine.js';

/**
 * Pins every default transition of the five types (P1.4.5 done-when) and
 * the validation rules an editor relies on (P2.9.1).
 */
const machines = seeds as Record<string, StateMachineBody>;
const TYPES = ['incident', 'service_request', 'change', 'problem', 'project_task'];

describe('default state machines', () => {
  it('defines the five types, each valid', () => {
    expect(Object.keys(machines).sort()).toEqual([...TYPES].sort());
    for (const type of TYPES) expect(validateMachine(machines[type]), type).toEqual([]);
  });

  it.each(TYPES)('%s starts at New and reaches every terminal state', (type) => {
    const machine = new StateMachine(machines[type]);
    expect(machine.initial).toBe('new');
    expect(machine.body.states.filter((state) => state.kind === 'terminal').map((state) => state.key)).toContain(
      'closed',
    );
  });

  it('pins the Incident transitions exactly', () => {
    const machine = new StateMachine(machines.incident);
    const pairs = machine.body.transitions.map((transition) => `${transition.from}>${transition.to}`).sort();
    expect(pairs).toEqual(
      [
        'new>assigned',
        'new>in_progress',
        'new>cancelled',
        'assigned>in_progress',
        'assigned>new',
        'assigned>cancelled',
        'in_progress>awaiting_client',
        'in_progress>awaiting_third_party',
        'in_progress>resolved',
        'in_progress>cancelled',
        'awaiting_client>in_progress',
        'awaiting_client>cancelled',
        'awaiting_third_party>in_progress',
        'resolved>closed',
        'resolved>in_progress',
      ].sort(),
    );
  });

  it('forbids transitions that are not listed', () => {
    const machine = new StateMachine(machines.incident);
    const internal = { kind: 'internal' as const };
    expect(machine.canTransition('new', 'resolved', internal)).toBe(false);
    expect(machine.canTransition('closed', 'in_progress', internal)).toBe(false);
    expect(machine.canTransition('cancelled', 'new', internal)).toBe(false);
    expect(machine.canTransition('awaiting_client', 'resolved', internal)).toBe(false);
  });

  it('lets a portal user only cancel or confirm closure or reopen', () => {
    const machine = new StateMachine(machines.incident);
    const portal = { kind: 'portal' as const };
    expect(machine.canTransition('new', 'cancelled', portal)).toBe(true);
    expect(machine.canTransition('resolved', 'closed', portal)).toBe(true);
    expect(machine.canTransition('resolved', 'in_progress', portal)).toBe(true);
    expect(machine.canTransition('new', 'in_progress', portal)).toBe(false);
    expect(machine.canTransition('in_progress', 'resolved', portal)).toBe(false);
    expect(machine.available('in_progress', portal).map((transition) => transition.to)).toEqual(['cancelled']);
  });

  it('requires the close discipline on every resolving transition', () => {
    for (const type of ['incident', 'service_request', 'problem']) {
      const machine = new StateMachine(machines[type]);
      const resolving = machine.body.transitions.filter((transition) => machine.effects(transition.to).resolve);
      expect(resolving.length, type).toBeGreaterThan(0);
      for (const transition of resolving) {
        expect(transition.requires, `${type} ${transition.from}>${transition.to}`).toEqual(
          expect.arrayContaining(['resolution', 'solution_link', 'time_logged']),
        );
      }
    }
  });

  it('requires a pause reason on every transition into a paused state', () => {
    for (const type of TYPES) {
      const machine = new StateMachine(machines[type]);
      for (const transition of machine.body.transitions) {
        if (machine.effects(transition.to).pause) {
          expect(transition.requires, `${type} ${transition.from}>${transition.to}`).toContain('pause_reason');
        }
      }
    }
  });

  it('marks the response met on the first active state of each type', () => {
    expect(new StateMachine(machines.incident).effects('in_progress').responseMet).toBe(true);
    expect(new StateMachine(machines.problem).effects('investigating').responseMet).toBe(true);
    expect(new StateMachine(machines.change).effects('assessment').responseMet).toBe(true);
  });

  it('flags a reopen transition without clearing anything else', () => {
    const machine = new StateMachine(machines.incident);
    expect(machine.transition('resolved', 'in_progress')?.reopen).toBe(true);
    expect(machine.transition('resolved', 'closed')?.reopen).toBeUndefined();
  });
});

describe('validateMachine', () => {
  const base = machines.incident;

  it('rejects an unreachable terminal state and names it', () => {
    const body: StateMachineBody = {
      ...base,
      transitions: base.transitions.filter((transition) => transition.to !== 'closed'),
    };
    expect(validateMachine(body)).toEqual(
      expect.arrayContaining(['state closed is unreachable from new', 'terminal state closed is unreachable']),
    );
  });

  it('rejects a transition to an unknown state', () => {
    const body: StateMachineBody = { ...base, transitions: [...base.transitions, { from: 'new', to: 'limbo' }] };
    expect(validateMachine(body)).toContain('transition to unknown state limbo');
    expect(() => new StateMachine(body)).toThrow(/limbo/);
  });

  it('rejects outgoing transitions from a terminal state', () => {
    const body: StateMachineBody = { ...base, transitions: [...base.transitions, { from: 'closed', to: 'new' }] };
    expect(validateMachine(body)).toContain('terminal state closed has outgoing transitions');
  });

  it('rejects a paused state entered without a pause reason', () => {
    const body: StateMachineBody = {
      ...base,
      transitions: base.transitions.map((transition) =>
        transition.to === 'awaiting_client' ? { ...transition, requires: [] } : transition,
      ),
    };
    expect(validateMachine(body)).toContain('transitions into paused state awaiting_client must require pause_reason');
  });
});
