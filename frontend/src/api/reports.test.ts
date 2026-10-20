import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  postJson: vi.fn(), getJson: vi.fn(), deleteResource: vi.fn(),
  downloadFile: vi.fn(), apiResourceUrl: vi.fn((path: string) => `/api${path}`),
}));
vi.mock("./client", () => client);

import {
  downloadReport, dualAIReportsSchema, generateAIReport, generateBothAIReports,
  regenerateReport, reportArtifactSchema, reportPreviewUrl,
} from "./reports";

const DOCUMENT_ID = "66b2f3c5-14df-4156-a1df-152a7129f88e";
const VERSION_ID = "8edee971-57eb-478b-b811-5f83b8115ea3";
const RUN_ID = "31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4";

function report(type: "AI_ORIGINAL_REVIEW" | "AI_PARAGRAPH_TECHNICAL") {
  return {
    id: type === "AI_ORIGINAL_REVIEW" ? "e564fa70-4188-4e8e-a4eb-98fda94f8865" : "a2b2f3c5-14df-4156-a1df-152a7129f88e",
    documentId: DOCUMENT_ID, documentVersionId: VERSION_ID, analysisRunId: RUN_ID,
    generatedBy: "TURNITING", sourceArtifactType: "DOCUMENT_VERSION",
    sourceDocumentId: DOCUMENT_ID, sourceDocumentVersionId: VERSION_ID,
    sourceChecksum: "a".repeat(64), similarityRunId: null, type, status: "AVAILABLE",
    filename: `turniting_${type === "AI_ORIGINAL_REVIEW" ? "original-review" : "paragraph-technical"}_thesis_fixture_66b2f3c5_2026-10-20.pdf`,
    documentName: "thesis-fixture.pdf", contentHash: "b".repeat(64),
    generatedAt: "2026-10-20T12:00:00.000Z", expiresAt: "2026-10-21T12:00:00.000Z", deletedAt: null,
    run: { id: RUN_ID, analyzerMode: "ENSEMBLE", analyzerVersion: "synthetic", modelNames: ["SYNTHETIC"], thresholdProfile: "BALANCED", threshold: 0.59, paragraphMode: "STRICT_PARAGRAPH", globalScore: 0.434 },
  };
}

describe("report source API contracts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the exact run for each variant and for the logical dual operation", () => {
    generateAIReport(DOCUMENT_ID, RUN_ID, "AI_ORIGINAL_REVIEW");
    generateAIReport(DOCUMENT_ID, RUN_ID, "AI_PARAGRAPH_TECHNICAL");
    generateBothAIReports(DOCUMENT_ID, RUN_ID);

    expect(client.postJson.mock.calls.map(([path, , body]) => [path, body])).toEqual([
      [`/documents/${DOCUMENT_ID}/reports/ai`, { analysisRunId: RUN_ID, variant: "AI_ORIGINAL_REVIEW" }],
      [`/documents/${DOCUMENT_ID}/reports/ai`, { analysisRunId: RUN_ID, variant: "AI_PARAGRAPH_TECHNICAL" }],
      [`/documents/${DOCUMENT_ID}/reports/ai/both`, { analysisRunId: RUN_ID }],
    ]);
    expect(client.postJson.mock.calls.every(([path]) => !String(path).includes("/analyze"))).toBe(true);
  });

  it("keeps preview, download and regeneration on report endpoints", () => {
    const artifact = reportArtifactSchema.parse(report("AI_ORIGINAL_REVIEW"));
    reportPreviewUrl(artifact.id);
    downloadReport(artifact);
    regenerateReport(artifact.id);

    expect(client.apiResourceUrl).toHaveBeenCalledWith(`/reports/${artifact.id}/preview`);
    expect(client.downloadFile).toHaveBeenCalledWith(`/reports/${artifact.id}/download`, artifact.filename);
    expect(client.postJson).toHaveBeenCalledWith(`/reports/${artifact.id}/regenerate`, reportArtifactSchema);
    expect(client.postJson.mock.calls.every(([path]) => String(path).startsWith("/reports/"))).toBe(true);
  });

  it("accepts legacy names and safe source-name tokens while rejecting report sources", () => {
    const source = report("AI_ORIGINAL_REVIEW");
    expect(reportArtifactSchema.safeParse(source).success).toBe(true);
    expect(reportArtifactSchema.safeParse({ ...source, filename: "turniting_original-review_66b2f3c5_2026-10-20.pdf" }).success).toBe(true);
    expect(reportArtifactSchema.safeParse({ ...source, sourceArtifactType: "REPORT" }).success).toBe(false);
    expect(reportArtifactSchema.safeParse({ ...source, filename: "../thesis.pdf" }).success).toBe(false);
  });

  it("requires the dual response to retain the same run, source, score, threshold and model", () => {
    const originalReview = report("AI_ORIGINAL_REVIEW");
    const paragraphTechnical = report("AI_PARAGRAPH_TECHNICAL");
    expect(dualAIReportsSchema.safeParse({ originalReview, paragraphTechnical }).success).toBe(true);
    for (const change of [
      { analysisRunId: "c2b2f3c5-14df-4156-a1df-152a7129f88e" },
      { sourceDocumentVersionId: "c2b2f3c5-14df-4156-a1df-152a7129f88e" },
      { run: { ...paragraphTechnical.run, globalScore: 0.769 } },
      { run: { ...paragraphTechnical.run, threshold: 0.767 } },
      { run: { ...paragraphTechnical.run, modelNames: ["OTHER"] } },
    ]) {
      expect(dualAIReportsSchema.safeParse({ originalReview, paragraphTechnical: { ...paragraphTechnical, ...change } }).success).toBe(false);
    }
  });
});
