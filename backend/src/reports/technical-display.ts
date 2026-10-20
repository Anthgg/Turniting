import type { AIReportParagraph } from './report.contracts.js';

export type TechnicalDisplayUnitType = 'EVALUATED_SEGMENT' | 'INSUFFICIENT_SEGMENT' |
  'STRUCTURAL_GROUP' | 'REFERENCE_GROUP' | 'TABLE_GROUP' | 'METADATA_GROUP' | 'CAPTION_GROUP' | 'HEADING_GROUP';

export interface TechnicalDisplayUnit {
  id: string;
  type: TechnicalDisplayUnitType;
  sourceSegmentIds: number[];
  sourceSegments: AIReportParagraph[];
  positionStart: number;
  positionEnd: number;
  text: string;
  presentationExcluded: boolean;
  excludedReason?: string;
  structuralGroupType?: string;
}

export const TECHNICAL_UNIT_LABELS: Record<TechnicalDisplayUnitType, string> = {
  EVALUATED_SEGMENT: 'SEGMENTO', INSUFFICIENT_SEGMENT: 'SEGMENTO NO EVALUADO',
  STRUCTURAL_GROUP: 'FRAGMENTOS CONTIGUOS', REFERENCE_GROUP: 'REFERENCIAS', TABLE_GROUP: 'TABLA',
  METADATA_GROUP: 'DATOS DE PORTADA / METADATA', CAPTION_GROUP: 'CAPTION', HEADING_GROUP: 'ENCABEZADOS',
};

export function isTechnicalEvaluated(segment: AIReportParagraph): boolean {
  return segment.classification !== 'INSUFFICIENT_TEXT' && typeof segment.score === 'number' && Number.isFinite(segment.score);
}

export function isTechnicalFlagged(segment: AIReportParagraph, threshold: number | null): boolean {
  return isTechnicalEvaluated(segment) && typeof threshold === 'number' && Number.isFinite(threshold) && segment.score! >= threshold;
}

export function isPresentationExcluded(segment: AIReportParagraph): boolean {
  return segment.reviewEvidence?.presentationExcluded ?? segment.presentationExcluded ?? Boolean(segment.reviewPresentation.excludedReason);
}

function category(segment: AIReportParagraph): TechnicalDisplayUnitType {
  const reason = segment.reviewEvidence?.excludedReason ?? segment.excludedReason ?? segment.reviewPresentation.excludedReason;
  const structural = (segment.structuralType ?? segment.kind ?? '').toUpperCase();
  if (reason === 'REFERENCE_SECTION' || structural === 'REFERENCE_SECTION') return 'REFERENCE_GROUP';
  if (reason === 'METADATA' || structural === 'METADATA') return 'METADATA_GROUP';
  if (structural === 'TABLE' || structural === 'TABLE_CELL') return 'TABLE_GROUP';
  if (reason === 'CAPTION' || structural === 'CAPTION') return 'CAPTION_GROUP';
  if (reason === 'HEADING' || structural === 'HEADING') return 'HEADING_GROUP';
  return isTechnicalEvaluated(segment) ? 'EVALUATED_SEGMENT' : 'INSUFFICIENT_SEGMENT';
}

