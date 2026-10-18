import { z } from "zod";
import { deleteResource, downloadFile, getJson, postJson } from "./client";

export const reportTypeSchema = z.enum(["AI_REPORT", "SIMILARITY_REPORT"]);
export const reportStatusSchema = z.enum([
  "GENERATING",
  "AVAILABLE",
  "ERROR",
  "EXPIRED",
  "DELETED",
]);

export const reportArtifactSchema = z
  .object({
    id: z.string().uuid(),
    documentId: z.string().uuid(),
    documentVersionId: z.string().uuid(),
    analysisRunId: z.string().uuid().nullable(),
    similarityRunId: z.string().uuid().nullable(),
    type: reportTypeSchema,
    status: reportStatusSchema,
    filename: z
      .string()
      .regex(/^turniting_(ai|similarity)_[0-9a-f]{8}_\d{4}-\d{2}-\d{2}\.pdf$/i),
    contentHash: z.string().nullable(),
    generatedAt: z.string(),
    expiresAt: z.string(),
    deletedAt: z.string().nullable(),
    downloadEndpoint: z.string().optional(),
  })
  .passthrough();

const reportListSchema = z.object({ items: z.array(reportArtifactSchema) });

export type ReportArtifact = z.infer<typeof reportArtifactSchema>;

export const reportQueryKeys = {
  document: (documentId: string) =>
    ["reports", "document", documentId] as const,
  detail: (reportId: string) => ["reports", reportId] as const,
};

export function listDocumentReports(documentId: string) {
  return getJson(
    `/documents/${encodeURIComponent(documentId)}/reports`,
    reportListSchema,
  );
}

export function generateAIReport(documentId: string, analysisRunId: string) {
  return postJson(
    `/documents/${encodeURIComponent(documentId)}/reports/ai`,
    reportArtifactSchema,
    { analysisRunId },
  );
}

export function generateSimilarityReport(
  documentId: string,
  similarityRunId: string,
) {
  return postJson(
    `/documents/${encodeURIComponent(documentId)}/reports/similarity`,
    reportArtifactSchema,
    { similarityRunId },
  );
}

export function downloadReport(report: ReportArtifact) {
  return downloadFile(
    `/reports/${encodeURIComponent(report.id)}/download`,
    report.filename,
  );
}

export function deleteReport(reportId: string) {
  return deleteResource(`/reports/${encodeURIComponent(reportId)}`);
}
