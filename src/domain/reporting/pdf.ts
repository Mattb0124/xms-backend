import PDFDocument from 'pdfkit';
import type { Measures, Period } from './measures.js';

/**
 * The PDF rendition of a report pack (Dashboards & Report Packs functional
 * 5.6 and 5.9, technical 3; DR-04, DR-05). The pack is described once as a
 * `PackDocument` (cover facts plus an ordered list of sections) and that
 * description is what both the reader and the renderer see, so the layout
 * is testable without opening a file.
 *
 * Rendering is `pdfkit` with the standard Helvetica faces: pure Node, no
 * headless browser, no network and no font files to ship. Content streams
 * are written uncompressed so a stored rendition can be read back with
 * `extractPdfText` by a test or by anyone verifying what a client received.
 *
 * One section is one page, and a section with nothing in it prints the
 * "No activity this period" line rather than an empty frame, so the page
 * count of a pack is always one cover plus one page per section.
 */
export interface PackTile {
  readonly label: string;
  readonly value: string;
}

export interface PackTable {
  readonly caption?: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface PackSection {
  readonly title: string;
  readonly paragraphs?: readonly string[];
  readonly tiles?: readonly PackTile[];
  readonly tables?: readonly PackTable[];
}

/**
 * The prose of a pack, one entry per section of the document
 * (Dashboards & Report Packs functional 5.8: the review screen shows the
 * narrative in an editable panel). The numbers are frozen on the pack and
 * are never edited; this is the only part a reviewer rewrites, so it is
 * described apart from the sections that carry the tiles and the tables
 * and is keyed to them rather than to their titles, which are copy.
 */
export interface NarrativeSection {
  readonly key: string;
  readonly text: string;
}

export interface PackNarrative {
  readonly sections: readonly NarrativeSection[];
}

/** The sections of a weekly status report a narrative may speak to, in document order. */
export const WSR_NARRATIVE_KEYS = ['headline', 'service_levels', 'backlog', 'consumption'] as const;

export type WsrNarrativeKey = (typeof WSR_NARRATIVE_KEYS)[number];

/**
 * A narrative from whatever was stored: the templated single paragraph of
 * a pack built before the editor existed reads as the headline, and an
 * already sectioned one is taken as written with its unknown keys and
 * blank texts dropped.
 */
export function packNarrative(stored: unknown): PackNarrative {
  if (typeof stored === 'string')
    return stored.trim() ? { sections: [{ key: 'headline', text: stored }] } : sectionsOf([]);
  const raw = (stored as { sections?: unknown })?.sections;
  if (!Array.isArray(raw)) return sectionsOf([]);
  return sectionsOf(
    raw
      .filter((entry): entry is NarrativeSection => typeof entry?.key === 'string' && typeof entry?.text === 'string')
      .map((entry) => ({ key: entry.key, text: entry.text })),
  );
}

function sectionsOf(sections: readonly NarrativeSection[]): PackNarrative {
  return { sections: sections.filter((section) => section.text.trim().length > 0) };
}

/** The prose for one section, or the empty string where the narrative says nothing about it. */
export function narrativeFor(narrative: PackNarrative, key: string): string {
  return narrative.sections.find((section) => section.key === key)?.text ?? '';
}

/** Every section's prose as one block, which is what a plain-text reader of the pack sees. */
export function narrativeText(narrative: PackNarrative): string {
  return narrative.sections
    .map((section) => section.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

export interface PackDocument {
  readonly title: string;
  readonly accountName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly generatedAt: string;
  readonly sections: readonly PackSection[];
}

export const EMPTY_SECTION_LINE = 'No activity this period.';

const NAVY = '#10193A';
const INK = '#0F172A';
const SLATE = '#475569';
const RULE = '#E2E8F0';
const TILE = '#F4F5F7';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function hours(minutes: number): string {
  return String(Math.round(minutes / 60));
}

function percent(ratio: { value: number | null }): string {
  return ratio.value === null ? 'n/a' : `${ratio.value}%`;
}

/**
 * The weekly status report as a document: the same account, period,
 * measures, notable rows and narrative the deck is built from, so the two
 * renditions of a run can never disagree about the numbers.
 */
export function wsrDocument(
  accountName: string,
  period: Period,
  measures: Measures,
  notable: readonly { key: string; title: string; state: string; priority: string; age_days: number }[],
  narrative: string | PackNarrative,
  generatedAt = new Date(),
): PackDocument {
  const prose = packNarrative(narrative);
  const ages = Object.entries(measures.backlog_by_age)
    .filter(([, count]) => count > 0)
    .map(([bucket, count]) => [
      bucket.replace('_', ' to ').replace('d', ' days').replace('plus', 'or more'),
      String(count),
    ]);
  return {
    title: 'Weekly status report',
    accountName,
    periodStart: day(period.start),
    periodEnd: day(new Date(period.end.getTime() - 1)),
    generatedAt: generatedAt.toISOString(),
    sections: [
      { title: 'Headline', paragraphs: [narrativeFor(prose, 'headline')].filter(Boolean) },
      {
        title: 'Service levels',
        paragraphs: [narrativeFor(prose, 'service_levels')].filter(Boolean),
        tiles: [
          { label: 'Open requests', value: String(measures.open_tickets) },
          { label: 'Past target', value: String(measures.breached_now) },
          { label: 'At risk', value: String(measures.at_risk_now) },
          { label: 'Response met', value: percent(measures.sla_response_attainment) },
          { label: 'Resolution met', value: percent(measures.sla_resolution_attainment) },
          {
            label: 'Avg time to resolve',
            value: measures.mttr_minutes === null ? 'n/a' : `${hours(measures.mttr_minutes)} h`,
          },
        ],
      },
      {
        title: 'Backlog and notable requests',
        paragraphs: [narrativeFor(prose, 'backlog')].filter(Boolean),
        tables: [
          ...(ages.length > 0 ? [{ caption: 'Backlog by age', columns: ['Age', 'Open'], rows: ages }] : []),
          ...(notable.length > 0
            ? [
                {
                  caption: 'Notable requests',
                  columns: ['Key', 'Title', 'State', 'Priority', 'Age'],
                  rows: notable.map((row) => [
                    row.key,
                    row.title.slice(0, 60),
                    row.state.replace(/_/g, ' '),
                    row.priority.toUpperCase(),
                    `${row.age_days} d`,
                  ]),
                },
              ]
            : []),
        ],
      },
      {
        title: 'Consumption',
        paragraphs: [
          `${hours(measures.consumption_minutes)} contract hours consumed this period; ${hours(measures.time_logged_minutes)} hours logged in total.`,
          narrativeFor(prose, 'consumption'),
        ].filter(Boolean),
      },
    ],
  };
}

/** True when a section carries nothing worth a frame. */
function isEmpty(section: PackSection): boolean {
  const paragraphs = (section.paragraphs ?? []).filter((line) => line.trim().length > 0);
  const tables = (section.tables ?? []).filter((table) => table.rows.length > 0);
  return paragraphs.length === 0 && (section.tiles ?? []).length === 0 && tables.length === 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfkit's typings model the document as a stream with a fluent face.
type Doc = any;

function heading(doc: Doc, text: string): void {
  doc.font('Helvetica-Bold').fontSize(18).fillColor(NAVY).text(text, MARGIN, MARGIN, { width: CONTENT_WIDTH });
  doc.moveDown(0.4);
  const y = doc.y;
  doc
    .moveTo(MARGIN, y)
    .lineTo(PAGE_WIDTH - MARGIN, y)
    .strokeColor(RULE)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.8);
}

function tiles(doc: Doc, rows: readonly PackTile[]): void {
  const columns = 3;
  const gap = 12;
  const width = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const height = 62;
  const top = doc.y;
  rows.forEach((tile, index) => {
    const x = MARGIN + (index % columns) * (width + gap);
    const y = top + Math.floor(index / columns) * (height + gap);
    doc.rect(x, y, width, height).fillColor(TILE).fill();
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(NAVY)
      .text(tile.value, x + 10, y + 10, { width: width - 20 });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(SLATE)
      .text(tile.label, x + 10, y + 38, { width: width - 20 });
  });
  doc.y = top + Math.ceil(rows.length / columns) * (height + gap);
  doc.x = MARGIN;
}

function table(doc: Doc, spec: PackTable): void {
  if (spec.caption) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(spec.caption, MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.3);
  }
  const width = CONTENT_WIDTH / spec.columns.length;
  const line = (cells: readonly string[], bold: boolean): void => {
    const y = doc.y;
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(9)
      .fillColor(bold ? NAVY : INK);
    let tallest = 0;
    cells.forEach((cell, index) => {
      doc.text(cell, MARGIN + index * width, y, { width: width - 6, ellipsis: true });
      tallest = Math.max(tallest, doc.y - y);
    });
    doc.y = y + Math.max(tallest, 12);
    doc.x = MARGIN;
  };
  line(spec.columns, true);
  for (const row of spec.rows) line(row, false);
  doc.moveDown(0.8);
}

/** Renders a described pack into a PDF buffer. Deterministic apart from the creation date pdfkit stamps. */
export function renderPackPdf(document: PackDocument): Promise<Buffer> {
  const doc: Doc = new PDFDocument({
    compress: false,
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margin: MARGIN,
    autoFirstPage: false,
    info: { Title: `${document.accountName} ${document.title}`, Author: 'XMS' },
  });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.addPage();
  doc.rect(0, 0, PAGE_WIDTH, 220).fillColor(NAVY).fill();
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#FFFFFF').text(document.title, MARGIN, 92, {
    width: CONTENT_WIDTH,
  });
  doc.font('Helvetica').fontSize(13).fillColor('#DCE3F0').text(document.accountName, MARGIN, 142, {
    width: CONTENT_WIDTH,
  });
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(SLATE)
    .text(`${document.periodStart} to ${document.periodEnd}`, MARGIN, 260, { width: CONTENT_WIDTH });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(SLATE)
    .text(`Generated ${document.generatedAt}`, MARGIN, 280, { width: CONTENT_WIDTH });

