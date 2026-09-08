import { describe, expect, it } from 'vitest';
import { computeMeasures, type Measures, type Period, type TicketFacts } from './measures.js';
import { EMPTY_SECTION_LINE, extractPdfText, pdfPageCount, renderPackPdf } from './pdf.js';
import {
  previousQuarter,
  qbrDocument,
  quarterBefore,
  quarterLabel,
  quarterOf,
  templatedQbrNarrative,
  type QbrComparison,
  type QbrFacts,
} from './qbr.js';

/**
 * The quarterly business review pack (DR-08). The document is described
 * from frozen measures, so the sections, the comparison arithmetic and the
 * empty-section behaviour are all assertable without opening a file, and
 * the rendered PDF is checked once for the page count and the words.
 */
function ticket(overrides: Partial<TicketFacts> = {}): TicketFacts {
  return {
    id: 'a',
    key: 'CS0000001',
    type: 'incident',
    state: 'new',
    priority: 'p3',
    createdAt: new Date('2026-04-05T09:00:00Z'),
    resolvedAt: null,
    closedAt: null,
    reopenCount: 0,
    responseBreached: false,
    resolutionBreached: false,
    responseMet: false,
    resolutionMet: false,
    resolutionDueAt: null,
    resolutionRemainingMinutes: null,
    resolutionTargetMinutes: null,
    shortDescription: 'A request',
    ...overrides,
  };
}

