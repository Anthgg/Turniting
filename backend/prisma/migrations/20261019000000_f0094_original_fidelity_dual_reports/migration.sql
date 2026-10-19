ALTER TYPE "ReportType" ADD VALUE 'AI_ORIGINAL_REVIEW';
ALTER TYPE "ReportType" ADD VALUE 'AI_PARAGRAPH_TECHNICAL';

CREATE TYPE "OriginalRenderSourceType" AS ENUM ('PDF', 'DOCX');
CREATE TYPE "OriginalRenderFidelityStatus" AS ENUM (
  'EXACT_SOURCE_PDF',
  'HIGH_FIDELITY_CONVERSION',
  'BEST_EFFORT'
);

CREATE TABLE "OriginalRenderArtifact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "documentId" UUID NOT NULL,
  "documentVersionId" UUID NOT NULL,
  "sourceType" "OriginalRenderSourceType" NOT NULL,
  "sourceChecksum" CHAR(64) NOT NULL,
  "renderer" TEXT NOT NULL,
  "rendererVersion" TEXT NOT NULL,
  "layoutExtractionEngine" TEXT NOT NULL,
  "layoutExtractionVersion" TEXT NOT NULL,
  "pageCount" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "renderChecksum" CHAR(64) NOT NULL,
  "fidelityStatus" "OriginalRenderFidelityStatus" NOT NULL,
  "layoutPages" JSONB NOT NULL,
  "cacheKey" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "deletedAt" TIMESTAMPTZ(6),

  CONSTRAINT "OriginalRenderArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OriginalRenderArtifact_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OriginalRenderArtifact_documentVersionId_fkey"
    FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OriginalRenderArtifact_storageKey_key"
  ON "OriginalRenderArtifact"("storageKey");
CREATE UNIQUE INDEX "OriginalRenderArtifact_cacheKey_key"
  ON "OriginalRenderArtifact"("cacheKey");
CREATE INDEX "OriginalRenderArtifact_documentVersionId_expiresAt_deletedAt_idx"
  ON "OriginalRenderArtifact"("documentVersionId", "expiresAt", "deletedAt");
CREATE INDEX "OriginalRenderArtifact_expiresAt_deletedAt_idx"
  ON "OriginalRenderArtifact"("expiresAt", "deletedAt");

CREATE TABLE "DocumentLayoutMap" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "documentId" UUID NOT NULL,
  "documentVersionId" UUID NOT NULL,
  "analysisRunId" UUID NOT NULL,
  "originalRenderArtifactId" UUID NOT NULL,
  "sourceChecksum" CHAR(64) NOT NULL,
  "rendererVersion" TEXT NOT NULL,
  "layoutExtractionVersion" TEXT NOT NULL,
  "mappingEngine" TEXT NOT NULL,
  "mappingVersion" TEXT NOT NULL,
  "layoutMap" JSONB NOT NULL,
  "cacheKey" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "deletedAt" TIMESTAMPTZ(6),

  CONSTRAINT "DocumentLayoutMap_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentLayoutMap_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DocumentLayoutMap_documentVersionId_fkey"
    FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DocumentLayoutMap_analysisRunId_fkey"
    FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DocumentLayoutMap_originalRenderArtifactId_fkey"
    FOREIGN KEY ("originalRenderArtifactId") REFERENCES "OriginalRenderArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DocumentLayoutMap_cacheKey_key"
  ON "DocumentLayoutMap"("cacheKey");
CREATE INDEX "DocumentLayoutMap_documentVersionId_expiresAt_deletedAt_idx"
  ON "DocumentLayoutMap"("documentVersionId", "expiresAt", "deletedAt");
CREATE INDEX "DocumentLayoutMap_expiresAt_deletedAt_idx"
  ON "DocumentLayoutMap"("expiresAt", "deletedAt");
