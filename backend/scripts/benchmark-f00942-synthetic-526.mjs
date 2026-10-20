import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PDFDocument } from 'pdf-lib';
import { ReportRenderer } from '../dist/reports/report-renderer.js';
import { buildTechnicalDisplayUnits } from '../dist/reports/technical-display.js';
import { createPresentationHardeningFixture, sha256 } from '../test/fixtures/reports/presentation-hardening/fixture.mjs';

// This script has no database, storage, inference, or private-file input boundary.
// It builds one reproducible synthetic input and only writes its benchmark JSON.
if (process.argv[2] !== '--synthetic-only' || !process.argv[3] || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/benchmark-f00942-synthetic-526.mjs --synthetic-only output.json');
}

const fixture = await createPresentationHardeningFixture();
const bodyTemplate = fixture.input.paragraphs.find((item) => item.kind === 'PARAGRAPH').textPreview;
const scores = [0.8, 0.2, 0.61, 0.4, 0.9, 0.1, 0.58, 0.25];
const body = Array.from({ length: 48 }, (_, index) => ({
  text: `Synthetic benchmark body ${index + 1}. ${bodyTemplate} Unique sample ${index + 1}.`,
  score: scores[index % scores.length], kind: 'PARAGRAPH', pageNumber: index + 2,
}));
const entries = [
  ...Array.from({ length: 100 }, (_, index) => ({
    text: `Author: Synthetic benchmark metadata entry ${index + 1}.`,
    score: index === 0 ? 0.95 : null, kind: 'METADATA', structuralType: 'METADATA',
    structuralGroupId: 'synthetic-526-metadata', excludedReason: 'METADATA', pageNumber: 1,
  })),
  ...body.slice(0, 24),
  ...Array.from({ length: 200 }, (_, index) => ({
    text: `Synthetic cell ${index + 1} | Indicator ${index + 1} | Value ${index + 11}`,
    score: null, kind: 'TABLE_CELL', structuralType: 'TABLE_CELL',
    structuralGroupId: 'synthetic-526-table', excludedReason: 'INSUFFICIENT_TEXT', pageNumber: 26,
  })),
  ...body.slice(24),
  ...Array.from({ length: 178 }, (_, index) => ({
    text: `${index === 0 ? 'References: ' : ''}[${index + 1}] Synthetic Author ${index + 1} (2026). Generated benchmark reference ${index + 1}. Example Test Press.`,
    score: index === 0 ? 0.91 : null, kind: 'REFERENCE_SECTION', structuralType: 'REFERENCE_SECTION',
    structuralGroupId: 'synthetic-526-references', excludedReason: 'REFERENCE_SECTION', pageNumber: 51 + Math.floor(index / 15),
  })),
];

let offset = 0;
const paragraphs = entries.map((entry, paragraphIndex) => {
  const charStart = offset;
  const charEnd = charStart + entry.text.length;
  offset = charEnd + 2;
  const signalLevel = entry.score === null ? null : entry.score >= 0.59 ? 'HIGH' : 'LOW';
  const words = entry.text.split(/\s+/u).length;
  return {
    paragraphIndex, sourceSegmentId: `synthetic-526-${paragraphIndex}`,
    kind: entry.kind, ...(entry.structuralType ? { structuralType: entry.structuralType } : {}),
    ...(entry.structuralGroupId ? { structuralGroupId: entry.structuralGroupId } : {}),
    textHash: sha256(entry.text.replace(/\s+/gu, ' ').trim()), charStart, charEnd,
    segmentEvidence: { type: 'PARAGRAPH', paragraphId: paragraphIndex, start: charStart, end: charEnd, score: entry.score, level: signalLevel },
    score: entry.score, signalLevel,
    classification: entry.score === null ? 'INSUFFICIENT_TEXT' : entry.score >= 0.59 ? 'MACHINE_SIGNAL' : 'LOW_SIGNAL',
    reviewPresentation: { highlight: entry.score !== null && entry.score >= 0.59 && !entry.excludedReason, level: signalLevel, ...(entry.excludedReason ? { excludedReason: entry.excludedReason } : {}) },
    presentationExcluded: Boolean(entry.excludedReason), ...(entry.excludedReason ? { excludedReason: entry.excludedReason } : {}),
    textPreview: entry.text, pageNumber: entry.pageNumber, words, tokens: words,
  };
});
const extractedText = paragraphs.map((paragraph) => paragraph.textPreview).join('\n\n');
for (const segment of paragraphs) {
  assert.equal(extractedText.slice(segment.charStart, segment.charEnd), segment.textPreview);
  assert.equal(sha256(segment.textPreview.replace(/\s+/gu, ' ').trim()), segment.textHash);
}
const input = {
  ...fixture.input, reportId: randomUUID(), extractedText, paragraphs,
  document: { ...fixture.input.document, id: randomUUID(), documentVersionId: randomUUID(),
    filename: 'synthetic-526-benchmark.txt', mimeType: 'text/plain', sourceChecksum: sha256(extractedText), storageKey: 'synthetic-526-benchmark.txt' },
  run: { ...fixture.input.run, id: randomUUID(), scoredSegments: 50, insufficientSegments: 476 },
};
assert.equal(paragraphs.length, 526);
assert.equal(paragraphs.filter((segment) => segment.score !== null).length, 50);
assert.equal(paragraphs.filter((segment) => segment.score === null).length, 476);

