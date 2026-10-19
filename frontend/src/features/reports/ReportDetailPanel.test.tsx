import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock("@tanstack/react-query", () => queryMocks);

import { ReportDetailPanel } from "./ReportDetailPanel";

const REPORT_ID = "e564fa70-4188-4e8e-a4eb-98fda94f8865";

function report(previewAvailable: boolean) {
  return {
    id: REPORT_ID,
    reportId: REPORT_ID,
    documentId: "66b2f3c5-14df-4156-a1df-152a7129f88e",
    documentVersionId: "8edee971-57eb-478b-b811-5f83b8115ea3",
    analysisRunId: "31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4",
    similarityRunId: null,
    type: "AI_ORIGINAL_REVIEW",
    status: "AVAILABLE",
    filename: "turniting_original-review_66b2f3c5_2026-10-18.pdf",
    documentName: "muestra_sintetica.docx",
    contentHash: "b".repeat(64),
    sizeBytes: 1024,
    failureReason: null,
    generationVersion: "f0094-original-fidelity-renderer-v1",
    generatedAt: "2026-10-18T12:00:00.000Z",
    expiresAt: "2026-10-19T12:00:00.000Z",
    deletedAt: null,
    previewAvailable,
    run: {
      id: "31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4",
      analyzerMode: "V3_ONLY",
      analyzerVersion: "synthetic",
      modelNames: ["SYNTHETIC"],
      thresholdProfile: "BALANCED",
      threshold: 0.58,
      paragraphMode: "STRICT_PARAGRAPH",
      globalScore: 0.42,
    },
  };
}

function renderPanel(previewAvailable: boolean) {
  queryMocks.useQuery.mockReturnValue({
    data: report(previewAvailable),
    isPending: false,
    isError: false,
  });
  return renderToStaticMarkup(
    createElement(ReportDetailPanel, { reportId: REPORT_ID, onClose: vi.fn() }),
  );
}

describe("ReportDetailPanel", () => {
  beforeEach(() => queryMocks.useQuery.mockReset());

  it("previews available PDFs inside Turniting", () => {
    const html = renderPanel(true);

    expect(html).toContain("Revisión original");
    expect(html).toContain("report-preview-frame");
    expect(html).toContain(`/reports/${REPORT_ID}/preview`);
    expect(html).toContain("Vista previa: turniting_original-review");
  });

  it("does not request an inline preview when the PDF is unavailable", () => {
    const html = renderPanel(false);

    expect(html).not.toContain("report-preview-frame");
  });
});