const Q2: Period = { start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-07-01T00:00:00Z') };
const Q1: Period = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') };
const NOW = new Date('2026-06-30T12:00:00Z');

function measuresOf(tickets: TicketFacts[], period: Period, consumedMinutes = 0): Measures {
  return computeMeasures(
    tickets,
    consumedMinutes > 0 ? [{ minutes: consumedMinutes, consumesContract: true, performedOn: '2026-05-01' }] : [],
    period,
    NOW,
  );
}

function facts(overrides: Partial<QbrFacts> = {}): QbrFacts {
  const tickets = [
    ticket({ id: '1', key: 'CS0000001' }),
    ticket({
      id: '2',
      key: 'CS0000002',
      state: 'resolved',
      resolvedAt: new Date('2026-05-02T09:00:00Z'),
      resolutionMet: true,
      responseMet: true,
    }),
    ticket({
      id: '3',
      key: 'CS0000003',
      state: 'resolved',
      resolvedAt: new Date('2026-05-04T09:00:00Z'),
      resolutionBreached: true,
      responseMet: true,
      reopenCount: 1,
    }),
  ];
  return {
    period: Q2,
    measures: measuresOf(tickets, Q2, 6000),
    satisfaction: {
      responses: 4,
      mean: 4.5,
      quarterly: { period: '2026Q2', responses: 3, average: 4.2 },
    },
    knowledge: { articles_created: 6, versions_published: 4, solutions_linked: 9, resolved_by_article: 5 },
    roster: {
      people: 2,
      minutes: 6000,
      by_person: [
        { name: 'Ada Byron', minutes: 4200 },
        { name: 'Grace Hopper', minutes: 1800 },
      ],
    },
    renewals: [
      {
        name: 'Retainer',
        model: 'time_and_materials',
        period_ends_on: '2026-12-31',
        days_to_renewal: 184,
        available_minutes: 12000,
        consumed_minutes: 6000,
      },
    ],
    notable: [{ key: 'CS0000001', title: 'A request', state: 'new', priority: 'p3', age_days: 86 }],
    ...overrides,
  };
}

function comparisonOf(): QbrComparison {
  const tickets = [
    ticket({
      id: '9',
      key: 'CS0000009',
      state: 'resolved',
      createdAt: new Date('2026-02-01T09:00:00Z'),
      resolvedAt: new Date('2026-02-03T09:00:00Z'),
      resolutionMet: true,
      responseMet: true,
    }),
  ];
  return {
    period: Q1,
    measures: measuresOf(tickets, Q1, 3000),
    satisfaction: { responses: 2, mean: 4, quarterly: null },
  };
}

describe('quarter arithmetic', () => {
  it('takes calendar quarters in UTC and names them', () => {
    expect(quarterOf(new Date('2026-05-17T23:30:00Z'))).toEqual(Q2);
    expect(quarterOf(new Date('2026-04-01T00:00:00Z'))).toEqual(Q2);
    expect(quarterLabel(Q2)).toBe('2026 Q2');
    expect(quarterLabel(Q1)).toBe('2026 Q1');
  });

  it('steps back a whole quarter, across a year end', () => {
    expect(quarterBefore(Q2)).toEqual(Q1);
    expect(previousQuarter(new Date('2026-05-17T00:00:00Z'))).toEqual(Q1);
    expect(previousQuarter(new Date('2026-02-10T00:00:00Z'))).toEqual({
      start: new Date('2025-10-01T00:00:00Z'),
      end: new Date('2026-01-01T00:00:00Z'),
    });
  });
});

describe('the quarterly pack document', () => {
  it('carries the nine sections the spec names, in order', () => {
    const document = qbrDocument(
      'Brookfield',
      facts(),
      comparisonOf(),
      templatedQbrNarrative('Brookfield', facts(), comparisonOf()),
    );
    expect(document.title).toBe('Quarterly business review');
    expect(document.periodStart).toBe('2026-04-01');
    expect(document.periodEnd).toBe('2026-06-30');
    expect(document.sections.map((section) => section.title)).toEqual([
      'Quarter summary: 2026 Q2',
      'Service levels',
      'Quarter over quarter',
      'Backlog and notable requests',
      'Consumption and burn',
      'Satisfaction',
      'Knowledge base contribution',
      'Capacity and roster',
      'Renewal and outlook',
    ]);
  });

  it('compares the quarter with the one before it, measure by measure', () => {
    const document = qbrDocument('Brookfield', facts(), comparisonOf(), { sections: [] });
    const table = document.sections[2].tables![0];
    expect(table.columns).toEqual(['Measure', '2026 Q2', '2026 Q1', 'Change']);
    const row = (label: string) => table.rows.find((entry) => entry[0] === label)!;
    expect(row('Requests raised')).toEqual(['Requests raised', '3', '1', '+2']);
    expect(row('Requests resolved')).toEqual(['Requests resolved', '2', '1', '+1']);
    // The backlog is a count as it stands now, so it is not compared.
    expect(table.rows.some((entry) => entry[0].startsWith('Open'))).toBe(false);
    // Half of two met against one of one: fifty points down.
    expect(row('Resolution targets met')).toEqual(['Resolution targets met', '50%', '100%', '-50 pts']);
    expect(row('Contract hours consumed')).toEqual(['Contract hours consumed', '100 h', '50 h', '+50 h']);
    expect(row('Satisfaction')).toEqual(['Satisfaction', '4.5 of 5', '4 of 5', '+0.5']);
  });

  it('says so plainly when there is no quarter to compare against', () => {
    const document = qbrDocument('Brookfield', facts(), null, { sections: [] });
    expect(document.sections[2].tables).toEqual([]);
    expect(document.sections[2].paragraphs).toContain(
      'This is the first quarter on record, so there is nothing to compare it against.',
    );
  });

  it('reports the knowledge, roster and renewal facts the quarterly sections exist for', () => {
    const document = qbrDocument('Brookfield', facts(), null, { sections: [] });
    expect(document.sections[6].tiles).toEqual([
      { label: 'Articles written', value: '6' },
      { label: 'Versions published', value: '4' },
      { label: 'Linked to requests', value: '9' },
      { label: 'Requests they resolved', value: '5' },
    ]);
    expect(document.sections[7].tables![0].rows).toEqual([
      ['Ada Byron', '70'],
      ['Grace Hopper', '30'],
    ]);
    expect(document.sections[8].paragraphs![0]).toBe('Retainer runs to 2026-12-31, 184 days away.');
    expect(document.sections[5].paragraphs![0]).toBe('4 scores on closed requests, averaging 4.5 of 5.');
  });

  it('says nothing happened rather than showing an empty frame', () => {
    const quiet = facts({
      satisfaction: { responses: 0, mean: null, quarterly: null },
      knowledge: { articles_created: 0, versions_published: 0, solutions_linked: 0, resolved_by_article: 0 },
      roster: { people: 0, minutes: 0, by_person: [] },
      renewals: [],
      notable: [],
      measures: measuresOf([], Q2),
    });
    const document = qbrDocument('Brookfield', quiet, null, { sections: [] });
    expect(document.sections[3].tables).toEqual([]);
    expect(document.sections[7].paragraphs![0]).toBe('Nobody logged time against this account this quarter.');
    expect(document.sections[8].paragraphs).toContain('No contracted hours were set for this quarter.');
  });

  it('renders one cover and one page per section, with the words on them', async () => {
    const quiet = facts({ notable: [], measures: measuresOf([], Q2) });
    const document = qbrDocument('Brookfield', quiet, null, {
      sections: [{ key: 'headline', text: 'A steady quarter for Brookfield.' }],
    });
    const pdf = await renderPackPdf(document);
    expect(pdfPageCount(pdf)).toBe(document.sections.length + 1);
    const text = extractPdfText(pdf);
    expect(text).toContain('Quarterly business review');
    expect(text).toContain('A steady quarter for Brookfield.');
    expect(text).toContain('Knowledge base contribution');
    // The backlog section has nothing in it for an account with no open work.
    expect(text).toContain(EMPTY_SECTION_LINE);
  });

  it('writes a templated narrative a reviewer can rewrite', () => {
    const narrative = templatedQbrNarrative('Brookfield', facts(), comparisonOf());
    expect(narrative.sections.map((section) => section.key)).toEqual([
      'headline',
      'service_levels',
      'quarter_over_quarter',
      'consumption',
      'knowledge',
    ]);
    expect(narrative.sections[0].text).toContain('2026 Q2');
    expect(templatedQbrNarrative('Brookfield', facts(), null).sections.map((section) => section.key)).not.toContain(
      'quarter_over_quarter',
    );
  });
});
