-- F009.0 expiring report artifacts. Source analysis and similarity data remain separate.
CREATE TYPE "ReportType" AS ENUM ('AI_REPORT', 'SIMILARITY_REPORT');
CREATE TYPE "ReportArtifactStatus" AS ENUM ('GENERATING', 'AVAILABLE', 'ERROR', 'EXPIRED', 'DELETED');
CREATE TYPE "ReportAuditEventType" AS ENUM ('REPORT_GENERATED', 'REPORT_DOWNLOADED', 'REPORT_EXPIRED', 'REPORT_DELETED');

CREATE TABLE "ReportArtifact" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "documentVersionId" UUID NOT NULL,
    "analysisRunId" UUID,
    "similarityRunId" UUID,
    "type" "ReportType" NOT NULL,
    "status" "ReportArtifactStatus" NOT NULL DEFAULT 'GENERATING',
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "activeFingerprint" VARCHAR(64),
    "contentHash" CHAR(64),
    "generatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "generationVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ReportArtifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReportAuditEvent" (
    "id" UUID NOT NULL,
    "reportArtifactId" UUID NOT NULL,
    "type" "ReportAuditEventType" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "ReportAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReportArtifact_activeFingerprint_key" ON "ReportArtifact"("activeFingerprint");
CREATE INDEX "ReportArtifact_documentId_generatedAt_idx" ON "ReportArtifact"("documentId", "generatedAt");
CREATE INDEX "ReportArtifact_expiresAt_deletedAt_idx" ON "ReportArtifact"("expiresAt", "deletedAt");
CREATE INDEX "ReportArtifact_analysisRunId_idx" ON "ReportArtifact"("analysisRunId");
CREATE INDEX "ReportArtifact_similarityRunId_idx" ON "ReportArtifact"("similarityRunId");
CREATE INDEX "ReportArtifact_fingerprint_idx" ON "ReportArtifact"("fingerprint");
CREATE INDEX "ReportAuditEvent_reportArtifactId_createdAt_idx" ON "ReportAuditEvent"("reportArtifactId", "createdAt");

ALTER TABLE "ReportArtifact" ADD CONSTRAINT "ReportArtifact_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportArtifact" ADD CONSTRAINT "ReportArtifact_documentVersionId_fkey"
  FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportArtifact" ADD CONSTRAINT "ReportArtifact_analysisRunId_fkey"
  FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReportAuditEvent" ADD CONSTRAINT "ReportAuditEvent_reportArtifactId_fkey"
  FOREIGN KEY ("reportArtifactId") REFERENCES "ReportArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
