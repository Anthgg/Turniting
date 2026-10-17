-- CreateEnum
CREATE TYPE "AnalysisRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalyzerMode" AS ENUM ('V2_ONLY', 'V3_ONLY', 'ENSEMBLE');

-- CreateEnum
CREATE TYPE "AnalysisGranularity" AS ENUM ('DOCUMENT', 'PARAGRAPH');

-- CreateEnum
CREATE TYPE "AnalysisClassification" AS ENUM ('MACHINE_SIGNAL', 'LOW_SIGNAL', 'INSUFFICIENT_TEXT');

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" UUID NOT NULL,
    "documentVersionId" UUID NOT NULL,
    "status" "AnalysisRunStatus" NOT NULL DEFAULT 'PENDING',
    "analyzerMode" "AnalyzerMode" NOT NULL,
    "analyzerVersion" TEXT NOT NULL,
    "thresholdProfile" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "granularity" "AnalysisGranularity" NOT NULL DEFAULT 'PARAGRAPH',
    "paragraphMode" TEXT,
    "documentAggregation" TEXT,
    "documentScore" DOUBLE PRECISION,
    "documentClassification" "AnalysisClassification",
    "signalLevel" TEXT,
    "scoredSegments" INTEGER NOT NULL DEFAULT 0,
    "insufficientSegments" INTEGER NOT NULL DEFAULT 0,
    "inferenceMs" INTEGER,
    "textHash" CHAR(64),
    "errorCode" TEXT,
    "error" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisModelResult" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "modelVersionId" UUID,
    "modelName" TEXT NOT NULL,
    "modelVariant" TEXT,
    "rawScore" DOUBLE PRECISION,
    "calibratedScore" DOUBLE PRECISION,
    "thresholdProfile" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "classification" "AnalysisClassification",
    "confidence" TEXT,
    "calibration" TEXT,
    "preprocessing" TEXT,
    "inferenceMs" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisModelResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisSegment" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "paragraphIndex" INTEGER NOT NULL,
    "textHash" CHAR(64) NOT NULL,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "pageNumber" INTEGER,
    "words" INTEGER,
    "tokens" INTEGER,
    "rawScore" DOUBLE PRECISION,
    "calibratedScore" DOUBLE PRECISION,
    "classification" "AnalysisClassification" NOT NULL,
    "signalLevel" TEXT,
    "confidence" TEXT,
    "modelVersionId" UUID,
    "modelName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisComparison" (
    "id" UUID NOT NULL,
    "baseAnalysisRunId" UUID NOT NULL,
    "targetAnalysisRunId" UUID NOT NULL,
    "documentSimilarity" DOUBLE PRECISION,
    "globalScoreDelta" DOUBLE PRECISION,
    "changedSegments" INTEGER NOT NULL DEFAULT 0,
    "unchangedSegments" INTEGER NOT NULL DEFAULT 0,
    "addedSegments" INTEGER NOT NULL DEFAULT 0,
    "removedSegments" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisComparison_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalysisRun_documentVersionId_createdAt_idx" ON "AnalysisRun"("documentVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_status_createdAt_idx" ON "AnalysisRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisModelResult_analysisRunId_idx" ON "AnalysisModelResult"("analysisRunId");

-- CreateIndex
CREATE INDEX "AnalysisSegment_analysisRunId_idx" ON "AnalysisSegment"("analysisRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisSegment_analysisRunId_paragraphIndex_key" ON "AnalysisSegment"("analysisRunId", "paragraphIndex");

-- CreateIndex
CREATE INDEX "AnalysisComparison_baseAnalysisRunId_idx" ON "AnalysisComparison"("baseAnalysisRunId");

-- CreateIndex
CREATE INDEX "AnalysisComparison_targetAnalysisRunId_idx" ON "AnalysisComparison"("targetAnalysisRunId");

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisModelResult" ADD CONSTRAINT "AnalysisModelResult_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisModelResult" ADD CONSTRAINT "AnalysisModelResult_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisSegment" ADD CONSTRAINT "AnalysisSegment_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisSegment" ADD CONSTRAINT "AnalysisSegment_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisComparison" ADD CONSTRAINT "AnalysisComparison_baseAnalysisRunId_fkey" FOREIGN KEY ("baseAnalysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisComparison" ADD CONSTRAINT "AnalysisComparison_targetAnalysisRunId_fkey" FOREIGN KEY ("targetAnalysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

