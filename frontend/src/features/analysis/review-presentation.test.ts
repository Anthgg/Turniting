import { describe, expect, it } from "vitest";
import type { AnalysisSegment } from "../../api/analysis";
import { actionableReviewSegments, nextReviewNavigationIndex, reviewEvidenceForSegment } from "./review-presentation";
import { splitReviewText } from "./review-text";

function segment(paragraphIndex: number, text: string, excludedReason?: "REFERENCE_SECTION" | "METADATA"): AnalysisSegment {
  return {
    paragraphIndex, text, charStart: paragraphIndex * 100, charEnd: paragraphIndex * 100 + text.length,
    pageNumber: 1, words: 30, tokens: 40, modelName: "SYNTHETIC", rawScore: 0.91, calibratedScore: 0.91,
    classification: "MACHINE_SIGNAL", signalLevel: "HIGH", confidence: "HIGH",
    reviewPresentation: { highlight: !excludedReason, level: "HIGH", ...(excludedReason ? { excludedReason } : {}) },
    evidence: { evaluated: true, flagged: true, score: 0.91, threshold: 0.59, presentationExcluded: Boolean(excludedReason), ...(excludedReason ? { excludedReason } : {}), granularity: "PARAGRAPH", paragraphFlagged: true, spans: [] },
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
    const actionable = actionableReviewSegments(items, 0.59, [1, 2, 3, 4]);
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
    const actionable = actionableReviewSegments(items, 0.59, [1, 2, 3, 4]);
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
