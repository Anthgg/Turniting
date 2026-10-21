import { describe, expect, it } from "vitest";
import type { AnalysisSegment } from "../../api/analysis";
import { actionableReviewSegments, nextReviewNavigationIndex, reviewEvidenceForSegment, reviewThresholdLabel, shouldHighlightForReview } from "./review-presentation";
import { splitReviewText } from "./review-text";

function segment(paragraphIndex: number, text: string, excludedReason?: "REFERENCE_SECTION" | "METADATA"): AnalysisSegment {
  return {
    paragraphIndex, text, charStart: paragraphIndex * 100, charEnd: paragraphIndex * 100 + text.length,
    pageNumber: 1, words: 30, tokens: 40, modelName: "SYNTHETIC", rawScore: 0.91, calibratedScore: 0.91,
    classification: "MACHINE_SIGNAL", signalLevel: "HIGH", confidence: "HIGH",
    reviewPresentation: { highlight: !excludedReason, level: "HIGH", ...(excludedReason ? { excludedReason } : {}) },
    evidence: { evaluated: true, flagged: true, reviewHighlighted: !excludedReason, score: 0.91, threshold: 0.59, presentationExcluded: Boolean(excludedReason), ...(excludedReason ? { excludedReason } : {}), granularity: "PARAGRAPH", paragraphFlagged: true, spans: [] },
  };
}

describe("review presentation from API evidence", () => {
  const items = [
    segment(0, "Autor: Ejemplo", "METADATA"),
    segment(1, "Las referencias utilizadas fueron seleccionadas para esta investigación."),
    segment(2, "Las referencias [1] y [2] muestran resultados reproducibles."),
    segment(3, "Este marco se apoya en referencias recientes."),
    segment(4, "Un cuarto segmento de cuerpo señalado por el detector."),
    segment(5, "References: Smith et al. (2024). Synthetic reference.", "REFERENCE_SECTION"),
  ];

  it("retains six raw flagged scores but only four actionable body highlights", () => {
    expect(items.filter((item) => item.evidence?.flagged)).toHaveLength(6);
    expect(items.filter((item) => item.evidence?.flagged && item.evidence.presentationExcluded)).toHaveLength(2);
    const actionable = actionableReviewSegments(items, [1, 2, 3, 4]);
    expect(actionable.map((item) => item.paragraphIndex)).toEqual([1, 2, 3, 4]);
    expect(items.map((item) => item.calibratedScore)).toEqual(Array(6).fill(0.91));
  });

  it("does not highlight an inline reference excluded by API presentation evidence", () => {
    const reference = items[5];
    const evidence = reviewEvidenceForSegment(reference, 0.59);
    expect(evidence.flagged).toBe(true);
    expect(evidence.excludedReason).toBe("REFERENCE_SECTION");
    expect(splitReviewText(reference.text!, evidence, reference.charStart)).toEqual([{ text: reference.text, highlighted: false }]);
  });

  it("does not classify ordinary body mentions of referencias in the frontend", () => {
    for (const body of items.slice(1, 4)) {
      const evidence = reviewEvidenceForSegment(body, 0.59);
      expect(evidence.presentationExcluded).toBe(false);
      expect(splitReviewText(body.text!, evidence, body.charStart)).toEqual([{ text: body.text, highlighted: true }]);
    }
  });

  it("previous and next cycle only through the API-authorized actionable segments", () => {
    const actionable = actionableReviewSegments(items, [1, 2, 3, 4]);
    let index = nextReviewNavigationIndex(actionable.length, -1, 0, 1)!;
    expect(actionable[index].paragraphIndex).toBe(1);
    const visited = [actionable[index].paragraphIndex];
    for (let step = 0; step < 4; step++) {
      index = nextReviewNavigationIndex(actionable.length, index, index, 1)!;
      visited.push(actionable[index].paragraphIndex);
    }
    expect(visited).toEqual([1, 2, 3, 4, 1]);
    index = nextReviewNavigationIndex(actionable.length, index, index, -1)!;
    expect(actionable[index].paragraphIndex).toBe(4);
    expect(nextReviewNavigationIndex(0, -1, 0, 1)).toBeNull();
  });
});

