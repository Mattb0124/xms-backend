import { describe, expect, it } from 'vitest';
import {
  defaultFormDefinition,
  definitionProblems,
  MAX_PROBLEMS,
  validateSubmission,
  type FormDefinition,
  type FormField,
} from './form-schema.js';

/**
 * The form rules (CP-03; Client Portal technical 2.7). The definition side
 * proves the builder cannot author a form the server would refuse; the
 * submission side proves required, kind and condition are decided here and
 * nowhere else.
 */
const field = (over: Partial<FormField> & Pick<FormField, 'key' | 'kind' | 'maps_to'>): FormField => ({
  label: over.key,
  ...over,
});

const form = (...fields: FormField[]): FormDefinition => ({ fields });

const codes = (problems: { code: string }[]): string[] => problems.map((problem) => problem.code);

describe('form definition', () => {
  it('accepts a form whose fields map to a column or a custom key', () => {
    const definition = form(
      field({ key: 'short_description', kind: 'short_text', maps_to: 'short_description', required: true }),
      field({ key: 'details', kind: 'long_text', maps_to: 'description' }),
      field({ key: 'seats', kind: 'number', maps_to: 'custom.seats' }),
      field({ key: 'agreed', kind: 'boolean', maps_to: 'custom.agreed' }),
    );
    expect(definitionProblems(definition)).toEqual([]);
  });

  it('refuses a field that writes a column its kind cannot write', () => {
    const problems = definitionProblems(form(field({ key: 'note', kind: 'number', maps_to: 'description' })));
    expect(codes(problems)).toContain('bad_maps_to');
  });

  it('refuses two fields writing the same place and two fields sharing a key', () => {
    const both = definitionProblems(
      form(
        field({ key: 'one', kind: 'short_text', maps_to: 'category' }),
        field({ key: 'two', kind: 'choice', maps_to: 'category', options: [{ value: 'a', label: 'A' }] }),
        field({ key: 'two', kind: 'long_text', maps_to: 'description' }),
      ),
    );
    expect(codes(both)).toEqual(expect.arrayContaining(['duplicate_maps_to', 'duplicate_key']));
  });

  it('refuses a condition that names a field asked later', () => {
    const problems = definitionProblems(
      form(
        field({ key: 'why', kind: 'long_text', maps_to: 'description', visible_when: { field: 'kind', equals: 'x' } }),
        field({ key: 'kind', kind: 'choice', maps_to: 'custom.kind', options: [{ value: 'x', label: 'X' }] }),
      ),
    );
    expect(codes(problems)).toEqual(['bad_condition']);
  });

  it('refuses a condition on an answer the controlling field cannot have', () => {
    const problems = definitionProblems(
      form(
        field({ key: 'kind', kind: 'choice', maps_to: 'custom.kind', options: [{ value: 'x', label: 'X' }] }),
        field({ key: 'why', kind: 'long_text', maps_to: 'description', visible_when: { field: 'kind', equals: 'z' } }),
      ),
    );
    expect(codes(problems)).toEqual(['bad_condition']);
  });

  it('asks for urgency and impact together or for neither, and for one attachment field at most', () => {
    expect(codes(definitionProblems(form(field({ key: 'u', kind: 'urgency', maps_to: 'urgency' }))))).toEqual([
      'urgency_impact_pair',
    ]);
    expect(
      codes(
        definitionProblems(
          form(
            field({ key: 'a', kind: 'attachment', maps_to: 'custom.a' }),
            field({ key: 'b', kind: 'attachment', maps_to: 'custom.b' }),
          ),
        ),
      ),
    ).toEqual(['too_many_attachments']);
  });

  it('refuses a choice without options and options on a kind that takes none', () => {
    expect(codes(definitionProblems(form(field({ key: 'c', kind: 'choice', maps_to: 'custom.c' }))))).toEqual([
      'bad_options',
    ]);
    expect(
      codes(
        definitionProblems(
          form(field({ key: 'n', kind: 'number', maps_to: 'custom.n', options: [{ value: 'a', label: 'A' }] })),
        ),
      ),
    ).toEqual(['options_not_allowed']);
  });

  it('refuses a definition that is not a list of fields', () => {
    expect(codes(definitionProblems({ fields: 'none' }))).toEqual(['not_a_list']);
    expect(codes(definitionProblems({ fields: [] }))).toEqual(['empty']);
  });

  it('accepts the default form the portal falls back to', () => {
    for (const type of ['incident', 'service_request', 'change'] as const)
      expect(definitionProblems(defaultFormDefinition(type))).toEqual([]);
  });
});

