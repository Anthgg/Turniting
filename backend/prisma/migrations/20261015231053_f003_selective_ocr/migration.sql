-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('NOT_NEEDED', 'REQUIRED', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ExtractionMethod" AS ENUM ('DIGITAL', 'OCR', 'HYBRID', 'NONE');

-- CreateEnum
CREATE TYPE "OcrRunStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- DropForeignKey
ALTER TABLE "GroundTruthCase" DROP CONSTRAINT "GroundTruthCase_aiReportId_fkey";

-- DropForeignKey
ALTER TABLE "GroundTruthCase" DROP CONSTRAINT "GroundTruthCase_similarityReportId_fkey";

-- AlterTable
ALTER TABLE "DocumentVersion" ADD COLUMN     "averageOcrConfidence" DOUBLE PRECISION,
ADD COLUMN     "ocrStatus" "OcrStatus" NOT NULL DEFAULT 'NOT_NEEDED';

-- AlterTable
ALTER TABLE "TurnitinReport" ADD COLUMN     "alignmentEngine" TEXT,
ADD COLUMN     "alignmentStale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "alignmentVersion" TEXT;

-- CreateTable
CREATE TABLE "DocumentPage" (
    "id" UUID NOT NULL,
    "documentVersionId" UUID NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "extractionMethod" "ExtractionMethod" NOT NULL DEFAULT 'NONE',
    "digitalText" TEXT,
    "ocrText" TEXT,
    "canonicalText" TEXT NOT NULL DEFAULT '',
    "requiresOcr" BOOLEAN NOT NULL DEFAULT false,
    "ocrConfidence" DOUBLE PRECISION,
    "ocrBlockCount" INTEGER,
    "ocrLowConfidenceCount" INTEGER,
    "ocrMetadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OcrRun" (
    "id" UUID NOT NULL,
    "documentVersionId" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "pipelineVersion" TEXT NOT NULL,
    "status" "OcrRunStatus" NOT NULL DEFAULT 'PROCESSING',
    "pagesRequested" INTEGER NOT NULL DEFAULT 0,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "pagesSkipped" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "averageConfidence" DOUBLE PRECISION,
    "durationMs" INTEGER,
    "config" JSONB,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcrRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentPage_documentVersionId_pageNumber_idx" ON "DocumentPage"("documentVersionId", "pageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPage_documentVersionId_pageNumber_key" ON "DocumentPage"("documentVersionId", "pageNumber");

-- CreateIndex
CREATE INDEX "OcrRun_documentVersionId_createdAt_idx" ON "OcrRun"("documentVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "OcrRun_status_createdAt_idx" ON "OcrRun"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcrRun" ADD CONSTRAINT "OcrRun_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroundTruthCase" ADD CONSTRAINT "GroundTruthCase_aiReportId_fkey" FOREIGN KEY ("aiReportId") REFERENCES "TurnitinReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroundTruthCase" ADD CONSTRAINT "GroundTruthCase_similarityReportId_fkey" FOREIGN KEY ("similarityReportId") REFERENCES "TurnitinReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