const snapshot = JSON.stringify(input);
const memoryBefore = process.memoryUsage();
const groupingStart = performance.now();
const display = buildTechnicalDisplayUnits(input.paragraphs, { extractedText, threshold: input.run.threshold });
const groupingMs = performance.now() - groupingStart;
const memoryAfterGrouping = process.memoryUsage();
const renderStart = performance.now();
const pdf = await new ReportRenderer().renderAIParagraphTechnical(input);
const renderMs = performance.now() - renderStart;
const memoryAfterRendering = process.memoryUsage();
const actualPages = (await PDFDocument.load(pdf)).getPageCount();
const represented = display.units.flatMap((unit) => unit.sourceSegments);
const sourceById = new Map(paragraphs.map((segment) => [segment.paragraphIndex, segment]));
const scoresChanged = represented.filter((segment) => segment.score !== sourceById.get(segment.paragraphIndex).score).length;
const blockScoresInvented = display.units.filter((unit) => unit.type.endsWith('_GROUP') && Object.hasOwn(unit, 'score')).length;
assert.equal(JSON.stringify(input), snapshot);
assert.equal(scoresChanged, 0);
assert.equal(blockScoresInvented, 0);
assert.equal(display.audit.sourceSegmentsRepresented, 526);
assert.equal(display.audit.sourceSegmentsLost, 0);
assert.equal(display.audit.sourceSegmentsDuplicated, 0);

const benchmark = {
  benchmark: 'F009_4_2_SYNTHETIC_526', privateDocumentUsed: false, inference: false,
  sourceSegments: 526, evaluated: 50, insufficient: 476,
  evaluatedBodySegments: 48, evaluatedStructuralAnnotations: 2,
  structuralSourceSegments: { metadata: 100, table: 200, references: 178 },
  groupingMs: Number(groupingMs.toFixed(3)), renderMs: Number(renderMs.toFixed(3)),
  actualPages, pdfBytes: pdf.length, displayUnits: display.units.length,
  structuralGroups: display.counts.structuralGroups,
  sourceSegmentsRepresented: display.audit.sourceSegmentsRepresented,
  sourceSegmentsLost: display.audit.sourceSegmentsLost,
  sourceSegmentsDuplicated: display.audit.sourceSegmentsDuplicated,
  scoresChanged, blockScoresInvented, inputUnchanged: JSON.stringify(input) === snapshot,
  inputTextSha256: sha256(extractedText),
  memoryMeasurement: 'process.memoryUsage before grouping, after grouping, and after rendering; sampled values, not a peak measurement',
  memory: { before: memoryBefore, afterGrouping: memoryAfterGrouping, afterRendering: memoryAfterRendering },
};
const target = path.resolve(process.argv[3]);
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(benchmark, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(benchmark)}\n`);
