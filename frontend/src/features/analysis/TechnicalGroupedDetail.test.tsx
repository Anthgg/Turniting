import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TechnicalPresentation } from "../../api/analysis";
import { TechnicalGroupedDetail } from "./TechnicalGroupedDetail";
import { technicalPercentage } from "./technical-presentation-utils";

const presentation: TechnicalPresentation = {
  analysisRunId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  counts: { totalSegments: 5, evaluatedSegments: 3, insufficientSegments: 2, rawFlaggedCount: 3, presentationExcludedFlagged: 2, actionableHighlightCount: 1, structuralGroups: 2 },
  actionableParagraphIndices: [0],
  displayUnits: [
    { id: "body-0", type: "EVALUATED_SEGMENT", label: "SEGMENTO 1", sourceSegmentIds: [0], paragraphIndices: [0], positionStart: 0, positionEnd: 30, text: "Cuerpo evaluado real.", presentationExcluded: false,
      evaluatedSegments: [{ sourceSegmentId: "source-body", paragraphIndex: 0, score: 0.83241, threshold: 0.59, flagged: true, reviewHighlighted: true, presentationExcluded: false, text: "Cuerpo evaluado real." }] },
    { id: "table-1", type: "TABLE_GROUP", label: "TABLA", sourceSegmentIds: [1, 2], paragraphIndices: [1, 2], positionStart: 31, positionEnd: 60, text: "Indicador\nResultado persistido", presentationExcluded: false,
      evaluatedSegments: [{ sourceSegmentId: 2, paragraphIndex: 2, score: 0.63245, threshold: 0.59, flagged: true, presentationExcluded: true, excludedReason: "CAPTION", text: "Resultado persistido" }] },
    { id: "ref-3", type: "REFERENCE_GROUP", label: "REFERENCIAS", sourceSegmentIds: [3, 4], paragraphIndices: [3, 4], positionStart: 61, positionEnd: 100, text: "References: Smith et al.\n[2] Synthetic publication.", presentationExcluded: true, excludedReason: "REFERENCE_SECTION",
      evaluatedSegments: [{ sourceSegmentId: 3, paragraphIndex: 3, score: 0.91, threshold: 0.59, flagged: true, presentationExcluded: true, excludedReason: "REFERENCE_SECTION", text: "References: Smith et al." }] },
  ],
};

describe("TechnicalGroupedDetail", () => {
  it("renders structural groups with source traceability and exact evaluated percentages", () => {
    const html = renderToStaticMarkup(createElement(TechnicalGroupedDetail, { presentation, onReview: vi.fn() }));
    expect(html).toContain("83.2 %");
    expect(html).toContain("63.2 %");
    expect(html).toContain("91.0 %");
    expect(html).toContain("59.0 %");
    expect(html).toContain("Scores técnicos internos");
    expect(html).toContain('data-display-unit-type="TABLE_GROUP"');
    expect(html).toContain('data-display-unit-type="REFERENCE_GROUP"');
    expect(html).toContain("Índices persistidos: 1, 2");
    expect(html).toContain("Índices persistidos: 3, 4");
    expect(html).toContain("EXCLUIDO DE REVISIÓN VISUAL");
    expect(html).toContain("REFERENCE_SECTION");
    expect(html.match(/Ver en Revisión/g)).toHaveLength(1);
    expect(presentation.displayUnits.flatMap((unit) => unit.evaluatedSegments.map((member) => member.score))).toEqual([0.83241, 0.63245, 0.91]);
  });

  it("represents an insufficient structural group once without inventing a percentage", () => {
    const metadata = { ...presentation, displayUnits: [{ id: "metadata", type: "METADATA_GROUP" as const, label: "DATOS DE PORTADA / METADATA", sourceSegmentIds: [0, 1], paragraphIndices: [0, 1], positionStart: 0, positionEnd: 20, text: "FACULTAD\nESCUELA", presentationExcluded: true, excludedReason: "METADATA", evaluatedSegments: [] }] };
    const html = renderToStaticMarkup(createElement(TechnicalGroupedDetail, { presentation: metadata, onReview: vi.fn() }));
    expect(html.match(/NO EVALUADO/g)).toHaveLength(1);
    expect(html).not.toContain("0.0 %");
    expect(html).not.toContain("Scores técnicos internos");
    expect(html).toContain("FACULTAD\nESCUELA");
    expect(technicalPercentage(null)).toBe("NO EVALUADO");
  });

  it("shows detector and visual review decisions separately for every evaluated member", () => {
    const input: TechnicalPresentation = {
      ...presentation, reviewHighlightThreshold: 20 / 100, reviewHighlightComparator: "GT",
      displayUnits: [{ ...presentation.displayUnits[0], evaluatedSegments: [
        { ...presentation.displayUnits[0].evaluatedSegments[0], score: 0.35, flagged: false, reviewHighlighted: true },
        { ...presentation.displayUnits[0].evaluatedSegments[0], sourceSegmentId: "excluded", score: 0.95, flagged: true, reviewHighlighted: false, presentationExcluded: true },
      ] }],
    };
    const html = renderToStaticMarkup(createElement(TechnicalGroupedDetail, { presentation: input, onReview: vi.fn() }));
    expect(html).toContain("35.0 %");
    expect(html).toContain("Detector: NO SEÑALADO");
    expect(html).toContain("Revisión: RESALTADO");
    expect(html).toContain("Detector: SEÑALADO");
    expect(html).toContain("Revisión: NO RESALTADO");
    expect(html).toContain("Umbral de revisión visual: &gt;20.0 %");
    expect(html).toContain("Umbral del detector 59.0 %");
    expect(input.displayUnits[0].evaluatedSegments[0].flagged).toBe(false);
  });
});
