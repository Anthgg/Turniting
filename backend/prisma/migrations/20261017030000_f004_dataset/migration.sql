-- CreateEnum
CREATE TYPE "DatasetStatus" AS ENUM ('DRAFT', 'BUILDING', 'READY', 'INVALID', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DatasetSourceStatus" AS ENUM ('INCLUDED', 'BLOCKED_ACCESS', 'EXCLUDED_LICENSE', 'CONSIDERED');

-- CreateEnum
CREATE TYPE "DatasetSourceType" AS ENUM ('HUGGINGFACE', 'ZENODO', 'GITHUB', 'LOCAL', 'TURNITIN', 'OTHER');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('ALLOWED', 'NON_COMMERCIAL_ONLY', 'UNDECLARED', 'RESTRICTED', 'UNKNOWN', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CommercialUseStatus" AS ENUM ('ALLOWED', 'NOT_ALLOWED', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "DatasetArtifactType" AS ENUM ('MANIFEST', 'LICENSE_AUDIT', 'STATISTICS', 'SPLIT_MANIFEST', 'PARQUET_SHARD', 'TRAINING_REPORT', 'EVALUATION_REPORT', 'CONFIG', 'MODEL_WEIGHTS');

-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('REPOSITORY', 'LOCAL', 'GOOGLE_DRIVE');

-- CreateEnum
CREATE TYPE "DatasetSplit" AS ENUM ('TRAIN', 'VALIDATION', 'TEST', 'OOD', 'ADVERSARIAL_TEST', 'ADVERSARIAL_VALIDATION', 'UNSEEN_GENERATOR_TEST', 'UNSEEN_DOMAIN_TEST', 'MIXED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TrainingLabel" AS ENUM ('HUMAN', 'MACHINE', 'MIXED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LabelSource" AS ENUM ('PUBLIC_DATASET', 'TURNITIN_AI_FLAGGED', 'MANUAL', 'SYNTHETIC', 'DERIVED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PrivacyClass" AS ENUM ('PUBLIC', 'PRIVATE', 'SYNTHETIC');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('EXPERIMENTAL', 'CANDIDATE', 'ACTIVE', 'RETIRED', 'INVALID');

-- CreateEnum
CREATE TYPE "ModelType" AS ENUM ('BASELINE', 'TRANSFORMER', 'ENSEMBLE');

-- CreateEnum
CREATE TYPE "CommercialEligibility" AS ENUM ('RESEARCH_ONLY', 'COMMERCIAL_ALLOWED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "DatasetVersion" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "DatasetStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdFromGitCommit" TEXT,
    "totalRows" INTEGER,
    "humanRows" INTEGER,
    "machineRows" INTEGER,
    "mixedRows" INTEGER,
    "spanishRows" INTEGER,
    "academicRows" INTEGER,
    "languageCount" INTEGER,
    "domainCount" INTEGER,
    "generatorCount" INTEGER,
    "exactDuplicatesRemoved" INTEGER,
    "nearDuplicatesRemoved" INTEGER,
    "labelConflicts" INTEGER,
    "leakageStatus" TEXT,
    "manifestPath" TEXT,
    "statisticsPath" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DatasetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetSource" (
    "id" UUID NOT NULL,
    "datasetVersionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DatasetSourceStatus" NOT NULL DEFAULT 'INCLUDED',
    "sourceUrl" TEXT,
    "sourceType" "DatasetSourceType" NOT NULL DEFAULT 'OTHER',
    "license" TEXT,
    "licenseStatus" "LicenseStatus" NOT NULL DEFAULT 'UNKNOWN',
    "commercialUseStatus" "CommercialUseStatus" NOT NULL DEFAULT 'UNCLEAR',
    "rowsAvailable" INTEGER,
    "rowsUsed" INTEGER,
    "spanishRows" INTEGER,
    "academicRows" INTEGER,
    "samplingWeight" DOUBLE PRECISION,
    "sha256" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetArtifact" (
    "id" UUID NOT NULL,
    "datasetVersionId" UUID,
    "modelVersionId" UUID,
    "artifactType" "DatasetArtifactType" NOT NULL,
    "storageProvider" "StorageProvider" NOT NULL DEFAULT 'REPOSITORY',
    "path" TEXT NOT NULL,
    "sha256" CHAR(64),
    "sizeBytes" BIGINT,
    "external" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSplitManifest" (
    "id" UUID NOT NULL,
    "datasetVersionId" UUID NOT NULL,
    "split" "DatasetSplit" NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "groupCount" INTEGER,
    "manifestPath" TEXT,
    "sha256" CHAR(64),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingSplitManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSample" (
    "id" UUID NOT NULL,
    "datasetVersionId" UUID,
    "datasetSourceId" UUID,
    "documentVersionId" UUID,
    "turnitinSegmentId" UUID,
    "groundTruthCaseId" UUID,
    "externalSampleId" TEXT,
    "text" TEXT,
    "textHash" CHAR(64) NOT NULL,
    "label" "TrainingLabel" NOT NULL DEFAULT 'UNKNOWN',
    "labelSource" "LabelSource" NOT NULL DEFAULT 'UNKNOWN',
    "language" TEXT,
    "domain" TEXT,
    "generator" TEXT,
    "split" "DatasetSplit",
    "eligibleForTraining" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "privacyClass" "PrivacyClass" NOT NULL DEFAULT 'PRIVATE',
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "architecture" TEXT NOT NULL,
    "variant" TEXT,
    "datasetVersionId" UUID,
    "status" "ModelStatus" NOT NULL DEFAULT 'EXPERIMENTAL',
    "modelType" "ModelType" NOT NULL,
    "trainingEnvironment" TEXT,
    "commercialEligibility" "CommercialEligibility" NOT NULL DEFAULT 'UNKNOWN',
    "artifactProvider" "StorageProvider",
    "artifactPath" TEXT,
    "gitCommit" TEXT,
    "metrics" JSONB NOT NULL,
    "thresholds" JSONB,
    "calibration" JSONB,
    "limitations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DatasetVersion_status_createdAt_idx" ON "DatasetVersion"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetVersion_name_version_key" ON "DatasetVersion"("name", "version");

-- CreateIndex
CREATE INDEX "DatasetSource_datasetVersionId_licenseStatus_idx" ON "DatasetSource"("datasetVersionId", "licenseStatus");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetSource_datasetVersionId_name_key" ON "DatasetSource"("datasetVersionId", "name");

-- CreateIndex
CREATE INDEX "DatasetArtifact_modelVersionId_idx" ON "DatasetArtifact"("modelVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetArtifact_datasetVersionId_artifactType_path_key" ON "DatasetArtifact"("datasetVersionId", "artifactType", "path");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingSplitManifest_datasetVersionId_split_key" ON "TrainingSplitManifest"("datasetVersionId", "split");

-- CreateIndex
CREATE INDEX "TrainingSample_datasetVersionId_label_split_idx" ON "TrainingSample"("datasetVersionId", "label", "split");

-- CreateIndex
CREATE INDEX "TrainingSample_groundTruthCaseId_idx" ON "TrainingSample"("groundTruthCaseId");

-- CreateIndex
CREATE INDEX "TrainingSample_textHash_idx" ON "TrainingSample"("textHash");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingSample_datasetVersionId_turnitinSegmentId_key" ON "TrainingSample"("datasetVersionId", "turnitinSegmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelVersion_name_key" ON "ModelVersion"("name");

-- CreateIndex
CREATE INDEX "ModelVersion_status_createdAt_idx" ON "ModelVersion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ModelVersion_datasetVersionId_idx" ON "ModelVersion"("datasetVersionId");

-- AddForeignKey
ALTER TABLE "DatasetSource" ADD CONSTRAINT "DatasetSource_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetArtifact" ADD CONSTRAINT "DatasetArtifact_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetArtifact" ADD CONSTRAINT "DatasetArtifact_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSplitManifest" ADD CONSTRAINT "TrainingSplitManifest_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSample" ADD CONSTRAINT "TrainingSample_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSample" ADD CONSTRAINT "TrainingSample_datasetSourceId_fkey" FOREIGN KEY ("datasetSourceId") REFERENCES "DatasetSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSample" ADD CONSTRAINT "TrainingSample_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSample" ADD CONSTRAINT "TrainingSample_turnitinSegmentId_fkey" FOREIGN KEY ("turnitinSegmentId") REFERENCES "TurnitinSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSample" ADD CONSTRAINT "TrainingSample_groundTruthCaseId_fkey" FOREIGN KEY ("groundTruthCaseId") REFERENCES "GroundTruthCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelVersion" ADD CONSTRAINT "ModelVersion_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

