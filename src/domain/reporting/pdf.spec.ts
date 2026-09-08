import { describe, expect, it } from 'vitest';
import type { Measures } from './measures.js';
import {
  EMPTY_SECTION_LINE,
  extractPdfText,
  pdfPageCount,
  renderPackPdf,
  wsrDocument,
  type PackDocument,
} from './pdf.js';

/**
 * The PDF rendition (DR-04, DR-05). The layout is asserted through the
 * rendered buffer: the page count, the titles the reader sees, and the
 * "No activity this period" line a section with nothing in it prints
 * instead of an empty frame.
 */
const measures: Measures = {
  open_tickets: 7,
  open_by_priority: { p2: 3, p3: 4 },
  open_by_type: { incident: 7 },
  breached_now: 1,
  at_risk_now: 2,
  unassigned_now: 0,
  backlog_by_age: { '0_1d': 2, '1_3d': 3, '3_7d': 1, '7_14d': 1, '14d_plus': 0 },
  volume_created: 12,
  volume_resolved: 9,
  sla_response_attainment: { value: 92, numerator: 11, denominator: 12 },
  sla_resolution_attainment: { value: null, numerator: 0, denominator: 0 },
  mttr_minutes: 480,
  reopen_rate: { value: 0, numerator: 0, denominator: 9 },
  consumption_minutes: 1200,
  time_logged_minutes: 1500,
  oldest_open_days: 31,
};

const period = { start: new Date('2026-08-24T00:00:00Z'), end: new Date('2026-08-31T00:00:00Z') };

const notable = [
  { key: 'BRK-1', title: 'Payroll interface failing', state: 'in_progress', priority: 'p2', age_days: 3.5 },
  { key: 'BRK-2', title: 'Month end close slow', state: 'waiting_client', priority: 'p3', age_days: 9 },
];

describe('wsrDocument', () => {
  it('describes the cover and the four sections from the measures the deck uses', () => {
    const document = wsrDocument('Brookfield', period, measures, notable, 'A steady week.');
    expect(document).toMatchObject({
      accountName: 'Brookfield',
      periodStart: '2026-08-24',
      periodEnd: '2026-08-30',
    });
    expect(document.sections.map((section) => section.title)).toEqual([
      'Headline',
      'Service levels',
      'Backlog and notable requests',
      'Consumption',
    ]);
    expect(document.sections[1].tiles).toContainEqual({ label: 'Resolution met', value: 'n/a' });
    expect(document.sections[1].tiles).toContainEqual({ label: 'Avg time to resolve', value: '8 h' });
    expect(document.sections[2].tables?.[1].rows[0][0]).toBe('BRK-1');
  });
});

describe('renderPackPdf', () => {
  it('renders one cover plus one page per section, with every section title in the text', async () => {
    const buffer = await renderPackPdf(wsrDocument('Brookfield', period, measures, notable, 'A steady week.'));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfPageCount(buffer)).toBe(5);
    const text = extractPdfText(buffer);
    for (const title of [
      'Weekly status report',
      'Headline',
      'Service levels',
      'Backlog and notable requests',
      'Consumption',
    ])
      expect(text).toContain(title);
    expect(text).toContain('Brookfield');
    expect(text).toContain('2026-08-24 to 2026-08-30');
    expect(text).toContain('A steady week.');
    expect(text).toContain('BRK-1');
    expect(text).not.toContain(EMPTY_SECTION_LINE);
  });

  it('prints the no-activity line for an empty section rather than throwing', async () => {
    const document: PackDocument = {
      title: 'Weekly status report',
      accountName: 'Quiet Co',
      periodStart: '2026-08-24',
      periodEnd: '2026-08-30',
      generatedAt: '2026-08-31T06:00:00.000Z',
      sections: [
        { title: 'Headline', paragraphs: ['   '] },
        { title: 'Service levels', tiles: [] },
        { title: 'Backlog and notable requests', tables: [{ columns: ['Key'], rows: [] }] },
      ],
    };
    const buffer = await renderPackPdf(document);
    expect(pdfPageCount(buffer)).toBe(4);
    const text = extractPdfText(buffer);
    expect(text.split(EMPTY_SECTION_LINE)).toHaveLength(4);
    expect(text).toContain('Quiet Co');
  });

  it('renders a pack with no sections at all as a single cover page', async () => {
    const buffer = await renderPackPdf({
      title: 'Weekly status report',
      accountName: 'Empty Co',
      periodStart: '2026-08-24',
      periodEnd: '2026-08-30',
      generatedAt: '2026-08-31T06:00:00.000Z',
      sections: [],
    });
    expect(pdfPageCount(buffer)).toBe(1);
    expect(extractPdfText(buffer)).toContain('Empty Co');
  });
});
