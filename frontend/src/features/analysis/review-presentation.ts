import type { AnalysisSegment } from "../../api/analysis";

const PRESENTATION_EXCLUSIONS = new Set([
  "REFERENCE_SECTION", "METADATA", "CAPTION", "HEADING", "INSUFFICIENT_TEXT",
]);

/** Persisted API evidence is authoritative; this fallback supports older responses. */
export function reviewEvidenceForSegment(segment: AnalysisSegment, threshold: number | null) {
  if (segment.evidence) return segment.evidence;
  const evaluated = segment.classification !== "INSUFFICIENT_TEXT" &&
    typeof segment.calibratedScore === "number" && Number.isFinite(segment.calibratedScore);
  const flagged = evaluated && threshold !== null && Number.isFinite(threshold) && segment.calibratedScore! >= threshold;
  const reason = segment.reviewPresentation?.excludedReason;
  const presentationExcluded = Boolean(reason && PRESENTATION_EXCLUSIONS.has(reason));
  return {
    evaluated, flagged, score: segment.calibratedScore, threshold,
    presentationExcluded,
    ...(presentationExcluded && reason ? { excludedReason: reason } : {}),
    granularity: "PARAGRAPH" as const, paragraphFlagged: flagged, spans: [],
  };
}

export function actionableReviewSegments(
  segments: AnalysisSegment[],
  threshold: number | null,
  actionableParagraphIndices?: number[],
) {
  const allowed = actionableParagraphIndices ? new Set(actionableParagraphIndices) : null;
  return segments.filter((segment) => {
    const evidence = reviewEvidenceForSegment(segment, threshold);
    return evidence.flagged && !evidence.presentationExcluded && (!allowed || allowed.has(segment.paragraphIndex));
  });
}

export function nextReviewNavigationIndex(length: number, selectedIndex: number, navigationIndex: number, direction: -1 | 1) {
  if (!length) return null;
  const baseIndex = selectedIndex >= 0 ? selectedIndex : direction > 0 ? navigationIndex - 1 : navigationIndex;
  return (baseIndex + direction + length) % length;
}
