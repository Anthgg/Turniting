/** Versioned product presentation policy. Never used for scientific classification. */
export const REVIEW_HIGHLIGHT_THRESHOLD = 0.20;

export const REVIEW_PRESENTATION_POLICY = Object.freeze({
  reviewHighlightThreshold: REVIEW_HIGHLIGHT_THRESHOLD,
  reviewHighlightComparator: 'GT' as const,
  presentationPolicyVersion: 'f00943-review-gt20-v1',
});

export interface ReviewHighlightCandidate {
  evaluated: boolean;
  score: number | null;
  presentationExcluded?: boolean;
}

/** The single authority for visual review, independent of model and detector flags. */
export function shouldHighlightForReview(segment: ReviewHighlightCandidate): boolean {
  return segment.evaluated === true &&
    typeof segment.score === 'number' && Number.isFinite(segment.score) &&
    segment.score > REVIEW_HIGHLIGHT_THRESHOLD &&
    segment.presentationExcluded !== true;
}