describe("universal visual review policy from the server", () => {
  // Boundary payloads are explicit server results; no frontend threshold is defined.
  const cases: Array<[number, boolean]> = [
    [0, false], [0.1, false], [0.1999, false], [0.199999, false],
    [0.2, false], [0.200001, true], [0.201, true], [0.35, true], [0.58, true], [0.9, true],
  ];

  function payload(score: number, highlighted: boolean, threshold = 0.59, modelName = "SYNTHETIC"): AnalysisSegment {
    const item = segment(0, "Synthetic boundary segment");
    return {
      ...item, modelName, calibratedScore: score,
      classification: score >= threshold ? "MACHINE_SIGNAL" : "LOW_SIGNAL",
      reviewPresentation: { highlight: highlighted, level: "LOW" },
      evidence: { ...item.evidence!, score, threshold, flagged: score >= threshold,
        paragraphFlagged: score >= threshold, reviewHighlighted: highlighted },
    };
  }

  it.each(cases)("renders the server boundary decision for score %s as %s", (score, highlighted) => {
    const item = payload(score, highlighted);
    const before = structuredClone(item);
    expect(shouldHighlightForReview(item)).toBe(highlighted);
    const evidence = reviewEvidenceForSegment(item, item.evidence!.threshold);
    expect(splitReviewText(item.text!, evidence).some((part) => part.highlighted)).toBe(highlighted);
    expect(item).toEqual(before);
  });

  it("keeps visual review independent of scientific thresholds and model names", () => {
    for (const modelName of ["ENSEMBLE_V2_V3", "F006.1", "F006.1.1", "TURNITING_UNIFIED_V1"]) {
      for (const threshold of [0.4, 0.59, 0.64, 0.77, 0.9]) {
        const item = payload(0.3, true, threshold, modelName);
        expect(shouldHighlightForReview(item)).toBe(true);
        expect(reviewEvidenceForSegment(item, threshold).flagged).toBe(false);
      }
    }
    expect(reviewEvidenceForSegment(payload(0.83, true), 0.59).flagged).toBe(true);
  });

  it("rejects excluded, insufficient, nonfinite and missing presentation decisions", () => {
    const item = payload(0.95, true);
    expect(shouldHighlightForReview({ ...item, evidence: { ...item.evidence!, presentationExcluded: true } })).toBe(false);
    expect(shouldHighlightForReview({ ...item, classification: "INSUFFICIENT_TEXT" })).toBe(false);
    expect(shouldHighlightForReview({ ...item, evidence: { ...item.evidence!, evaluated: false } })).toBe(false);
    for (const score of [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(shouldHighlightForReview({ ...item, evidence: { ...item.evidence!, score } })).toBe(false);
    }
    expect(shouldHighlightForReview({ ...item, reviewPresentation: undefined,
      evidence: { ...item.evidence!, reviewHighlighted: undefined } })).toBe(false);
    expect(shouldHighlightForReview({ ...item, reviewPresentation: { highlight: false, level: "LOW" } })).toBe(false);
  });

  it("uses the same five IDs as PDF selection while retaining two detector flags", () => {
    const scores = [0.1, 0.2, 0.21, 0.35, 0.58, 0.59, 0.83];
    const items = scores.map((score, index) => ({ ...payload(score, index >= 2), paragraphIndex: index }));
    const pdfHighlightParagraphIndices = [2, 3, 4, 5, 6];
    const visual = actionableReviewSegments(items, pdfHighlightParagraphIndices);
    expect(visual.map((item) => item.paragraphIndex)).toEqual(pdfHighlightParagraphIndices);
    expect(items.filter((item) => item.evidence!.flagged).map((item) => item.paragraphIndex)).toEqual([5, 6]);
    let index = nextReviewNavigationIndex(visual.length, -1, 0, 1)!;
    const visited = [visual[index].paragraphIndex];
    for (let step = 0; step < 5; step++) {
      index = nextReviewNavigationIndex(visual.length, index, index, 1)!;
      visited.push(visual[index].paragraphIndex);
    }
    expect(visited).toEqual([2, 3, 4, 5, 6, 2]);
  });

  it("labels the visual rule from API metadata with a strict comparator", () => {
    expect(reviewThresholdLabel({ reviewHighlightThreshold: 20 / 100, reviewHighlightComparator: "GT" })).toBe(">20.0 %");
    expect(reviewThresholdLabel({ reviewHighlightThreshold: 0.7, reviewHighlightComparator: "GT" })).toBe(">70.0 %");
    expect(reviewThresholdLabel({ reviewHighlightThreshold: Number.NaN, reviewHighlightComparator: "GT" })).toBe("No disponible");
    expect(reviewThresholdLabel()).toBe("No disponible");
  });
});
