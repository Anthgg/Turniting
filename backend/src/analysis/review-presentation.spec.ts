import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  codePointOffsetToUtf16,
  convertPythonSpansToUtf16,
  createReviewDocumentContext,
  getReviewEvidence,
  getReviewPresentation,
  mergeReviewSpansForDisplay,
  normalizeReviewSegmentOffsets,
  ReportReviewIntegrityError,
  validateReportReviewEvidenceSpans,
  type ReviewSegment,
} from './review-presentation.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function segment(text: string, score: number | null, options: Partial<ReviewSegment> = {}): ReviewSegment {
  return {
    paragraphIndex: 0,
    textHash: hash(text),
    charStart: 0,
    charEnd: text.length,
    signalLevel: 'HIGH',
    classification: 'MACHINE_SIGNAL',
    calibratedScore: score,
    ...options,
  };
}

describe('threshold review evidence', () => {
  it.each([
    [0.589999, false],
    [0.59, true],
    [0.590001, true],
  ])('uses the inclusive persisted threshold boundary for score %s', (score, flagged) => {
    const text = 'Synthetic paragraph evaluated for review.';
    const item = segment(text, score);
    const context = createReviewDocumentContext(text, [item]);
    const evidence = getReviewEvidence(item, 0.59, context);
    expect(evidence).toMatchObject({ evaluated: true, flagged, threshold: 0.59 });
    expect(getReviewPresentation(item, context, 0.59).highlight).toBe(flagged);
  });

  it('uses a non-default run threshold without introducing a score band', () => {
    const text = 'Another synthetic paragraph evaluated for review.';
    const item = segment(text, 0.6442953);
    const context = createReviewDocumentContext(text, [item]);
    expect(getReviewEvidence(item, 0.6442953, context).flagged).toBe(true);
    expect(getReviewEvidence(segment(text, 0.6442952), 0.6442953, context).flagged).toBe(false);
  });

  it('keeps scored metadata and references evaluable while excluding them from presentation', () => {
    const texts = ['Autor: Ana Ejemplo', 'Referencias', 'Smith (2024). Synthetic reference.'];
    const fullText = texts.join('\n\n');
    let cursor = 0;
    const segments = texts.map((text, paragraphIndex) => {
      const item = segment(text, 0.95, {
        paragraphIndex,
        charStart: cursor,
        charEnd: cursor + text.length,
        textHash: hash(text),
      });
      cursor += text.length + 2;
      return item;
    });
    const context = createReviewDocumentContext(fullText, segments);
    const metadata = getReviewEvidence(segments[0]!, 0.59, context);
    const reference = getReviewEvidence(segments[2]!, 0.59, context);
    expect(metadata).toMatchObject({ evaluated: true, flagged: true, presentationExcluded: true, excludedReason: 'METADATA' });
    expect(reference).toMatchObject({ evaluated: true, flagged: true, presentationExcluded: true, excludedReason: 'REFERENCE_SECTION' });
    expect(getReviewPresentation(segments[0]!, context, 0.59).highlight).toBe(false);
    expect(getReviewPresentation(segments[2]!, context, 0.59).highlight).toBe(false);
  });

  it('prepares paragraph-relative span evidence and merges visual overlaps without mutation', () => {
    const text = 'ABCDEFGHIJKLMN';
    const spans = [
      { startChar: 2, endChar: 5 },
      { startChar: 8, endChar: 11 },
    ];
    validateReportReviewEvidenceSpans(text, spans);
    expect(spans.map(({ startChar, endChar }) => text.slice(startChar, endChar))).toEqual(['CDE', 'IJK']);
    const overlapping = [{ startChar: 2, endChar: 6 }, { startChar: 5, endChar: 10 }];
    expect(mergeReviewSpansForDisplay(overlapping)).toEqual([{ startChar: 2, endChar: 10 }]);
    expect(overlapping).toEqual([{ startChar: 2, endChar: 6 }, { startChar: 5, endChar: 10 }]);
  });

  it('maps Python codepoint offsets to UTF-16 and rejects split surrogate pairs', () => {
    const text = 'Autenticación 😀 biométrica';
    const pythonOffset = Array.from(text).indexOf('b');
    const utf16Offset = codePointOffsetToUtf16(text, pythonOffset);
    expect(utf16Offset).toBe(text.indexOf('biométrica'));
    expect(text.slice(utf16Offset)).toBe('biométrica');
    const converted = convertPythonSpansToUtf16(text, [{
      startCodePoint: pythonOffset,
      endCodePoint: Array.from(text).length,
    }]);
    expect(text.slice(converted[0]!.startChar, converted[0]!.endChar)).toBe('biométrica');
    const emoji = text.indexOf('😀');
    expect(() => validateReportReviewEvidenceSpans(text, [{ startChar: emoji + 1, endChar: text.length }]))
      .toThrowError(ReportReviewIntegrityError);
  });

  it('normalizes legacy paragraph offsets and Python whitespace-normalized hashes', () => {
    const prefix = 'Título 😀\n\n';
    const paragraph = 'La primera línea describe un caso ficticio.\n   La segunda línea explica cómo revisar la evidencia.';
    const text = `${prefix}${paragraph}`;
    const item = segment(paragraph, 0.8, {
      paragraphIndex: 1,
      charStart: Array.from(prefix).length,
      charEnd: Array.from(text).length,
      textHash: hash(paragraph.replace(/\s+/gu, ' ').trim()),
    });

    const normalized = normalizeReviewSegmentOffsets(text, [item]);
    const context = createReviewDocumentContext(text, normalized);

    expect(normalized[0]?.charStart).toBe(prefix.length);
    expect(normalized[0]?.charEnd).toBe(text.length);
    expect(context.byParagraphIndex.get(1)?.text).toBe(paragraph);
  });

  it('normalizes Python span offsets at the backend evidence boundary', () => {
    const text = 'Autenticación 😀 biométrica';
    const startCodePoint = Array.from(text).findIndex((character) => character === 'b');
    const endCodePoint = Array.from(text).length;
    const item = segment(text, 0.8, {
      evidence: { granularity: 'SPAN', spans: [{ startCodePoint, endCodePoint }] },
    });
    const context = createReviewDocumentContext(text, [item]);
    const spans = getReviewEvidence(item, 0.59, context).spans;
    expect(text.slice(spans[0]!.startChar, spans[0]!.endChar)).toBe('biométrica');
  });

  it('rejects unsafe, non-finite, out-of-bounds, and surrogate-splitting ranges', () => {
    const text = 'ABCDEFGHIJKLMN';
    for (const span of [
      { startChar: Number.NaN, endChar: 2 },
      { startChar: Number.MAX_SAFE_INTEGER + 1, endChar: Number.MAX_SAFE_INTEGER + 2 },
      { startChar: -1, endChar: 2 },
      { startChar: 2, endChar: text.length + 1 },
    ]) {
      expect(() => validateReportReviewEvidenceSpans(text, [span])).toThrowError(ReportReviewIntegrityError);
    }
  });

  it('uses whole-paragraph fallback when future span evidence is unavailable', () => {
    const text = 'Synthetic span-ready paragraph.';
    const item = segment(text, 0.8, { evidence: { granularity: 'SPAN', spans: [] } });
    const context = createReviewDocumentContext(text, [item]);
    expect(getReviewEvidence(item, 0.59, context)).toMatchObject({
      granularity: 'SPAN',
      paragraphFlagged: true,
      spans: [],
      fallbackReason: 'SPAN_EVIDENCE_UNAVAILABLE',
    });
    expect(getReviewPresentation(item, context, 0.59).highlight).toBe(true);
  });
});
