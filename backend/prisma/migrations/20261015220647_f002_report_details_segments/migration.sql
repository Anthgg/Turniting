-- AlterTable
ALTER TABLE "TurnitinReport" ADD COLUMN     "downloadedAt" TIMESTAMPTZ(6),
ADD COLUMN     "requiresOcr" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "submittedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "TurnitinSegment" ADD COLUMN     "normalizedText" TEXT;
