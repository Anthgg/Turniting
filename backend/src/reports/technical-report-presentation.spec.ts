import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createPresentationHardeningFixture, sha256 } from '../../test/fixtures/reports/presentation-hardening/fixture.mjs';
import type { AIReportInput } from './report.contracts.js';
import { OriginalDocumentRenderer } from './original-document-renderer.js';
import { ReportRenderer } from './report-renderer.js';
import { buildTechnicalDisplayUnits } from './technical-display.js';

const popplerAvailable = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 5_000 }); return true; } catch { return false; }
})();

async function textFromPdf(buffer: Buffer): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'turniting-f00942-pdf-'));
  try {
    const target = path.join(directory, 'report.pdf');
    await writeFile(target, buffer, { mode: 0o600, flag: 'wx' });
    return execFileSync('pdftotext', ['-enc', 'UTF-8', target, '-'], { encoding: 'utf8', timeout: 15_000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function canonicalPdfText(text: string): string {
  return text.replace(/Turniting\s*\|\s*Reporte independiente\s*\|\s*Página\s+\d+\s+de\s+\d+/gu, '').replace(/\s+/gu, ' ');
}

describe('F009.4.2 compact technical PDF presentation', () => {
  it.skipIf(!popplerAvailable)('keeps an insufficient classification unevaluated even when legacy numeric data is present', async () => {
    const fixture = await createPresentationHardeningFixture();
    const segment = { ...fixture.input.paragraphs.find((item) => item.kind === 'PARAGRAPH')!, classification: 'INSUFFICIENT_TEXT', score: 0.83241 };
    const input: AIReportInput = { ...fixture.input, paragraphs: [segment], run: { ...fixture.input.run, scoredSegments: 0, insufficientSegments: 1 } };
    const before = JSON.stringify(input);
    const display = buildTechnicalDisplayUnits(input.paragraphs, { extractedText: input.extractedText, threshold: input.run.threshold });
    expect(display.counts).toMatchObject({ evaluated: 0, insufficient: 1, rawFlaggedCount: 0 });
    const text = canonicalPdfText(await textFromPdf(await new ReportRenderer().renderAIParagraphTechnical(input)));
    expect(text).toContain('Señal local estimada: NO EVALUADO');
    expect(text).not.toContain('83.2 %');
    expect(JSON.stringify(input)).toBe(before);
  });

  it.skipIf(!popplerAvailable)('keeps eight body score cards and every source segment while compacting sixty structural fragments', async () => {
    const fixture = await createPresentationHardeningFixture();
    const snapshot = JSON.stringify(fixture.input);
    const groupingStart = performance.now();
    const display = buildTechnicalDisplayUnits(fixture.input.paragraphs, { extractedText: fixture.input.extractedText, threshold: fixture.input.run.threshold });
    const groupingMs = performance.now() - groupingStart;
    expect(display.units.filter((unit) => unit.type === 'EVALUATED_SEGMENT')).toHaveLength(8);
    expect(display.units.filter((unit) => unit.type.endsWith('_GROUP'))).toHaveLength(3);
    expect(display.audit).toMatchObject({ sourceSegmentsTotal: 68, sourceSegmentsRepresented: 68, sourceSegmentsLost: 0, sourceSegmentsDuplicated: 0, evaluatedDisplayUnits: 10 });
    expect(display.counts).toMatchObject({ totalSegments: 68, evaluated: 10, insufficient: 58, rawFlaggedCount: 5, actionableHighlightCount: 3, presentationExcludedFlagged: 2 });
    for (const unit of display.units.filter((unit) => unit.type.endsWith('_GROUP'))) expect(unit).not.toHaveProperty('score');
    const renderStart = performance.now();
    const pdf = await new ReportRenderer().renderAIParagraphTechnical(fixture.input);
    const renderMs = performance.now() - renderStart;
    const pages = (await PDFDocument.load(pdf)).getPageCount();
    // The same fixture measured 13 pages in the F009.4.1 renderer; no target page count is forced.
    expect(pages).toBeLessThan(13);
    const text = await textFromPdf(pdf);
    const canonical = canonicalPdfText(text);
    expect(text.match(/PÁRRAFO\s+\d+/gu)).toHaveLength(8);
    expect(text).toContain('43.4 %');
    expect(text).toContain('59.0 %');
    expect(text).toContain('TABLA / ESTRUCTURA TABULAR');
    expect(text).toContain('DATOS DE PORTADA / METADATA');
    expect(text).toContain('REFERENCIAS');
    expect(text).toContain('REFERENCE_SECTION');
    expect(text).toContain('EXCLUIDO DE REVISIÓN VISUAL');
    expect(canonical).toMatch(/SEGMENTO 1\s*\|\s*95\.0 %\s*\|\s*SEÑALADO/u);
    expect(canonical).toMatch(/SEGMENTO 39\s*\|\s*91\.0 %\s*\|\s*SEÑALADO/u);
    const body = fixture.input.paragraphs.filter((segment) => segment.kind === 'PARAGRAPH');
    for (const segment of body) {
      const label = `PÁRRAFO ${segment.paragraphIndex + 1}`;
      const start = canonical.indexOf(label);
      expect(start).toBeGreaterThan(-1);
      expect(canonical.slice(start, start + 220)).toContain((segment.score! * 100).toFixed(1) + ' %');
    }
    for (const segment of fixture.input.paragraphs) expect(canonical).toContain(segment.textPreview);
    expect(JSON.stringify(fixture.input)).toBe(snapshot);
    console.info(JSON.stringify({ event: 'synthetic_pdf_presentation_benchmark', sourceSegments: 68, displayUnits: display.units.length, structuralGroups: display.counts.structuralGroups, evaluatedBodyCards: 8, oldPages: 13, newPages: pages, groupingMs: Number(groupingMs.toFixed(3)), renderMs: Number(renderMs.toFixed(3)), heapUsedBytes: process.memoryUsage().heapUsed }));
  }, 30_000);

  it.skipIf(!popplerAvailable)('shows two exact evaluated table annotations without inventing a table score', async () => {
    const fixture = await createPresentationHardeningFixture();
    const table = fixture.input.paragraphs.filter((segment) => segment.kind === 'TABLE_CELL').slice(0, 10).map((segment, paragraphIndex) => {
      const score = paragraphIndex === 2 ? 0.63241 : paragraphIndex === 7 ? 0.43219 : null;
      return { ...segment, paragraphIndex, score, classification: score === null ? 'INSUFFICIENT_TEXT' : score >= 0.59 ? 'MACHINE_SIGNAL' : 'LOW_SIGNAL', presentationExcluded: score === null, excludedReason: score === null ? 'INSUFFICIENT_TEXT' : undefined, reviewPresentation: { highlight: score !== null && score >= 0.59, level: null, ...(score === null ? { excludedReason: 'INSUFFICIENT_TEXT' as const } : {}) }, segmentEvidence: { ...segment.segmentEvidence, paragraphId: paragraphIndex, score } };
    });
    const input: AIReportInput = { ...fixture.input, paragraphs: table, run: { ...fixture.input.run, scoredSegments: 2, insufficientSegments: 8 } };
    const snapshot = JSON.stringify(input);
    const display = buildTechnicalDisplayUnits(input.paragraphs, { extractedText: input.extractedText, threshold: input.run.threshold });
    expect(display.units).toHaveLength(1);
    expect(display.units[0]).toMatchObject({ type: 'TABLE_GROUP' });
    expect(display.units[0]!.sourceSegmentIds).toHaveLength(10);
    expect(display.units[0]).not.toHaveProperty('score');
    const text = canonicalPdfText(await textFromPdf(await new ReportRenderer().renderAIParagraphTechnical(input)));
    expect(text).toMatch(/SEGMENTO 3\s*\|\s*63\.2 %\s*\|\s*SEÑALADO/u);
    expect(text).toMatch(/SEGMENTO 8\s*\|\s*43\.2 %\s*\|\s*NO SEÑALADO/u);
    expect(text).toContain('8 elementos NO EVALUADOS');
    expect(text).not.toContain('Score de tabla');
    expect(input.paragraphs[2]!.score).toBe(0.63241);
    expect(input.paragraphs[7]!.score).toBe(0.43219);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it.skipIf(!popplerAvailable)('keeps a scored reference heading with its first score and source line', async () => {
    const fixture = await createPresentationHardeningFixture();
    const reference = buildTechnicalDisplayUnits(fixture.input.paragraphs, { extractedText: fixture.input.extractedText, threshold: fixture.input.run.threshold }).units.find((unit) => unit.type === 'REFERENCE_GROUP')!;
    // Put the block exactly where the old 86 pt reservation stranded its heading.
    const renderer = new ReportRenderer() as unknown as {
      renderPdf(title: string, reportId: string, generatedAt: Date, draw: (doc: PDFKit.PDFDocument) => void, includeReportId: boolean, useTechnicalUnicodeFonts: boolean): Promise<Buffer>;
      technicalStructuralBlock(doc: PDFKit.PDFDocument, unit: typeof reference, threshold: number | null): void;
    };
    const pdf = await renderer.renderPdf('Synthetic reference pagination', fixture.input.reportId, fixture.input.generatedAt, (doc) => {
      doc.y = doc.page.height - doc.page.margins.bottom - 100;
      renderer.technicalStructuralBlock(doc, reference, fixture.input.run.threshold);
    }, false, true);
    const pages = (await textFromPdf(pdf)).split('\f').map(canonicalPdfText);
    const referencePage = pages.find((page) => page.includes('REFERENCIAS'));
    expect(referencePage).toBeDefined();
    expect(referencePage).toMatch(/SEGMENTO 39\s*\|\s*91\.0 %\s*\|\s*SEÑALADO/u);
    expect(referencePage).toContain(fixture.input.paragraphs[38]!.textPreview);
  });

  it.skipIf(!popplerAvailable)('embeds searchable Unicode fonts for synthetic math, combining diacritics and subscript digits', async () => {
    const fixture = await createPresentationHardeningFixture();
    const unicodeText = 'Synthetic Unicode math and diacritics: T\u0302 = 1; α = 0.05; x − y = −2; x₁ = 1; x₂ = 2; H₂O; ₀₁₂₃₄₅₆₇₈₉. El análisis conserva señal, estimación, pingüino y Ñ.';
    const body = fixture.input.paragraphs.find((segment) => segment.kind === 'PARAGRAPH')!;
    const segment = { ...body, paragraphIndex: 0, charStart: 0, charEnd: unicodeText.length, textPreview: unicodeText, textHash: sha256(unicodeText), segmentEvidence: { ...body.segmentEvidence, paragraphId: 0, start: 0, end: unicodeText.length } };
    const input: AIReportInput = { ...fixture.input, extractedText: unicodeText, paragraphs: [segment], run: { ...fixture.input.run, scoredSegments: 1, insufficientSegments: 0 } };
    const snapshot = JSON.stringify(input);
    const pdf = await new ReportRenderer().renderAIParagraphTechnical(input);
    expect(canonicalPdfText((await textFromPdf(pdf)).normalize('NFC'))).toContain(unicodeText.normalize('NFC'));
    const document = await PDFDocument.load(pdf);
    const fontDictionary = document.getPages()[1]!.node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const fonts = fontDictionary.values().map((font) => document.context.lookup(font, PDFDict));
    expect(fonts.some((font) => font.has(PDFName.of('ToUnicode')))).toBe(true);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it.skipIf(!popplerAvailable)('separates detector flags, actionable review flags, and excluded flags on the original cover', async () => {
    const fixture = await createPresentationHardeningFixture();
    const input: AIReportInput = { ...fixture.input, paragraphs: fixture.input.paragraphs.map((segment) => segment.kind === 'PARAGRAPH' && segment.paragraphIndex === 37 ? { ...segment, score: 0.59, classification: 'MACHINE_SIGNAL', signalLevel: 'HIGH', reviewPresentation: { highlight: true, level: 'HIGH' as const }, segmentEvidence: { ...segment.segmentEvidence, score: 0.59, level: 'HIGH' } } : segment) };
    const identity = { sourceArtifactType: 'DOCUMENT_VERSION' as const, documentId: input.document.id, documentVersionId: input.document.documentVersionId, analysisRunId: input.run.id, sourceChecksum: input.document.sourceChecksum };
    const renderer = new OriginalDocumentRenderer(null as never, null as never, null as never);
    const pdf = await renderer.renderOriginalReview(input, {
      source: identity,
      artifact: { documentId: input.document.id, documentVersionId: input.document.documentVersionId, sourceChecksum: input.document.sourceChecksum, renderChecksum: sha256(fixture.source), sourceType: 'PDF' } as never,
      buffer: fixture.source,
      layoutMap: { version: 'cover-count-test', source: identity, pages: [], segments: [] },
    });
    const text = canonicalPdfText(await textFromPdf(pdf));
    expect(text).toMatch(/Señalados por detector\s+6/u);
    expect(text).toMatch(/Resaltados para revisión\s+4/u);
    expect(text).toMatch(/Señalados excluidos\s+2/u);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(19);
    expect(text).toContain('43.4 %');
    expect(text).toContain('59.0 %');
  });
});
