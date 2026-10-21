import { describe, expect, it } from 'vitest';
import { REVIEW_HIGHLIGHT_THRESHOLD, REVIEW_PRESENTATION_POLICY, shouldHighlightForReview } from './review-highlight-policy.js';
import { createReviewDocumentContext, getReviewEvidence, getReviewPresentation, type ReviewSegment } from './review-presentation.js';
import { createHash } from 'node:crypto';

describe('F009.4.3 universal visual review policy', () => {
  it('has one versioned fixed presentation authority', () => {
    expect(REVIEW_PRESENTATION_POLICY).toEqual({ reviewHighlightThreshold: REVIEW_HIGHLIGHT_THRESHOLD,
      reviewHighlightComparator: 'GT', presentationPolicyVersion: 'f00943-review-gt20-v1' });
    expect(Object.isFrozen(REVIEW_PRESENTATION_POLICY)).toBe(true);
  });

  it.each([0, .10, .1999, .199999, REVIEW_HIGHLIGHT_THRESHOLD])('does not highlight score %s', score => {
    expect(shouldHighlightForReview({ evaluated: true, score })).toBe(false);
  });
  it.each([.200001, .201, .35, .58, .90])('highlights score %s', score => {
    expect(shouldHighlightForReview({ evaluated: true, score })).toBe(true);
  });
  it.each([null, Number.NaN, Infinity, -Infinity])('fails closed for invalid score %s', score => {
    expect(shouldHighlightForReview({ evaluated: true, score })).toBe(false);
  });
  it('excludes insufficient and presentation-excluded segments even at high scores', () => {
    expect(shouldHighlightForReview({ evaluated: false, score: .95 })).toBe(false);
    expect(shouldHighlightForReview({ evaluated: true, score: .95, presentationExcluded: true })).toBe(false);
  });

  const text = 'Este segmento sintético conserva su señal científica exacta para la revisión visual.';
  function segment(score: number): ReviewSegment {
    return { paragraphIndex: 0, charStart: 0, charEnd: text.length,
      textHash: createHash('sha256').update(text).digest('hex'), classification: 'LOW_SIGNAL',
      signalLevel: 'LOW', calibratedScore: score };
  }
  it.each([.40, .59, .644295302013423, .767241379310345, .90, null])('is independent of scientific threshold %s', threshold => {
    const source = segment(.30);
    const before = JSON.stringify(source);
    const context = createReviewDocumentContext(text, [source]);
    expect(getReviewEvidence(source, threshold, context)).toMatchObject({ score: .30, threshold,
      evaluated: true, flagged: false, reviewHighlighted: true });
    expect(getReviewPresentation(source, context, threshold).highlight).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });
  it.each([.35, .83])('preserves the detector decision separately for score %s', score => {
    const source = segment(score);
    const context = createReviewDocumentContext(text, [source]);
    expect(getReviewEvidence(source, .59, context)).toMatchObject({ score, threshold: .59,
      flagged: score >= .59, reviewHighlighted: true });
  });
});
