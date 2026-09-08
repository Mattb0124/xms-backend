/**
 * Change windows (TM-10, TM-18; Ticket Management functional 5.9 and 5.13).
 * A change window is a named span a tree of tickets belongs to, with freeze
 * windows inside or around it during which nothing may be scheduled. These
 * are the pure rules: no I/O, so the transition gate, the change calendar
 * and the "is this instant inside a window" route all answer the same way.
 *
 * The spec fixes the schedule as an explicit start and end plus freeze
 * windows ("a project or change window has a name, type, schedule (start,
 * end, freeze windows), account, owner and a ticket tree"), so there is no
 * recurrence here: a repeating window is repeated records.
 */
export interface Span {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface FreezeWindow {
  readonly starts_at: string;
  readonly ends_at: string;
  readonly reason?: string;
}

export interface ChangeWindow {
  readonly id: string;
  readonly name: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly freezeWindows: readonly FreezeWindow[];
  readonly status: string;
}

/** Half-open: an instant equal to the end is outside, so back-to-back windows never both hold it. */
export function withinSpan(span: Span, at: Date): boolean {
  return at.getTime() >= span.startsAt.getTime() && at.getTime() < span.endsAt.getTime();
}

export function spansOverlap(a: Span, b: Span): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

/** The window's own span, when it has both ends. A window without one is not schedulable. */
export function spanOf(window: ChangeWindow): Span | null {
  return window.startsAt && window.endsAt ? { startsAt: window.startsAt, endsAt: window.endsAt } : null;
}

/** Is this instant inside the window's span, ignoring freezes (which are a separate answer). */
export function insideWindow(window: ChangeWindow, at: Date): boolean {
  const span = spanOf(window);
  return span !== null && withinSpan(span, at);
}

export function toSpans(freezes: readonly FreezeWindow[]): Span[] {
  return freezes
    .map((freeze) => ({ startsAt: new Date(freeze.starts_at), endsAt: new Date(freeze.ends_at) }))
    .filter((span) => !Number.isNaN(span.startsAt.getTime()) && !Number.isNaN(span.endsAt.getTime()));
}

/** The freeze window covering this instant, if any. */
export function freezeAt(window: ChangeWindow, at: Date): FreezeWindow | undefined {
  return window.freezeWindows.find((freeze) => {
    const span = toSpans([freeze])[0];
    return span !== undefined && withinSpan(span, at);
  });
}

/** The freeze window the whole span runs into, if any (TM-18: scheduling inside a freeze). */
export function freezeOverlapping(window: ChangeWindow, span: Span): FreezeWindow | undefined {
  return window.freezeWindows.find((freeze) => {
    const frozen = toSpans([freeze])[0];
    return frozen !== undefined && spansOverlap(frozen, span);
  });
}

/** A freeze window with no end or an end before its start is not a rule anyone can apply. */
export function freezeProblems(freezes: readonly FreezeWindow[]): string[] {
  const problems: string[] = [];
  freezes.forEach((freeze, index) => {
    const start = Date.parse(freeze.starts_at ?? '');
    const end = Date.parse(freeze.ends_at ?? '');
    if (Number.isNaN(start)) problems.push(`freeze ${index}: starts_at is not a date`);
    if (Number.isNaN(end)) problems.push(`freeze ${index}: ends_at is not a date`);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start)
      problems.push(`freeze ${index}: ends_at must be after starts_at`);
  });
  return problems;
}
