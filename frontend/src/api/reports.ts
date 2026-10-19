import { z } from "zod";
import { apiResourceUrl, deleteResource, downloadFile, getJson, postJson } from "./client";

export const reportTypeSchema = z.enum([
  "AI_REPORT",
  "AI_ORIGINAL_REVIEW",
  "AI_PARAGRAPH_TECHNICAL",
  "SIMILARITY_REPORT",
]);
export const reportStatusSchema = z.enum([
  "GENERATING",
  "AVAILABLE",
  "FAILED",
  "ERROR",
  "EXPIRED",
  "DELETED",
]);

export const reportArtifactSchema = z
  .object({
    id: z.string().uuid(),
    reportId: z.string().uuid().optional(),
    documentId: z.string().uuid(),
    documentVersionId: z.string().uuid(),
    analysisRunId: z.string().uuid().nullable(),
    similarityRunId: z.string().uuid().nullable(),
    type: reportTypeSchema,
    variant: reportTypeSchema.optional(),
    status: reportStatusSchema,
    filename: z
      .string()
      .regex(/^turniting_(ai|original-review|paragraph-technical|similarity)_[0-9a-f]{8}_\d{4}-\d{2}-\d{2}\.pdf$/i),
    documentName: z.string().optional(),
    runLabel: z.string().optional(),
    contentHash: z.string().nullable(),
    sizeBytes: z.number().int().nullable().optional(),
    failureReason: z.string().nullable().optional(),
    generationVersion: z.string().optional(),
    rendererVersion: z.string().optional(),
    reused: z.boolean().optional(),
    generatedAt: z.string(),
    createdAt: z.string().optional(),
    expiresAt: z.string(),
    deletedAt: z.string().nullable(),
    downloadEndpoint: z.string().optional(),
    previewEndpoint: z.string().optional(),
    downloadAvailable: z.boolean().optional(),
    previewAvailable: z.boolean().optional(),
  })
  .passthrough();

export const reportDetailSchema = reportArtifactSchema.extend({
  documentName: z.string(),
  run: z
    .object({
      id: z.string().uuid(),
      analyzerMode: z.string(),
      analyzerVersion: z.string(),
      modelNames: z.array(z.string()),
      thresholdProfile: z.string(),
      threshold: z.number().nullable(),
      paragraphMode: z.string().nullable(),
      globalScore: z.number().nullable(),
    })
    .nullable(),
});

export const reportListSchema = z.object({
  items: z.array(reportArtifactSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type ReportArtifact = z.infer<typeof reportArtifactSchema>;
export type ReportArtifactDetail = z.infer<typeof reportDetailSchema>;
export type ReportStatus = z.infer<typeof reportStatusSchema>;
export type ReportType = z.infer<typeof reportTypeSchema>;
export type ReportListFilters = {
  documentId?: string;
  type?: ReportType;
  status?: ReportStatus;
  page?: number;
  pageSize?: number;
};

export const reportQueryKeys = {
  all: ["reports"] as const,
  list: (query: ReportListFilters) => ["reports", "list", query] as const,
  document: (documentId: string) =>
    ["reports", "document", documentId] as const,
  detail: (reportId: string) => ["reports", reportId] as const,
};

function reportQueryString(query: ReportListFilters = {}) {
  const params = new URLSearchParams();
  for (const key of ["documentId", "type", "status", "page", "pageSize"] as const) {
    const value = query[key];
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

export function listReports(query: ReportListFilters = {}) {
  return getJson(`/reports${reportQueryString(query)}`, reportListSchema);
}

export function listDocumentReports(documentId: string, query: Omit<ReportListFilters, "documentId"> = {}) {
  return getJson(
    `/documents/${encodeURIComponent(documentId)}/reports${reportQueryString(query)}`,
    reportListSchema,
  );
}

export function getReportDetail(reportId: string) {
  return getJson(`/reports/${encodeURIComponent(reportId)}`, reportDetailSchema);
}

export function generateAIReport(
  documentId: string,
  analysisRunId: string,
  variant: ReportType = "AI_REPORT",
) {
  return postJson(
    `/documents/${encodeURIComponent(documentId)}/reports/ai`,
    reportArtifactSchema,
    { analysisRunId, variant },
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

export function reportPreviewUrl(reportId: string) {
  return apiResourceUrl(`/reports/${encodeURIComponent(reportId)}/preview`);
}

export function deleteReport(reportId: string) {
  return deleteResource(`/reports/${encodeURIComponent(reportId)}`);
}

export function regenerateReport(reportId: string) {
  return postJson(
    `/reports/${encodeURIComponent(reportId)}/regenerate`,
    reportArtifactSchema,
  );
}
