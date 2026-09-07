/**
 * Shape check for an SLA policy catalog body (Accounts & Administration
 * technical 3.4): a `targets` map of ticket type to priority to response
 * and resolution minutes, each null or a positive integer, and an optional
 * `calendar` reference. Runs before a default or an account override is
 * activated so a malformed policy never reaches the ticket service.
 */
const PRIORITIES = ['p1', 'p2', 'p3', 'p4'];
const MAX_MINUTES = 60 * 24 * 365;

function isMinutes(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_MINUTES);
}

export function validateSlaPolicy(body: unknown): string[] {
  const problems: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['body must be an object'];
  const policy = body as { targets?: unknown; calendar?: unknown };
  if (policy.calendar !== undefined && (typeof policy.calendar !== 'string' || policy.calendar.length === 0))
    problems.push('calendar must be a non-empty string when present');
  if (!policy.targets || typeof policy.targets !== 'object' || Array.isArray(policy.targets)) {
    problems.push('targets must be an object keyed by ticket type');
    return problems;
  }
  const types = Object.entries(policy.targets as Record<string, unknown>);
  if (types.length === 0) problems.push('targets must name at least one ticket type');
  for (const [type, byPriority] of types) {
    if (!/^[a-z][a-z0-9_]*$/.test(type)) problems.push(`ticket type "${type}" is not a valid key`);
    if (!byPriority || typeof byPriority !== 'object' || Array.isArray(byPriority)) {
      problems.push(`targets.${type} must be an object keyed by priority`);
      continue;
    }
    const priorities = Object.entries(byPriority as Record<string, unknown>);
    if (priorities.length === 0) problems.push(`targets.${type} must name at least one priority`);
    for (const [priority, target] of priorities) {
      if (!PRIORITIES.includes(priority)) problems.push(`targets.${type}.${priority}: unknown priority`);
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        problems.push(`targets.${type}.${priority} must be an object`);
        continue;
      }
      const { response_minutes, resolution_minutes } = target as Record<string, unknown>;
      if (!('response_minutes' in target) || !isMinutes(response_minutes))
        problems.push(`targets.${type}.${priority}.response_minutes must be null or a positive integer of minutes`);
      if (!('resolution_minutes' in target) || !isMinutes(resolution_minutes))
        problems.push(`targets.${type}.${priority}.resolution_minutes must be null or a positive integer of minutes`);
      if (
        typeof response_minutes === 'number' &&
        typeof resolution_minutes === 'number' &&
        response_minutes > resolution_minutes
      )
        problems.push(`targets.${type}.${priority}: response cannot be later than resolution`);
    }
  }
  return problems;
}