describe('form submission', () => {
  const definition = form(
    field({ key: 'short_description', kind: 'short_text', maps_to: 'short_description', required: true }),
    field({
      key: 'kind',
      kind: 'choice',
      maps_to: 'custom.kind',
      required: true,
      options: [
        { value: 'access', label: 'Access' },
        { value: 'other', label: 'Other' },
      ],
    }),
    field({
      key: 'other_detail',
      kind: 'long_text',
      maps_to: 'description',
      required: true,
      visible_when: { field: 'kind', equals: 'other' },
    }),
    field({ key: 'needed_by', kind: 'date', maps_to: 'custom.needed_by' }),
  );

  it('maps answers onto the ticket columns and the custom document', () => {
    const { problems, mapped } = validateSubmission(definition, {
      short_description: 'Cannot log in',
      kind: 'access',
      needed_by: '2026-09-30',
    });
    expect(problems).toEqual([]);
    expect(mapped.columns).toEqual({ short_description: 'Cannot log in' });
    expect(mapped.custom).toEqual({ kind: 'access', needed_by: '2026-09-30' });
    expect(mapped.hidden).toEqual(['other_detail']);
  });

  it('names a required field that is missing', () => {
    const { problems } = validateSubmission(definition, { kind: 'access' });
    expect(problems).toEqual([
      { field: 'short_description', code: 'required', message: '"short_description" is required' },
    ]);
  });

  it('requires a conditional field only when its condition holds', () => {
    const hidden = validateSubmission(definition, { short_description: 'Need access', kind: 'access' });
    expect(hidden.problems).toEqual([]);
    const shown = validateSubmission(definition, { short_description: 'Something else', kind: 'other' });
    expect(codes(shown.problems)).toEqual(['required']);
    expect(shown.problems[0].field).toBe('other_detail');
  });

  it('refuses an answer of the wrong kind and an answer the form did not ask for', () => {
    const { problems } = validateSubmission(definition, {
      short_description: 'Cannot log in',
      kind: 'nonsense',
      needed_by: 'soon',
      colour: 'blue',
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'kind', code: 'not_an_option' }),
        expect.objectContaining({ field: 'needed_by', code: 'bad_value' }),
        expect.objectContaining({ field: 'colour', code: 'unknown_field' }),
      ]),
    );
  });

  it('drops the answer to a field a condition hid rather than storing it', () => {
    const { problems, mapped } = validateSubmission(definition, {
      short_description: 'Need access',
      kind: 'access',
      other_detail: 'sent anyway',
    });
    expect(problems).toEqual([]);
    expect(mapped.columns.description).toBeUndefined();
    expect(mapped.hidden).toEqual(['other_detail']);
  });

  it('accepts a multi-choice list and refuses a repeat', () => {
    const multi = form(
      field({
        key: 'systems',
        kind: 'multi_choice',
        maps_to: 'custom.systems',
        options: [
          { value: 'erp', label: 'ERP' },
          { value: 'crm', label: 'CRM' },
        ],
      }),
    );
    expect(validateSubmission(multi, { systems: ['erp', 'crm'] }).problems).toEqual([]);
    expect(codes(validateSubmission(multi, { systems: ['erp', 'erp'] }).problems)).toEqual(['bad_value']);
  });
});

/**
 * The refusal is bounded (review 2026-09-09 finding 10). A portal contact is
 * the one principal that composes the object shape, and a body of many
 * thousands of short keys sits comfortably inside the global 1 MB limit, so
 * one problem per unknown key turned a small request into a large answer.
 */
describe('how much a refusal says', () => {
  const simple = form(field({ key: 'summary', kind: 'short_text', maps_to: 'short_description', required: true }));

  it('names the first fifty unknown keys and then counts the rest', () => {
    const answers: Record<string, unknown> = { summary: 'Need a hand' };
    for (let index = 0; index < 5000; index += 1) answers[`k${index}`] = 'x';
    const { problems } = validateSubmission(simple, answers);

    const unknown = problems.filter((problem) => problem.code === 'unknown_field');
    expect(unknown).toHaveLength(MAX_PROBLEMS);
    const overflow = problems.find((problem) => problem.code === 'too_many_unknown_fields');
    expect(overflow?.message).toContain('5000 keys');
    expect(problems).toHaveLength(MAX_PROBLEMS + 1);
    expect(JSON.stringify(problems).length).toBeLessThan(10_000);
  });

  it('still names every unknown key while there are few of them', () => {
    const { problems } = validateSubmission(simple, { summary: 'Need a hand', colour: 'red', size: 'large' });
    expect(codes(problems)).toEqual(['unknown_field', 'unknown_field']);
  });
});
