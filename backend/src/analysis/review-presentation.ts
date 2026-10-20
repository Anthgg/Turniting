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
export type ReviewGranularity = 'PARAGRAPH' | 'SPAN';

export interface ReviewSpan {
  startChar: number;
  endChar: number;
  confidence?: number;
  label?: string;
}

export interface PythonCodePointSpan {
  startCodePoint: number;
  endCodePoint: number;
  confidence?: number;
  label?: string;
}

export interface ReviewEvidence {
  evaluated: boolean;
  flagged: boolean;
  score: number | null;
  threshold: number | null;
  presentationExcluded: boolean;
  excludedReason?: ReviewExcludedReason;
  granularity: ReviewGranularity;
  paragraphFlagged: boolean;
  spans: ReviewSpan[];
  fallbackReason?: 'SPAN_EVIDENCE_UNAVAILABLE';
}

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
  calibratedScore?: number | null;
  evidence?: unknown;
  /** Optional persisted structure hints; these never change scientific scores. */
  structuralType?: string | null;
  kind?: string | null;
}

export type ReviewStructuralType =
  | 'BODY'
  | 'REFERENCE_SECTION'
  | 'ANNEX_SECTION'
  | 'METADATA'
  | 'CAPTION'
  | 'HEADING'
  | 'TABLE_CELL';

export type ReferenceSectionStartRule =
  | 'EXACT_HEADING'
  | 'INLINE_COLON'
  | 'NUMBERED_HEADING'
  | 'HEADING_LINE';

export interface ReferenceSectionStartDetection {
  /** The normalized heading only: bibliographic/private contents are omitted. */
  heading: string;
  rule: ReferenceSectionStartRule;
  inline: boolean;
  numbered: boolean;
}

export interface ReferenceSectionDetectionContext {
  /** Allows a separate heading line and content when format metadata confirms it. */
  headingLike?: boolean;
}

export interface ReferenceSectionRange extends ReferenceSectionStartDetection {
  startOffset: number;
  endOffset: number;
  /** Persisted, zero-based paragraph indexes, never newly segmented positions. */
  startSegment: number;
  endSegmentExclusive: number;
}

