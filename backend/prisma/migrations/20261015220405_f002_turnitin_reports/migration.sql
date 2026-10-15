-- CreateEnum
CREATE TYPE "TurnitinReportType" AS ENUM ('AI_WRITING', 'SIMILARITY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TurnitinReportStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'PARSED', 'PARTIAL', 'FAILED', 'OCR_REQUIRED');

-- CreateEnum
CREATE TYPE "TurnitinSourceType" AS ENUM ('INTERNET', 'PUBLICATION', 'STUDENT_PAPER', 'OTHER');

-- CreateEnum
CREATE TYPE "TurnitinSegmentType" AS ENUM ('AI_FLAGGED', 'SIMILARITY_MATCH', 'NOT_FLAGGED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TurnitinMatchStatus" AS ENUM ('UNVERIFIED', 'EXACT', 'HIGH', 'PARTIAL', 'MISMATCH');

-- CreateEnum
CREATE TYPE "TurnitinSubmissionRelation" AS ENUM ('UNKNOWN', 'SAME', 'DIFFERENT');

-- CreateEnum
CREATE TYPE "GroundTruthCaseType" AS ENUM ('AI_REPORT', 'SIMILARITY_REPORT', 'VALIDATION');

-- CreateTable
CREATE TABLE "TurnitinReport" (
    "id" UUID NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "size" INTEGER NOT NULL,
    "fileHash" CHAR(64) NOT NULL,
    "storageKey" TEXT NOT NULL,
    "reportType" "TurnitinReportType" NOT NULL DEFAULT 'UNKNOWN',
    "status" "TurnitinReportStatus" NOT NULL DEFAULT 'UPLOADED',
    "parserVersion" TEXT,
    "submissionId" TEXT,
    "submissionFileName" TEXT,
    "reportPageCount" INTEGER,
    "documentPageCount" INTEGER,
    "wordCount" INTEGER,
    "characterCount" INTEGER,
    "aiWritingScore" DOUBLE PRECISION,
    "aiWritingScoreRaw" TEXT,
    "similarityScore" DOUBLE PRECISION,
    "similarityScoreRaw" TEXT,
    "internetScore" DOUBLE PRECISION,
    "internetScoreRaw" TEXT,
    "publicationScore" DOUBLE PRECISION,
    "publicationScoreRaw" TEXT,
    "studentPapersScore" DOUBLE PRECISION,
    "studentPapersScoreRaw" TEXT,
    "filters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reportMetadata" JSONB,
    "documentVersionId" UUID,
    "contentMatchStatus" "TurnitinMatchStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "submissionRelation" "TurnitinSubmissionRelation" NOT NULL DEFAULT 'UNKNOWN',
    "contentSimilarityRatio" DOUBLE PRECISION,
    "contentMatchEvidence" JSONB,
    "matchedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TurnitinReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TurnitinSource" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "sourceIndex" INTEGER NOT NULL,
    "sourceType" "TurnitinSourceType" NOT NULL DEFAULT 'OTHER',
    "displayName" TEXT NOT NULL,
    "percentageRaw" TEXT,
    "percentage" DOUBLE PRECISION,
    "percentageIsLessThan" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TurnitinSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TurnitinSegment" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "sourceId" UUID,
    "segmentIndex" INTEGER NOT NULL,
    "segmentType" "TurnitinSegmentType" NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "bbox" JSONB NOT NULL,
    "sourceIndex" INTEGER,
    "color" TEXT,
    "documentStartOffset" INTEGER,
    "documentEndOffset" INTEGER,
    "alignmentMethod" TEXT,
    "alignmentScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TurnitinSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroundTruthCase" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "caseType" "GroundTruthCaseType" NOT NULL,
    "aiReportId" UUID,
    "similarityReportId" UUID,
    "documentVersionId" UUID,
    "submissionRelation" "TurnitinSubmissionRelation" NOT NULL DEFAULT 'UNKNOWN',
    "contentMatchStatus" "TurnitinMatchStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "validationStatus" "TurnitinMatchStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "expectedData" JSONB,
    "actualData" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GroundTruthCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TurnitinReport_storageKey_key" ON "TurnitinReport"("storageKey");

-- CreateIndex
CREATE INDEX "TurnitinReport_reportType_createdAt_idx" ON "TurnitinReport"("reportType", "createdAt");

-- CreateIndex
CREATE INDEX "TurnitinReport_status_createdAt_idx" ON "TurnitinReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TurnitinReport_documentVersionId_idx" ON "TurnitinReport"("documentVersionId");

-- CreateIndex
CREATE INDEX "TurnitinSource_reportId_sourceType_idx" ON "TurnitinSource"("reportId", "sourceType");

-- CreateIndex
CREATE UNIQUE INDEX "TurnitinSource_reportId_sourceIndex_key" ON "TurnitinSource"("reportId", "sourceIndex");

-- CreateIndex
CREATE INDEX "TurnitinSegment_reportId_segmentType_segmentIndex_idx" ON "TurnitinSegment"("reportId", "segmentType", "segmentIndex");

-- CreateIndex
CREATE INDEX "TurnitinSegment_sourceId_idx" ON "TurnitinSegment"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "TurnitinSegment_reportId_segmentIndex_key" ON "TurnitinSegment"("reportId", "segmentIndex");

-- CreateIndex
CREATE UNIQUE INDEX "GroundTruthCase_name_key" ON "GroundTruthCase"("name");

-- CreateIndex
CREATE INDEX "GroundTruthCase_caseType_createdAt_idx" ON "GroundTruthCase"("caseType", "createdAt");

-- CreateIndex
CREATE INDEX "GroundTruthCase_documentVersionId_idx" ON "GroundTruthCase"("documentVersionId");

-- AddForeignKey
ALTER TABLE "TurnitinReport" ADD CONSTRAINT "TurnitinReport_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TurnitinSource" ADD CONSTRAINT "TurnitinSource_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TurnitinReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TurnitinSegment" ADD CONSTRAINT "TurnitinSegment_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TurnitinReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TurnitinSegment" ADD CONSTRAINT "TurnitinSegment_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TurnitinSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroundTruthCase" ADD CONSTRAINT "GroundTruthCase_aiReportId_fkey" FOREIGN KEY ("aiReportId") REFERENCES "TurnitinReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroundTruthCase" ADD CONSTRAINT "GroundTruthCase_similarityReportId_fkey" FOREIGN KEY ("similarityReportId") REFERENCES "TurnitinReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroundTruthCase" ADD CONSTRAINT "GroundTruthCase_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