  for (const section of document.sections) {
    doc.addPage();
    heading(doc, section.title);
    if (isEmpty(section)) {
      doc.font('Helvetica').fontSize(11).fillColor(SLATE).text(EMPTY_SECTION_LINE, MARGIN, doc.y, {
        width: CONTENT_WIDTH,
      });
      continue;
    }
    for (const paragraph of section.paragraphs ?? []) {
      if (!paragraph.trim()) continue;
      doc.font('Helvetica').fontSize(11).fillColor(INK).text(paragraph, MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.8);
    }
    if (section.tiles && section.tiles.length > 0) {
      tiles(doc, section.tiles);
      doc.moveDown(0.8);
    }
    for (const spec of section.tables ?? []) {
      if (spec.rows.length === 0) continue;
      table(doc, spec);
    }
  }

  doc.end();
  return finished;
}

/** The page count of a rendered pack, read from the page tree. */
export function pdfPageCount(buffer: Buffer): number {
  const counts = [...buffer.toString('latin1').matchAll(/\/Count (\d+)/g)].map((match) => Number(match[1]));
  return counts.length === 0 ? 0 : Math.max(...counts);
}

/**
 * The visible text of an uncompressed pack, in page order. pdfkit writes
 * kerned runs as hex chunks inside a `TJ` array with the standard fonts, so
 * the chunks of one run are decoded and joined; a plain `Tj` string is taken
 * as written.
 */
export function extractPdfText(buffer: Buffer): string {
  const source = buffer.toString('latin1');
  const out: string[] = [];
  for (const match of source.matchAll(/\[((?:\s*<[0-9a-fA-F]*>\s*-?[\d.]*)+)\]\s*TJ|\((.*?)\)\s*Tj/g)) {
    if (match[2] !== undefined) {
      out.push(match[2].replace(/\\([()\\])/g, '$1'));
      continue;
    }
    const run = [...match[1].matchAll(/<([0-9a-fA-F]*)>/g)]
      .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
      .join('');
    out.push(run);
  }
  return out.join('\n');
}
