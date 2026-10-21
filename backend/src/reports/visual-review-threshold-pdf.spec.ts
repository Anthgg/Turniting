import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createVisualReviewThresholdFixture, sha256 } from '../../test/fixtures/reports/visual-review-threshold/fixture.mjs';
import { REVIEW_HIGHLIGHT_THRESHOLD, shouldHighlightForReview } from '../analysis/review-highlight-policy.js';
import type { AIReportInput } from './report.contracts.js';
import { OriginalDocumentRenderer, type OriginalRenderResult } from './original-document-renderer.js';
import { ReportRenderer } from './report-renderer.js';
import { isReviewHighlighted, isTechnicalFlagged } from './technical-display.js';

const popplerAvailable = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 5_000 }); return true; } catch { return false; }
})();

function streams(document: PDFDocument, pageIndex: number): PDFRawStream[] {
  const contents = document.getPage(pageIndex).node.lookup(PDFName.of('Contents'));
  return (contents instanceof PDFArray ? contents.asArray() : [contents])
    .map((item) => document.context.lookup(item)).filter((item): item is PDFRawStream => item instanceof PDFRawStream);
}

function decoded(stream: PDFRawStream): string {
  return (stream.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode'
    ? inflateSync(stream.contents) : Buffer.from(stream.contents)).toString('latin1');
}

function originalResult(input: AIReportInput, source: Buffer): OriginalRenderResult {
  const identity = { sourceArtifactType: 'DOCUMENT_VERSION' as const, documentId: input.document.id,
    documentVersionId: input.document.documentVersionId, analysisRunId: input.run.id, sourceChecksum: input.document.sourceChecksum };
  return {
    source: identity,
    artifact: { documentId: identity.documentId, documentVersionId: identity.documentVersionId, sourceChecksum: identity.sourceChecksum, renderChecksum: sha256(source), sourceType: 'PDF' } as never,
    buffer: source,
    layoutMap: { source: identity, version: 'synthetic-visual-review-mapping', pages: [{ pageIndex: 0, width: 595.28, height: 841.89 }],
      segments: input.paragraphs.map((segment, index) => ({ segmentId: segment.paragraphIndex, pageIndexes: [0],
        rectangles: [{ pageIndex: 0, lineIndex: index, x: 48, y: 80 + index * 88, width: 480, height: 42 }],
        matchedTokenCount: segment.words!, totalTokenCount: segment.words!, mappingCoverage: 1, mappingConfidence: 1, mappingStatus: 'LOCATED' as const })) },
  };
}

/** New streams contain graphics only; exact rectangle Y identifies the highlighted source segment. */
function overlayIds(document: PDFDocument, sourceStreamHashes: Set<string>): number[] {
  return streams(document, 1).filter((stream) => !sourceStreamHashes.has(sha256(Buffer.from(stream.contents))))
    .flatMap((stream) => [...decoded(stream).matchAll(/1\s+0\s+0\s+1\s+48\s+([\d.]+)\s+cm/gu)]
      .map((match) => Math.round((841.89 - Number(match[1]) - 42 - 80) / 88)));
}

function pdfText(buffer: Buffer): string {
  return execFileSync('pdftotext', ['-enc', 'UTF-8', '-', '-'], { input: buffer, encoding: 'utf8', timeout: 15_000 })
    .replace(/\s+/gu, ' ');
}

