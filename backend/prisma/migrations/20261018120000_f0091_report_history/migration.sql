ALTER TYPE "ReportArtifactStatus" ADD VALUE 'FAILED';

ALTER TYPE "ReportAuditEventType" ADD VALUE 'REPORT_REUSED';
ALTER TYPE "ReportAuditEventType" ADD VALUE 'REPORT_REGENERATED';
ALTER TYPE "ReportAuditEventType" ADD VALUE 'REPORT_FAILED';

ALTER TABLE "ReportArtifact"
  ADD COLUMN "sizeBytes" INTEGER,
  ADD COLUMN "failureReason" TEXT;

CREATE INDEX "ReportArtifact_generatedAt_idx"
  ON "ReportArtifact"("generatedAt");