export interface ReviewDocumentContext {
  extractedText: string;
  segments: readonly VerifiedReviewRange[];
  referenceSectionStart: number | null;
  referenceSectionStartSegment: number | null;
  referenceSections: readonly ReferenceSectionRange[];
  annexSectionStart: number | null;
  annexSectionStartSegment: number | null;
  structuralTypeByParagraphIndex: ReadonlyMap<number, ReviewStructuralType>;
  byParagraphIndex: ReadonlyMap<number, VerifiedReviewRange>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Validates persisted, end-exclusive offsets and hashes against extractedText. */
export function verifyReportReviewRanges<T extends ReviewRange>(
  extractedText: string,
  ranges: readonly T[],
): (T & VerifiedReviewRange)[] {
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
    const normalizedText = text.replace(/\s+/gu, ' ').trim();
    if (!range.textHash || sha256(normalizedText) !== range.textHash) {
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
  const referenceSections: ReferenceSectionRange[] = [];
  const structuralTypeByParagraphIndex = new Map<number, ReviewStructuralType>();
  let activeReference: ReferenceSectionRange | null = null;
  let inAnnex = false;
  let annexSectionStart: number | null = null;
  let annexSectionStartSegment: number | null = null;

  for (const segment of verifiedSegments) {
    const hint = (segment.structuralType ?? segment.kind ?? '').toUpperCase();
    const referenceStart = detectReferenceSectionStart(segment.text, {
      headingLike: ['HEADING', 'SECTION_HEADING'].includes(hint),
    });
    const annexStart = isAnnexSectionHeading(segment.text);
    if (annexStart) {
      if (activeReference) {
        activeReference.endOffset = segment.charStart;
        activeReference.endSegmentExclusive = segment.paragraphIndex;
        activeReference = null;
      }
      inAnnex = true;
      annexSectionStart ??= segment.charStart;
      annexSectionStartSegment ??= segment.paragraphIndex;
    } else if (referenceStart && !activeReference) {
      activeReference = {
        ...referenceStart,
        startOffset: segment.charStart,
        endOffset: extractedText.length,
        startSegment: segment.paragraphIndex,
        endSegmentExclusive: (verifiedSegments.at(-1)?.paragraphIndex ?? -1) + 1,
      };
      referenceSections.push(activeReference);
      inAnnex = false;
    }
    structuralTypeByParagraphIndex.set(
      segment.paragraphIndex,
      activeReference
        ? 'REFERENCE_SECTION'
        : classifyReviewStructure(segment, segment.text, annexStart, inAnnex),
    );
  }
  return {
    extractedText,
    segments: verifiedSegments,
    referenceSectionStart: referenceSections[0]?.startOffset ?? null,
    referenceSectionStartSegment: referenceSections[0]?.startSegment ?? null,
    referenceSections,
    annexSectionStart,
    annexSectionStartSegment,
    structuralTypeByParagraphIndex,
    byParagraphIndex,
  };
}

export function validateReportReviewEvidenceSpans(
  paragraphText: string,
  spans: readonly ReviewSpan[] | undefined,
): void {
  if (!spans?.length) return;
  for (const span of spans) {
    if (
      !Number.isSafeInteger(span.startChar) ||
      !Number.isSafeInteger(span.endChar) ||
      span.startChar < 0 ||
      span.endChar <= span.startChar ||
      span.endChar > paragraphText.length ||
      splitsSurrogatePair(paragraphText, span.startChar) ||
      splitsSurrogatePair(paragraphText, span.endChar) ||
      (span.confidence !== undefined &&
        (!Number.isFinite(span.confidence) || span.confidence < 0 || span.confidence > 1)) ||
      (span.label !== undefined && typeof span.label !== 'string')
    ) {
      throw new ReportReviewIntegrityError('ANALYSIS_SEGMENT_SPANS_INVALID');
    }
  }
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** Convert a Python codepoint offset to the UTF-16 offset used by JavaScript strings. */
export function codePointOffsetToUtf16(text: string, codePointOffset: number): number {
  if (!Number.isSafeInteger(codePointOffset) || codePointOffset < 0) {
    throw new ReportReviewIntegrityError('ANALYSIS_SEGMENT_SPANS_INVALID');
  }
  let codePoints = 0;
  let utf16 = 0;
  for (const character of text) {
    if (codePoints === codePointOffset) return utf16;
    codePoints += 1;
    utf16 += character.length;
  }
  if (codePoints === codePointOffset) return utf16;
  throw new ReportReviewIntegrityError('ANALYSIS_SEGMENT_SPANS_INVALID');
}

/** Convert Python paragraph ranges to JavaScript UTF-16 offsets. */
export function convertPythonSegmentOffsetsToUtf16<T extends ReviewRange>(
  text: string,
  segments: readonly T[],
): T[] {
  return segments.map((segment) => ({
    ...segment,
    charStart: codePointOffsetToUtf16(text, segment.charStart),
    charEnd: codePointOffsetToUtf16(text, segment.charEnd),
  }));
}

/** Accept older persisted Python codepoint ranges and normalize them after verifying their hashes. */
export function normalizeReviewSegmentOffsets<T extends ReviewRange>(
  text: string,
  segments: readonly T[],
): T[] {
  try {
    verifyReportReviewRanges(text, segments);
    return segments.map((segment) => ({ ...segment }));
  } catch (error) {
    if (!(error instanceof ReportReviewIntegrityError)) throw error;
    const converted = convertPythonSegmentOffsetsToUtf16(text, segments);
    verifyReportReviewRanges(text, converted);
    return converted;
  }
}

/** Convert service-side Python codepoint spans before exposing UTF-16 evidence to clients. */
export function convertPythonSpansToUtf16(
  text: string,
  spans: readonly PythonCodePointSpan[],
): ReviewSpan[] {
  const converted = spans.map((span) => ({
    startChar: codePointOffsetToUtf16(text, span.startCodePoint),
    endChar: codePointOffsetToUtf16(text, span.endCodePoint),
    ...(span.confidence !== undefined ? { confidence: span.confidence } : {}),
    ...(span.label !== undefined ? { label: span.label } : {}),
  }));
  validateReportReviewEvidenceSpans(text, converted);
  return converted;
}

/** Sort and merge overlaps for display without changing persisted evidence. */
export function mergeReviewSpansForDisplay(
  spans: readonly ReviewSpan[],
): ReviewSpan[] {
  const ordered = spans
    .map((span) => ({ ...span }))
    .sort((left, right) => left.startChar - right.startChar || left.endChar - right.endChar);
  const merged: ReviewSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous && span.startChar < previous.endChar) {
      previous.endChar = Math.max(previous.endChar, span.endChar);
      continue;
    }
    merged.push(span);
  }
  return merged;
}

const REFERENCE_HEADINGS = new Set([
  'bibliografía',
  'bibliografías',
  'bibliografia',
  'bibliografias',
  'bibliography',
  'fuentes bibliograficas',
  'fuentes bibliográficas',
  'literatura citada',
  'literature cited',
  'referencia',
  'referencias',
  'referencias bibliográficas',
  'referencias bibliograficas',
  'references',
  'works cited',
]);

function normalizeHeading(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('es-PE');
}

function withoutSectionNumber(value: string): { text: string; numbered: boolean } {
  const match = /^(\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s+(.+)$/u.exec(value);
  if (!match) return { text: value, numbered: false };
  const prefix = match[1]!;
  const roman = /^(?=[ivxlcdm]+$)m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/u;
  if (!/^\d/u.test(prefix) && !roman.test(prefix)) {
    return { text: value, numbered: false };
  }
  return { text: match[2]!, numbered: true };
}

/** Anchored heading syntax, never a substring search through body prose. */
export function detectReferenceSectionStart(
  value: string,
  context: ReferenceSectionDetectionContext = {},
): ReferenceSectionStartDetection | null {
  const normalized = normalizeHeading(value);
  const candidate = withoutSectionNumber(normalized);
  const colon = candidate.text.search(/[:：]/u);
  const heading = (colon < 0 ? candidate.text : candidate.text.slice(0, colon)).trim();
  if (REFERENCE_HEADINGS.has(heading)) {
    const inline = colon >= 0 && candidate.text.slice(colon + 1).trim().length > 0;
    return {
      heading,
      rule: inline ? 'INLINE_COLON' : candidate.numbered ? 'NUMBERED_HEADING' : 'EXACT_HEADING',
      inline,
      numbered: candidate.numbered,
    };
  }
  if (context.headingLike) {
    const firstLine = value.normalize('NFC').trim().split(/\r?\n/u)[0] ?? '';
    const lineCandidate = withoutSectionNumber(normalizeHeading(firstLine));
    if (REFERENCE_HEADINGS.has(lineCandidate.text)) {
      return {
        heading: lineCandidate.text,
        rule: 'HEADING_LINE',
        inline: true,
        numbered: lineCandidate.numbered,
      };
    }
  }
  return null;
}

export function isReferenceHeading(value: string): boolean {
  return detectReferenceSectionStart(value) !== null;
}

export function findReferenceSectionStart(
  ranges: readonly VerifiedReviewRange[],
): number | null {
  return ranges.find((range) => detectReferenceSectionStart(range.text))?.charStart ?? null;
}

/** Only an explicit annex heading ends the reference section. */
export function isAnnexSectionHeading(value: string): boolean {
  const candidate = withoutSectionNumber(normalizeHeading(value)).text;
  const match = /^(?:anexos?|appendix|appendices|ap[eé]ndices?)(.*)$/u.exec(candidate);
  if (!match) return false;
  const remainder = match[1]!;
  if (!remainder || /^\s*[:：](?:\s+.+)?$/u.test(remainder)) return true;
  const identifier = /^\s+([a-z]|\d+|[ivxlcdm]+)(?:\s*[:：](?:\s+.+)?)?$/u.exec(remainder)?.[1];
  if (!identifier) return false;
  return identifier.length === 1 || /^\d/u.test(identifier) ||
    /^(?=[ivxlcdm]+$)m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/u.test(identifier);
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

function classifyReviewStructure(
  segment: ReviewSegment,
  text: string,
  annexHeading: boolean,
  inAnnex: boolean,
): ReviewStructuralType {
  const hint = (segment.structuralType ?? segment.kind ?? '').toUpperCase();
  if (annexHeading) return 'HEADING';
  if (['TABLE', 'TABLE_CELL', 'TABLE_FRAGMENT'].includes(hint)) return 'TABLE_CELL';
  if (['METADATA', 'COVER_METADATA'].includes(hint)) return 'METADATA';
  if (['CAPTION', 'FIGURE_CAPTION', 'TABLE_CAPTION'].includes(hint)) return 'CAPTION';
  if (['HEADING', 'SECTION_HEADING', 'TITLE'].includes(hint)) return 'HEADING';
  if (metadataReason(segment, text)) return 'METADATA';
  if (captionReason(text)) return 'CAPTION';
  if (segment.classification === 'INSUFFICIENT_TEXT' && isLikelyHeading(text)) return 'HEADING';
  return inAnnex ? 'ANNEX_SECTION' : 'BODY';
}

/** Cheap shared structure lookup for display grouping; no segment is rewritten. */
export function getReviewStructuralType(
  segment: ReviewSegment,
  documentContext: ReviewDocumentContext,
): ReviewStructuralType {
  return documentContext.structuralTypeByParagraphIndex.get(segment.paragraphIndex) ?? 'BODY';
}

/** Shared presentation policy for the analysis UI and AI report renderer. */
export function getReviewPresentation(
  segment: ReviewSegment,
  documentContext: ReviewDocumentContext,
  threshold: number | null = null,
): ReviewPresentation {
  const evidence = getReviewEvidence(segment, threshold, documentContext);
  const level = ['HIGH', 'MODERATE', 'LOW'].includes(
    segment.signalLevel?.toUpperCase() ?? '',
  )
    ? (segment.signalLevel!.toUpperCase() as ReviewLevel)
    : null;
  return {
    highlight: evidence.flagged && !evidence.presentationExcluded,
    level,
    ...(evidence.excludedReason ? { excludedReason: evidence.excludedReason } : {}),
  };
}

/** Authoritative actionability: persisted run threshold plus presentation exclusions. */
export function getReviewEvidence(
  segment: ReviewSegment,
  threshold: number | null,
  documentContext: ReviewDocumentContext,
): ReviewEvidence {
  const verified = documentContext.byParagraphIndex.get(segment.paragraphIndex);
  if (
    !verified ||
    verified.charStart !== segment.charStart ||
    verified.charEnd !== segment.charEnd ||
    verified.textHash !== segment.textHash
  ) {
    return {
      evaluated: false,
      flagged: false,
      score: segment.calibratedScore ?? null,
      threshold,
      presentationExcluded: true,
      excludedReason: 'UNSCORED',
      granularity: 'PARAGRAPH',
      paragraphFlagged: false,
      spans: [],
    };
  }

  const text = verified.text;
  let excludedReason: ReviewExcludedReason | undefined;

  const structuralType = getReviewStructuralType(segment, documentContext);
  if (structuralType === 'REFERENCE_SECTION') {
    excludedReason = 'REFERENCE_SECTION';
  } else if (['METADATA', 'CAPTION', 'HEADING'].includes(structuralType)) {
    excludedReason = structuralType as 'METADATA' | 'CAPTION' | 'HEADING';
  } else {
    excludedReason = metadataReason(segment, text) ?? captionReason(text) ?? undefined;
  }

  if (!excludedReason && segment.classification === 'INSUFFICIENT_TEXT') {
    excludedReason = isLikelyHeading(text) ? 'HEADING' : 'INSUFFICIENT_TEXT';
  }
  const score = segment.calibratedScore ?? null;
  const evaluated = segment.classification !== 'INSUFFICIENT_TEXT' &&
    typeof score === 'number' && Number.isFinite(score);
  if (!evaluated && !excludedReason) excludedReason = 'UNSCORED';
  const flagged = evaluated && typeof threshold === 'number' && Number.isFinite(threshold) && score! >= threshold;

  const rawEvidence = segment.evidence;
  const record = rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)
    ? rawEvidence as Record<string, unknown>
    : null;
  const rawGranularity = record?.granularity ?? record?.type;
  const granularity: ReviewGranularity = rawGranularity === 'SPAN' ? 'SPAN' : 'PARAGRAPH';
  const rawSpans = Array.isArray(record?.spans) ? record.spans : [];
  const spans: ReviewSpan[] = rawSpans.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ReportReviewIntegrityError('ANALYSIS_SEGMENT_SPANS_INVALID');
    }
    const item = value as Record<string, unknown>;
    if (item.startCodePoint !== undefined || item.endCodePoint !== undefined) {
      if (
        typeof item.startCodePoint !== 'number' ||
        typeof item.endCodePoint !== 'number' ||
        (item.confidence !== undefined && typeof item.confidence !== 'number') ||
        (item.label !== undefined && typeof item.label !== 'string')
      ) {
        throw new ReportReviewIntegrityError('ANALYSIS_SEGMENT_SPANS_INVALID');
      }
      return convertPythonSpansToUtf16(text, [{
        startCodePoint: item.startCodePoint,
        endCodePoint: item.endCodePoint,
        ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
      }])[0]!;
    }
    if (
      typeof item.startChar !== 'number' ||
      typeof item.endChar !== 'number' ||
      (item.confidence !== undefined && typeof item.confidence !== 'number') ||
      (item.label !== undefined && typeof item.label !== 'string')
    ) {
      throw new ReportReviewIntegrityError('ANALYSIS_SEGMENT_SPANS_INVALID');
    }
    return {
      startChar: item.startChar,
      endChar: item.endChar,
      ...(typeof item.confidence === 'number' ? { confidence: item.confidence } : {}),
      ...(typeof item.label === 'string' ? { label: item.label } : {}),
    };
  });
  validateReportReviewEvidenceSpans(text, spans);
  const fallbackReason = granularity === 'SPAN' && flagged && spans.length === 0
    ? 'SPAN_EVIDENCE_UNAVAILABLE' as const
    : undefined;
  const presentationExcluded = excludedReason !== undefined && excludedReason !== 'UNSCORED';

  return {
    evaluated,
    flagged,
    score,
    threshold,
    presentationExcluded,
    ...(excludedReason ? { excludedReason } : {}),
    granularity,
    paragraphFlagged: flagged,
    spans,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}
