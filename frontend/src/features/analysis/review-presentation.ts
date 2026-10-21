import type { AnalysisSegment } from "../../api/analysis";

const PRESENTATION_EXCLUSIONS = new Set([
  "REFERENCE_SECTION", "METADATA", "CAPTION", "HEADING", "INSUFFICIENT_TEXT",
]);

export function isReviewHighlightedDecision(decision: {
  evaluated: boolean;
  score: number | null;
  presentationExcluded: boolean;
  reviewHighlighted?: boolean;
}): boolean {
  return decision.evaluated === true && typeof decision.score === "number" &&
    Number.isFinite(decision.score) && decision.presentationExcluded !== true &&
    decision.reviewHighlighted === true;
}

/** Consume the server presentation decision; scientific flags never select highlights. */
export function shouldHighlightForReview(segment: AnalysisSegment): boolean {
  const evidence = segment.evidence;
  const evaluated = evidence?.evaluated ?? segment.classification !== "INSUFFICIENT_TEXT";
  const score = evidence ? evidence.score : segment.calibratedScore;
  const reason = segment.reviewPresentation?.excludedReason ?? evidence?.excludedReason;
  const excluded = evidence?.presentationExcluded === true ||
    Boolean(reason && PRESENTATION_EXCLUSIONS.has(reason));
  return isReviewHighlightedDecision({
    evaluated: evaluated === true && segment.classification !== "INSUFFICIENT_TEXT",
    score,
    presentationExcluded: excluded,
    reviewHighlighted: segment.reviewPresentation?.highlight ?? evidence?.reviewHighlighted,
  });
}

export function reviewThresholdLabel(policy?: {
  reviewHighlightThreshold?: number;
  reviewHighlightComparator?: string;
}): string {
  return policy?.reviewHighlightComparator === "GT" &&
    typeof policy.reviewHighlightThreshold === "number" && Number.isFinite(policy.reviewHighlightThreshold)
    ? `>${(policy.reviewHighlightThreshold * 100).toFixed(1)} %`
    : "No disponible";
}

/** API scientific evidence is retained; the legacy fallback only reconstructs detector state. */
export function reviewEvidenceForSegment(segment: AnalysisSegment, threshold: number | null) {
  const reviewHighlighted = shouldHighlightForReview(segment);
  if (segment.evidence) return { ...segment.evidence, reviewHighlighted };
  const evaluated = segment.classification !== "INSUFFICIENT_TEXT" &&
    typeof segment.calibratedScore === "number" && Number.isFinite(segment.calibratedScore);
  const flagged = evaluated && threshold !== null && Number.isFinite(threshold) && segment.calibratedScore! >= threshold;
  const reason = segment.reviewPresentation?.excludedReason;
  const presentationExcluded = Boolean(reason && PRESENTATION_EXCLUSIONS.has(reason));
  return {
    evaluated, flagged, reviewHighlighted, score: segment.calibratedScore, threshold,
    presentationExcluded,
    ...(presentationExcluded && reason ? { excludedReason: reason } : {}),
    granularity: "PARAGRAPH" as const, paragraphFlagged: flagged, spans: [],
  };
}

export function actionableReviewSegments(
  segments: AnalysisSegment[],
  actionableParagraphIndices?: number[],
) {
  const allowed = actionableParagraphIndices ? new Set(actionableParagraphIndices) : null;
  return segments.filter((segment) => {
    return shouldHighlightForReview(segment) && (!allowed || allowed.has(segment.paragraphIndex));
  });
}

export function nextReviewNavigationIndex(length: number, selectedIndex: number, navigationIndex: number, direction: -1 | 1) {
  if (!length) return null;
  const baseIndex = selectedIndex >= 0 ? selectedIndex : direction > 0 ? navigationIndex - 1 : navigationIndex;
  return (baseIndex + direction + length) % length;
}