/** A visual transform only. No source mutation, inference, extraction or score aggregation. */
export function buildTechnicalDisplayUnits(
  paragraphs: readonly AIReportParagraph[],
  options: { extractedText: string; threshold: number | null },
) {
  const ordered = [...paragraphs].sort((a, b) => a.charStart - b.charStart || a.paragraphIndex - b.paragraphIndex);
  const ids = new Set<number>();
  let previousEnd = 0;
  for (const segment of ordered) {
    if (ids.has(segment.paragraphIndex) || !Number.isSafeInteger(segment.charStart) ||
      !Number.isSafeInteger(segment.charEnd) || segment.charStart < 0 || segment.charEnd < segment.charStart ||
      segment.charEnd > options.extractedText.length || segment.charStart < previousEnd) throw new Error('TECHNICAL_DISPLAY_SOURCE_INVALID');
    ids.add(segment.paragraphIndex);
    previousEnd = segment.charEnd;
  }
  const units: TechnicalDisplayUnit[] = [];
  for (const segment of ordered) {
    const type = category(segment);
    const previous = units.at(-1);
    const last = previous?.sourceSegments.at(-1);
    const gap = last ? options.extractedText.slice(last.charEnd, segment.charStart) : '';
    const compatiblePage = !last || last.pageNumber === null || segment.pageNumber === null || last.pageNumber === segment.pageNumber;
    const explicitGroup = last?.structuralGroupId && segment.structuralGroupId
      ? last.structuralGroupId === segment.structuralGroupId : !last?.structuralGroupId && !segment.structuralGroupId;
    const insufficientPair = type === 'INSUFFICIENT_SEGMENT' &&
      (previous?.type === 'INSUFFICIENT_SEGMENT' || previous?.type === 'STRUCTURAL_GROUP') &&
      last?.classification === segment.classification && last?.structuralType === segment.structuralType &&
      last?.kind === segment.kind;
    const structuralPair = previous?.type === type && type !== 'EVALUATED_SEGMENT' && type !== 'INSUFFICIENT_SEGMENT';
    const sameReason = !last || (last.reviewEvidence?.excludedReason ?? last.excludedReason ?? last.reviewPresentation.excludedReason) ===
      (segment.reviewEvidence?.excludedReason ?? segment.excludedReason ?? segment.reviewPresentation.excludedReason);
    const contiguous = last && segment.charStart >= last.charEnd && segment.charStart - last.charEnd <= 32 && /^\s*$/u.test(gap);
    // References may cross pages; a table without an explicit table ID stays page-local.
    const pageAllowed = compatiblePage || type === 'REFERENCE_GROUP' || (type === 'TABLE_GROUP' && Boolean(segment.structuralGroupId));
    const join = previous && contiguous && explicitGroup && pageAllowed && (sameReason || type === 'TABLE_GROUP') && (insufficientPair || structuralPair);
    if (join) {
      previous.type = insufficientPair ? 'STRUCTURAL_GROUP' : type;
      previous.structuralGroupType = insufficientPair ? 'CONTIGUOUS_INSUFFICIENT' : previous.structuralGroupType;
      previous.sourceSegmentIds.push(segment.paragraphIndex);
      previous.sourceSegments.push(segment);
      previous.positionEnd = segment.charEnd;
      // Preserve each exact source text. Only whitespace is inserted between members.
      previous.text += `${gap || '\n'}${segment.textPreview}`;
      previous.presentationExcluded = previous.presentationExcluded && isPresentationExcluded(segment);
      if (!sameReason) previous.excludedReason = undefined;
    } else {
      const reason = segment.reviewEvidence?.excludedReason ?? segment.excludedReason ?? segment.reviewPresentation.excludedReason;
      units.push({ id: `display-${segment.paragraphIndex}`, type, sourceSegmentIds: [segment.paragraphIndex],
        sourceSegments: [segment], positionStart: segment.charStart, positionEnd: segment.charEnd,
        text: segment.textPreview, presentationExcluded: isPresentationExcluded(segment),
        ...(reason ? { excludedReason: reason } : {}),
        ...(type.endsWith('_GROUP') ? { structuralGroupType: type.replace(/_GROUP$/u, '') } : {}),
      });
    }
  }
  const represented = units.flatMap(unit => unit.sourceSegmentIds);
  const unique = new Set(represented);
  const evaluated = ordered.filter(isTechnicalEvaluated).length;
  const rawFlaggedCount = ordered.filter(segment => isTechnicalFlagged(segment, options.threshold)).length;
  const presentationExcludedFlagged = ordered.filter(segment => isTechnicalFlagged(segment, options.threshold) && isPresentationExcluded(segment)).length;
  const structuralGroups = units.filter(unit => unit.type.endsWith('_GROUP')).length;
  const counts = { totalSegments: ordered.length, evaluated, insufficient: ordered.length - evaluated,
    rawFlaggedCount, presentationExcludedFlagged, actionableHighlightCount: rawFlaggedCount - presentationExcludedFlagged,
    structuralGroups, evaluatedDisplayUnits: evaluated };
  const audit = { sourceSegmentsTotal: ordered.length, sourceSegmentsRepresented: unique.size,
    sourceSegmentsLost: ordered.filter(segment => !unique.has(segment.paragraphIndex)).length,
    sourceSegmentsDuplicated: represented.length - unique.size, technicalDisplayUnits: units.length,
    structuralGroups, evaluatedDisplayUnits: evaluated };
  return { units, counts, audit };
}
