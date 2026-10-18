import { createHash } from 'node:crypto';

export interface ReviewRange {
  paragraphIndex: number;
  textHash: string;
  charStart: number;
  charEnd: number;
}

export interface VerifiedReviewRange extends ReviewRange {
  text: string;
}

export type ReviewIntegrityCode =
  | 'ANALYSIS_SEGMENT_OFFSETS_INVALID'
  | 'ANALYSIS_SEGMENT_TEXT_MISMATCH'
  | 'ANALYSIS_SEGMENT_SPANS_INVALID';

export class ReportReviewIntegrityError extends Error {
  constructor(readonly code: ReviewIntegrityCode) {
    super('El texto del análisis no coincide con los rangos guardados.');
    this.name = 'ReportReviewIntegrityError';
  }
}

export type ReviewLevel = 'HIGH' | 'MODERATE' | 'LOW';

export type ReviewExcludedReason =
  | 'REFERENCE_SECTION'
  | 'METADATA'
  | 'CAPTION'
  | 'HEADING'
  | 'INSUFFICIENT_TEXT'
  | 'LOW_SIGNAL'
  | 'UNSCORED';

export interface ReviewPresentation {
  highlight: boolean;
  level: ReviewLevel | null;
  excludedReason?: ReviewExcludedReason;
}

export interface ReviewSegment extends ReviewRange {
  signalLevel: string | null;
  classification: string;
}

