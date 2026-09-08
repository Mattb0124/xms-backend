/**
 * Request form definitions and submissions (CP-03; Client Portal functional
 * 5.4 step 3, technical 2.2 and 2.7).
 *
 * Pure rules, no database and no HTTP: a form definition is a list of fields
 * with a closed vocabulary of kinds, each mapping to a ticket column or to a
 * key of the ticket's `form_data`; a submission is the answers a client gave.
 * The same file answers "is this definition sound" when the operator saves a
 * draft and "is this submission valid" when a client posts it, so the builder
 * cannot author a form the server would then refuse, and the browser's copy
 * of the rules is a mirror rather than a second opinion.
 */

export const FORM_FIELD_KINDS = [
  'short_text',
  'long_text',
  'choice',
  'multi_choice',
  'date',
  'number',
  'boolean',
  'ci_picker',
  'contact_picker',
  'urgency',
  'impact',
  'attachment',
] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

/**
 * Ticket columns a form field may write. Everything else lands in
 * `form_data`. The configuration item is here since TM-19: the ticket
 * service asserts that a posted id is a configuration item of that ticket's
 * account before it writes the column, so a `ci_picker` answer maps onto
 * the column instead of being kept as an answer.
 */
export const FORM_TICKET_COLUMNS = [
  'short_description',
  'description',
  'category',
  'impact',
  'urgency',
  'configuration_item_id',
] as const;
export type FormTicketColumn = (typeof FORM_TICKET_COLUMNS)[number];

/** Which columns each kind may write. A kind absent from a list writes `custom.<key>` only. */
const COLUMNS_BY_KIND: Record<FormFieldKind, readonly FormTicketColumn[]> = {
  short_text: ['short_description', 'category'],
  long_text: ['description'],
  choice: ['category'],
  multi_choice: [],
  date: [],
  number: [],
  boolean: [],
  ci_picker: ['configuration_item_id'],
  contact_picker: [],
  urgency: ['urgency'],
  impact: ['impact'],
  attachment: [],
};

/** The kinds whose answer a later field may depend on. */
const CONDITIONABLE: readonly FormFieldKind[] = ['choice', 'multi_choice', 'boolean', 'urgency', 'impact'];

export const LEVELS = ['high', 'medium', 'low'] as const;

export interface FormFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FormFieldCondition {
  readonly field: string;
  readonly equals: string | number | boolean;
}

export interface FormField {
  readonly key: string;
  readonly kind: FormFieldKind;
  readonly label: string;
  readonly help?: string;
  readonly required?: boolean;
  readonly options?: readonly FormFieldOption[];
  readonly visible_when?: FormFieldCondition;
  readonly maps_to: string;
}

export interface FormDefinition {
  readonly fields: readonly FormField[];
}