describe('F009.4.3 PDF visual review policy', () => {
  it('highlights five exact source segments while preserving two scientific flags and every original source stream', async () => {
    const fixture = await createVisualReviewThresholdFixture();
    const input: AIReportInput = fixture.input;
    const snapshot = JSON.stringify(input);
    const sourceDocument = await PDFDocument.load(fixture.source);
    const sourceHashes = new Set(streams(sourceDocument, 0).map((stream) => sha256(Buffer.from(stream.contents))));
    const renderer = new OriginalDocumentRenderer(null as never, null as never, null as never);
    const output = await renderer.renderOriginalReview(input, originalResult(input, fixture.source));
    const report = await PDFDocument.load(output);
    expect(input.paragraphs.filter((segment) => isTechnicalFlagged(segment, input.run.threshold)).map((segment) => segment.paragraphIndex)).toEqual(fixture.expectedScientificIds);
    const webHighlightIds = input.paragraphs.filter((segment) => shouldHighlightForReview({ evaluated: true, score: segment.score, presentationExcluded: segment.presentationExcluded })).map((segment) => segment.paragraphIndex);
    expect(webHighlightIds).toEqual(fixture.expectedReviewIds);
    expect(overlayIds(report, sourceHashes)).toEqual(webHighlightIds);
    expect(report.getPageCount()).toBe(fixture.expectedOriginalReviewPages);
    const reportStreams = streams(report, 1);
    for (const hash of sourceHashes) expect(reportStreams.some((stream) => sha256(Buffer.from(stream.contents)) === hash)).toBe(true);
    for (const stream of reportStreams.filter((item) => !sourceHashes.has(sha256(Buffer.from(item.contents))))) {
      expect(decoded(stream)).not.toMatch(/\b(?:Tj|TJ|BT)\b/u);
    }
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('omits exact boundary, excluded and insufficient segments without depending on detector threshold or model', async () => {
    const fixture = await createVisualReviewThresholdFixture();
    const input: AIReportInput = fixture.input;
    const boundaryScores = [REVIEW_HIGHLIGHT_THRESHOLD - 0.000001, REVIEW_HIGHLIGHT_THRESHOLD, REVIEW_HIGHLIGHT_THRESHOLD + 0.000001];
    const scores = [...boundaryScores, 0.95, 0.95, 0.35, 0.83];
    input.paragraphs = input.paragraphs.map((segment, index) => ({ ...segment, score: scores[index]!,
      classification: index === 4 ? 'INSUFFICIENT_TEXT' : 'LOW_SIGNAL', presentationExcluded: index === 3,
      reviewPresentation: { highlight: false, level: 'LOW' }, segmentEvidence: { ...segment.segmentEvidence, score: scores[index]! } }));
    const sourceDocument = await PDFDocument.load(fixture.source);
    const hashes = new Set(streams(sourceDocument, 0).map((stream) => sha256(Buffer.from(stream.contents))));
    const renderer = new OriginalDocumentRenderer(null as never, null as never, null as never);
    for (const [model, threshold] of [['ENSEMBLE_V2_V3', 0.59], ['F006.1', 0.644295302013423], ['F006.1.1', 0.767241379310345], ['future-mock-model', 0.9]] as const) {
      input.run.modelNames = [model]; input.run.threshold = threshold;
      const before = JSON.stringify(input);
      const output = await renderer.renderOriginalReview(input, originalResult(input, fixture.source));
      expect(overlayIds(await PDFDocument.load(output), hashes), model).toEqual([2, 5, 6]);
      expect(JSON.stringify(input)).toBe(before);
    }
    expect(input.paragraphs.filter(isReviewHighlighted).map((segment) => segment.paragraphIndex)).toEqual([2, 5, 6]);
  });

  it.skipIf(!popplerAvailable)('keeps original source text free of local percentages and separates both thresholds on its cover', async () => {
    const fixture = await createVisualReviewThresholdFixture();
    const renderer = new OriginalDocumentRenderer(null as never, null as never, null as never);
    const output = await renderer.renderOriginalReview(fixture.input, originalResult(fixture.input, fixture.source));
    const pages = execFileSync('pdftotext', ['-enc', 'UTF-8', '-', '-'], { input: output, encoding: 'utf8', timeout: 15_000 }).split('\f');
    const cover = pages[0]!.replace(/\s+/gu, ' ');
    expect(cover).toMatch(/Señalados por detector\s+2/u);
    expect(cover).toMatch(/Resaltados para revisión\s+5/u);
    expect(cover).toMatch(/Señalados excluidos\s+0/u);
    expect(cover).toContain('Umbral detector 59.0 %');
    expect(cover).toContain('Umbral revisión visual >20.0 %');
    expect(cover).toContain('independiente del umbral de clasificación del modelo');
    const sourceText = pages.slice(1).join(' ').replace(/\s+/gu, ' ');
    expect(sourceText).not.toContain('%');
    for (const segment of fixture.input.paragraphs) expect(sourceText).toContain(segment.textPreview);
  });

  it.skipIf(!popplerAvailable)('shows local technical scores, scientific detector decisions and individual review states', async () => {
    const fixture = await createVisualReviewThresholdFixture();
    const before = JSON.stringify(fixture.input);
    const output = await new ReportRenderer().renderAIParagraphTechnical(fixture.input);
    const text = pdfText(output);
    expect(text).toContain('UMBRAL DETECTOR 59.0 %');
    expect(text).toContain('UMBRAL REVISIÓN VISUAL >20.0 %');
    for (const [id, score, detector, review] of [[1, '20.0 %', 'NO SEÑALADO', 'NO RESALTADO'], [2, '21.0 %', 'NO SEÑALADO', 'RESALTADO'], [4, '58.0 %', 'NO SEÑALADO', 'RESALTADO'], [5, '59.0 %', 'SEÑALADO', 'RESALTADO']] as const) {
      const start = text.indexOf(`PÁRRAFO ${id + 1}`);
      expect(start).toBeGreaterThan(-1);
      const card = text.slice(start, text.indexOf('The synthetic body', start));
      expect(card).toContain(detector); expect(card).toContain(`Señal local estimada: ${score}`);
      expect(card).toContain(`Revisión visual: ${review}`);
    }
    expect(JSON.stringify(fixture.input)).toBe(before);
  });
});