export interface ReviewDocumentContext {
  extractedText: string;
  segments: readonly VerifiedReviewRange[];
  referenceSectionStart: number | null;
  byParagraphIndex: ReadonlyMap<number, VerifiedReviewRange>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Validates persisted, end-exclusive offsets and hashes against extractedText. */
export function verifyReportReviewRanges(
  extractedText: string,
  ranges: readonly ReviewRange[],
): VerifiedReviewRange[] {
  const ordered = [...ranges].sort(
    (left, right) =>
      left.charStart - right.charStart ||
      left.charEnd - right.charEnd ||
      left.paragraphIndex - right.paragraphIndex,
  );
  const paragraphIndexes = new Set<number>();
  let previousEnd = 0;

  for (const range of ordered) {
    if (
      !Number.isSafeInteger(range.paragraphIndex) ||
      range.paragraphIndex < 0 ||
      paragraphIndexes.has(range.paragraphIndex) ||
      !Number.isSafeInteger(range.charStart) ||
      !Number.isSafeInteger(range.charEnd) ||
      range.charStart < 0 ||
      range.charEnd < range.charStart ||
      range.charEnd > extractedText.length ||
      range.charStart < previousEnd
    ) {
      throw new ReportReviewIntegrityError(
        'ANALYSIS_SEGMENT_OFFSETS_INVALID',
      );
    }

    const text = extractedText.slice(range.charStart, range.charEnd);
    if (!range.textHash || sha256(text) !== range.textHash) {
      throw new ReportReviewIntegrityError('ANALYSIS_SEGMENT_TEXT_MISMATCH');
    }
    paragraphIndexes.add(range.paragraphIndex);
    previousEnd = range.charEnd;
  }

  return ordered.map((range) => ({
    ...range,
    text: extractedText.slice(range.charStart, range.charEnd),
  }));
}

export function createReviewDocumentContext(
  extractedText: string,
  segments: readonly ReviewSegment[],
): ReviewDocumentContext {
  const verifiedSegments = verifyReportReviewRanges(extractedText, segments);
  const byParagraphIndex = new Map(
    verifiedSegments.map((segment) => [segment.paragraphIndex, segment]),
  );
  return {
    extractedText,
    segments: verifiedSegments,
    referenceSectionStart: findReferenceSectionStart(verifiedSegments),
    byParagraphIndex,
  };
}

export function validateReportReviewEvidenceSpans(
  range: ReviewRange,
  spans: readonly { charStart: number; charEnd: number }[] | undefined,
): void {
  if (!spans?.length) return;
  let previousEnd = range.charStart;
  for (const span of spans) {
    if (
      !Number.isSafeInteger(span.charStart) ||
      !Number.isSafeInteger(span.charEnd) ||
      span.charStart < range.charStart ||
      span.charEnd <= span.charStart ||
      span.charEnd > range.charEnd ||
      span.charStart < previousEnd
    ) {
      throw new ReportReviewIntegrityError('ANALYSIS_SEGMENT_SPANS_INVALID');
    }
    previousEnd = span.charEnd;
  }
}

const REFERENCE_HEADINGS = new Set([
  'bibliografia',
  'bibliografias',
  'bibliography',
  'fuentes bibliograficas',
  'literatura citada',
  'literature cited',
  'referencia',
  'referencias',
  'references',
  'works cited',
]);

function normalizeHeading(value: string): string {
  return value
    .trim()
    .replace(/^(?:\d+(?:\.\d+)*\.?\s+)/u, '')
    .replace(/[:：]\s*$/u, '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('es-PE');
}

export function isReferenceHeading(value: string): boolean {
  return REFERENCE_HEADINGS.has(normalizeHeading(value));
}

export function findReferenceSectionStart(
  ranges: readonly VerifiedReviewRange[],
): number | null {
  return ranges.find((range) => isReferenceHeading(range.text))?.charStart ?? null;
}

function isLikelyHeading(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 125 || /[.!?。！？]$/u.test(text)) return false;
  if (/^(?:\d+\.)*\d+\.?\s+\S/u.test(text)) return true;
  return (
    text.split(/\s+/u).length <= 8 &&
    /^[\p{Lu}][^\n.!?;]{0,90}$/u.test(text)
  );
}

function metadataReason(
  segment: ReviewSegment,
  text: string,
): ReviewExcludedReason | null {
  if (segment.paragraphIndex > 24 || segment.charStart > 5000) return null;
  if (
    segment.paragraphIndex <= 1 &&
    segment.charStart < 500 &&
    isLikelyHeading(text)
  ) {
    return 'METADATA';
  }
  if (
    /^(?:autor(?:es)?|author(?:s)?|orcid|correo|email|e-mail|universidad|university|asesor(?:a)?|advisor|línea de investigación|linea de investigacion|research line|fecha(?: de (?:presentación|presentacion|sustentación|sustentacion))?|date)\s*[:：-]/iu.test(
      text.trim(),
    ) ||
    /^\s*orcid\s*[:：]?\s*\d{4}-\d{4}-\d{4}-\d{3}[\dX]\s*$/iu.test(text) ||
    /^\s*[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\s*$/u.test(text)
  ) {
    return 'METADATA';
  }
  return null;
}

function captionReason(text: string): ReviewExcludedReason | null {
  return /^(?:figura|figure|tabla|table)\s+[\p{L}\dIVX]+(?:\s*[:.)-]|$)|^(?:fuente|source|nota|note)\s*[:：]/iu.test(
    text.trim(),
  )
    ? 'CAPTION'
    : null;
}

/** Shared presentation policy for the analysis UI and AI report renderer. */
export function getReviewPresentation(
  segment: ReviewSegment,
  documentContext: ReviewDocumentContext,
): ReviewPresentation {
  const verified = documentContext.byParagraphIndex.get(segment.paragraphIndex);
  if (
    !verified ||
    verified.charStart !== segment.charStart ||
    verified.charEnd !== segment.charEnd ||
    verified.textHash !== segment.textHash
  ) {
    return { highlight: false, level: null, excludedReason: 'UNSCORED' };
  }

  const level = ['HIGH', 'MODERATE', 'LOW'].includes(
    segment.signalLevel?.toUpperCase() ?? '',
  )
    ? (segment.signalLevel!.toUpperCase() as ReviewLevel)
    : null;
  const text = verified.text;

  if (
    documentContext.referenceSectionStart !== null &&
    segment.charStart >= documentContext.referenceSectionStart
  ) {
    return { highlight: false, level, excludedReason: 'REFERENCE_SECTION' };
  }

  const metadata = metadataReason(segment, text);
  if (metadata) return { highlight: false, level, excludedReason: metadata };
  const caption = captionReason(text);
  if (caption) return { highlight: false, level, excludedReason: caption };

  if (segment.classification === 'INSUFFICIENT_TEXT') {
    return {
      highlight: false,
      level,
      excludedReason: isLikelyHeading(text) ? 'HEADING' : 'INSUFFICIENT_TEXT',
    };
  }
  if (!level) return { highlight: false, level, excludedReason: 'UNSCORED' };
  if (level === 'LOW') {
    return { highlight: false, level, excludedReason: 'LOW_SIGNAL' };
  }
  return { highlight: true, level };
}