/** One worded refusal: which field, what is wrong with it, in the client's words. */
export interface FormProblem {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface MappedSubmission {
  /** Values for the ticket's own columns. */
  readonly columns: Record<string, unknown>;
  /** Everything else, stored on the ticket as `form_data`. */
  readonly custom: Record<string, unknown>;
  /** The keys of the fields a condition hid, so the caller can say what was skipped. */
  readonly hidden: readonly string[];
}

/** How many problems a refusal words before it says how many more there are. */
export const MAX_PROBLEMS = 50;

/** How many fields a form takes, and how long a piece of its wording may be. */
export const MAX_FIELDS = 60;
const MAX_LABEL = 160;

const KEY = /^[a-z][a-z0-9_]{0,60}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether a definition is one the server can enforce (technical 2.7): every
 * field maps somewhere it is allowed to write, a condition names a field
 * already asked, urgency and impact are both offered or neither, and there is
 * at most one attachment field. Returns the problems in the order they were
 * found; an empty list means the definition is sound.
 */
export function definitionProblems(definition: unknown): FormProblem[] {
  const problems: FormProblem[] = [];
  const fields = (definition as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) {
    return [{ field: 'fields', code: 'not_a_list', message: 'a form definition needs a list of fields' }];
  }
  if (fields.length === 0)
    problems.push({ field: 'fields', code: 'empty', message: 'a form needs at least one field' });
  // Returning here rather than walking on: an `admin:config` caller who
  // posts a very large `fields` array otherwise gets a proportionally large
  // 400 for a form that was refused on its first line.
  if (fields.length > MAX_FIELDS)
    return [{ field: 'fields', code: 'too_many', message: `a form takes at most ${MAX_FIELDS} fields` }];

  const seenKeys = new Set<string>();
  const seenTargets = new Set<string>();
  const byKey = new Map<string, FormField>();
  let attachments = 0;

  for (const [index, raw] of fields.entries()) {
    const field = raw as Partial<FormField> | null;
    const key = typeof field?.key === 'string' ? field.key : `field ${index + 1}`;
    if (typeof field?.key !== 'string' || !KEY.test(field.key) || key in Object.prototype) {
      problems.push({
        field: key,
        code: 'bad_key',
        // `constructor` matches the pattern and is a name every object
        // already answers to, so a form keyed on one could never be
        // submitted and the refusal it gave said the wrong thing.
        message: 'a field key is lower case letters, digits and underscores, starting with a letter',
      });
      continue;
    }
    if (seenKeys.has(field.key)) {
      problems.push({ field: key, code: 'duplicate_key', message: `two fields share the key "${field.key}"` });
      continue;
    }
    seenKeys.add(field.key);

    const kind = field.kind as FormFieldKind;
    if (!FORM_FIELD_KINDS.includes(kind)) {
      problems.push({ field: key, code: 'bad_kind', message: `"${String(field.kind)}" is not a field kind` });
      continue;
    }
    byKey.set(field.key, field as FormField);
    if (kind === 'attachment') attachments += 1;

    if (typeof field.label !== 'string' || field.label.trim().length === 0 || field.label.length > MAX_LABEL)
      problems.push({
        field: key,
        code: 'bad_label',
        message: `a field needs a label of 1 to ${MAX_LABEL} characters`,
      });
    if (field.help !== undefined && (typeof field.help !== 'string' || field.help.length > 400))
      problems.push({ field: key, code: 'bad_help', message: 'help text is at most 400 characters' });

    const wantsOptions = kind === 'choice' || kind === 'multi_choice';
    const options = field.options;
    if (wantsOptions) {
      if (!Array.isArray(options) || options.length === 0 || options.length > 50)
        problems.push({ field: key, code: 'bad_options', message: 'a choice field needs 1 to 50 options' });
      else {
        const values = new Set<string>();
        for (const option of options) {
          if (typeof option?.value !== 'string' || option.value.length === 0 || option.value.length > 120)
            problems.push({ field: key, code: 'bad_option', message: 'every option needs a value' });
          else if (values.has(option.value))
            problems.push({ field: key, code: 'duplicate_option', message: `two options share "${option.value}"` });
          else values.add(option.value);
          if (typeof option?.label !== 'string' || option.label.trim().length === 0 || option.label.length > MAX_LABEL)
            problems.push({
              field: key,
              code: 'bad_option',
              message: `every option needs a label of 1 to ${MAX_LABEL} characters`,
            });
        }
      }
    } else if (options !== undefined) {
      problems.push({ field: key, code: 'options_not_allowed', message: `a ${kind} field carries no options` });
    }

    const target = field.maps_to;
    if (typeof target !== 'string' || target.length === 0) {
      problems.push({ field: key, code: 'missing_maps_to', message: 'every field says where its answer goes' });
    } else if (target.startsWith('custom.')) {
      const customKey = target.slice('custom.'.length);
      if (!KEY.test(customKey))
        problems.push({ field: key, code: 'bad_maps_to', message: `"${target}" is not a usable custom key` });
    } else if (!(FORM_TICKET_COLUMNS as readonly string[]).includes(target)) {
      problems.push({ field: key, code: 'bad_maps_to', message: `"${target}" is not a ticket field a form may write` });
    } else if (!COLUMNS_BY_KIND[kind].includes(target as FormTicketColumn)) {
      problems.push({ field: key, code: 'bad_maps_to', message: `a ${kind} field cannot write "${target}"` });
    }
    if (typeof target === 'string' && target.length > 0) {
      if (seenTargets.has(target))
        problems.push({ field: key, code: 'duplicate_maps_to', message: `two fields write "${target}"` });
      seenTargets.add(target);
    }

    const condition = field.visible_when;
    if (condition !== undefined) {
      const controller = typeof condition?.field === 'string' ? byKey.get(condition.field) : undefined;
      if (!controller || controller.key === field.key)
        problems.push({
          field: key,
          code: 'bad_condition',
          message: 'a condition names a field asked earlier on the same form',
        });
      else if (!CONDITIONABLE.includes(controller.kind))
        problems.push({
          field: key,
          code: 'bad_condition',
          message: `a condition cannot read a ${controller.kind} field`,
        });
      else if (!conditionValueAllowed(controller, condition.equals))
        problems.push({
          field: key,
          code: 'bad_condition',
          message: `"${String(condition.equals)}" is not an answer "${controller.key}" can have`,
        });
    }
  }

  if (attachments > 1)
    problems.push({
      field: 'fields',
      code: 'too_many_attachments',
      message: 'a form takes at most one attachment field',
    });
  const hasUrgency = [...byKey.values()].some((field) => field.kind === 'urgency');
  const hasImpact = [...byKey.values()].some((field) => field.kind === 'impact');
  if (hasUrgency !== hasImpact)
    problems.push({
      field: 'fields',
      code: 'urgency_impact_pair',
      message: 'a form asks for urgency and impact together or for neither',
    });
  for (const field of byKey.values())
    if (field.required && field.kind === 'attachment')
      problems.push({
        field: field.key,
        code: 'required_attachment',
        message: 'an attachment field cannot be required',
      });
  return problems;
}

function conditionValueAllowed(controller: FormField, equals: unknown): boolean {
  if (controller.kind === 'boolean') return typeof equals === 'boolean';
  if (controller.kind === 'urgency' || controller.kind === 'impact')
    return typeof equals === 'string' && (LEVELS as readonly string[]).includes(equals);
  return typeof equals === 'string' && (controller.options ?? []).some((option) => option.value === equals);
}

/**
 * Whether a submission satisfies a published definition, and what it maps to.
 * A field a condition hides is not asked and not stored, even when the client
 * sent an answer for it; an answer for a field the form does not have is a
 * refusal, not something to quietly keep.
 */
export function validateSubmission(
  definition: FormDefinition,
  answers: Record<string, unknown>,
): { problems: FormProblem[]; mapped: MappedSubmission } {
  const problems: FormProblem[] = [];
  const columns: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const hidden: string[] = [];
  const visible = new Map<string, unknown>();

  for (const field of definition.fields) {
    if (field.visible_when && !conditionHolds(field.visible_when, visible)) {
      hidden.push(field.key);
      continue;
    }
    const answer = Object.hasOwn(answers, field.key) ? answers[field.key] : undefined;
    if (isBlank(answer)) {
      if (field.required)
        problems.push({ field: field.key, code: 'required', message: `"${field.label}" is required` });
      visible.set(field.key, undefined);
      continue;
    }
    const problem = kindProblem(field, answer);
    if (problem) {
      problems.push(problem);
      visible.set(field.key, undefined);
      continue;
    }
    visible.set(field.key, answer);
    if (field.maps_to.startsWith('custom.')) {
      custom[field.maps_to.slice('custom.'.length)] = answer;
      continue;
    }
    // The allowlist is applied again where the write happens, not only
    // where the definition was saved. Nothing today spreads
    // `mapped.columns`, and this is what keeps that from being the thing
    // that has to stay true.
    if (!columnAllowed(field.kind, field.maps_to)) {
      problems.push({
        field: field.key,
        code: 'bad_maps_to',
        message: `a ${field.kind} field cannot write "${field.maps_to}"`,
      });
      continue;
    }
    columns[field.maps_to] = answer;
  }

  // One problem per unrecognised key, capped. A body of many thousands of
  // short keys sits inside the global 1 MB limit and used to come back as a
  // multi-megabyte 400, which is CPU and egress amplification against the
  // one principal that composes the object shape.
  const known = new Set(definition.fields.map((field) => field.key));
  let unknown = 0;
  for (const key of Object.keys(answers)) {
    if (known.has(key)) continue;
    unknown += 1;
    if (unknown > MAX_PROBLEMS) continue;
    problems.push({ field: key, code: 'unknown_field', message: `"${key}" is not a field on this form` });
  }
  if (unknown > MAX_PROBLEMS)
    problems.push({
      field: 'answers',
      code: 'too_many_unknown_fields',
      message: `${unknown} keys are not fields on this form; the first ${MAX_PROBLEMS} are listed`,
    });

  return { problems, mapped: { columns, custom, hidden } };
}

/** Whether a kind may write a ticket column, the same rule the definition was saved under. */
function columnAllowed(kind: FormFieldKind, target: string): boolean {
  return (
    (FORM_TICKET_COLUMNS as readonly string[]).includes(target) &&
    COLUMNS_BY_KIND[kind].includes(target as FormTicketColumn)
  );
}

function conditionHolds(condition: FormFieldCondition, visible: Map<string, unknown>): boolean {
  if (!visible.has(condition.field)) return false;
  const answer = visible.get(condition.field);
  if (Array.isArray(answer)) return answer.includes(condition.equals);
  return answer === condition.equals;
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function kindProblem(field: FormField, answer: unknown): FormProblem | undefined {
  const bad = (message: string, code = 'bad_value'): FormProblem => ({ field: field.key, code, message });
  const values = (field.options ?? []).map((option) => option.value);
  switch (field.kind) {
    case 'short_text':
      return typeof answer === 'string' && answer.length <= 300 ? undefined : bad(`"${field.label}" is short text`);
    case 'long_text':
      return typeof answer === 'string' && answer.length <= 50_000 ? undefined : bad(`"${field.label}" is text`);
    case 'choice':
      return typeof answer === 'string' && values.includes(answer)
        ? undefined
        : bad(`"${field.label}" is not one of the offered answers`, 'not_an_option');
    case 'multi_choice': {
      if (!Array.isArray(answer)) return bad(`"${field.label}" takes a list of answers`);
      if (answer.length > values.length) return bad(`"${field.label}" repeats an answer`);
      const seen = new Set<unknown>();
      for (const item of answer) {
        if (typeof item !== 'string' || !values.includes(item))
          return bad(`"${field.label}" is not one of the offered answers`, 'not_an_option');
        if (seen.has(item)) return bad(`"${field.label}" repeats an answer`);
        seen.add(item);
      }
      return undefined;
    }
    case 'date':
      return typeof answer === 'string' && DATE.test(answer) && !Number.isNaN(Date.parse(answer))
        ? undefined
        : bad(`"${field.label}" is a date as YYYY-MM-DD`);
    case 'number':
      return typeof answer === 'number' && Number.isFinite(answer) ? undefined : bad(`"${field.label}" is a number`);
    case 'boolean':
      return typeof answer === 'boolean' ? undefined : bad(`"${field.label}" is yes or no`);
    case 'ci_picker':
      return typeof answer === 'string' && UUID.test(answer)
        ? undefined
        : bad(`"${field.label}" is a configuration item`);
    case 'contact_picker':
      return typeof answer === 'string' && UUID.test(answer) ? undefined : bad(`"${field.label}" is a contact`);
    case 'urgency':
    case 'impact':
      return typeof answer === 'string' && (LEVELS as readonly string[]).includes(answer)
        ? undefined
        : bad(`"${field.label}" is high, medium or low`);
    case 'attachment': {
      if (!Array.isArray(answer) || answer.length > 20) return bad(`"${field.label}" is a list of uploaded files`);
      for (const item of answer)
        if (typeof item !== 'string' || !UUID.test(item)) return bad(`"${field.label}" is a list of uploaded files`);
      return undefined;
    }
  }
}

/**
 * The form served when an account has published none (functional 5.4: the
 * portal keeps working). It is the fixed set of fields the web form has
 * always posted, written as a definition, so a client that moves to the
 * `answers` shape gets exactly the request it got before.
 */
export function defaultFormDefinition(type: 'incident' | 'service_request' | 'change'): FormDefinition {
  return {
    fields: [
      {
        key: 'short_description',
        kind: 'short_text',
        label: type === 'incident' ? 'What went wrong?' : 'What do you need?',
        required: true,
        maps_to: 'short_description',
      },
      {
        key: 'description',
        kind: 'long_text',
        label: 'Tell us more',
        help: 'Anything that helps us start: what you expected, what happened, who is affected.',
        maps_to: 'description',
      },
      { key: 'category', kind: 'short_text', label: 'Category', maps_to: 'category' },
      { key: 'impact', kind: 'impact', label: 'How many people does this affect?', maps_to: 'impact' },
      { key: 'urgency', kind: 'urgency', label: 'How soon do you need it?', maps_to: 'urgency' },
    ],
  };
}
