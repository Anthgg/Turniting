-- Keep the existing Document rows and metadata while constraining upload states.
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'EXTRACTED', 'OCR_REQUIRED', 'FAILED');

ALTER TABLE "Document" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Document"
  ALTER COLUMN "status" TYPE "DocumentStatus"
  USING (
    CASE LOWER("status")
      WHEN 'pending' THEN 'UPLOADED'
      WHEN 'uploaded' THEN 'UPLOADED'
      WHEN 'processing' THEN 'PROCESSING'
      WHEN 'extracted' THEN 'EXTRACTED'
      WHEN 'ocr_required' THEN 'OCR_REQUIRED'
      WHEN 'failed' THEN 'FAILED'
      ELSE 'UPLOADED'
    END
  )::"DocumentStatus";
ALTER TABLE "Document" ALTER COLUMN "status" SET DEFAULT 'UPLOADED';

CREATE TABLE "DocumentVersion" (
  "id" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "storageKey" TEXT NOT NULL,
  "fileHash" CHAR(64) NOT NULL,
  "extractedText" TEXT,
  "extractionError" TEXT,
  "pageCount" INTEGER,
  "wordCount" INTEGER,
  "characterCount" INTEGER,
  "requiresOcr" BOOLEAN NOT NULL DEFAULT false,
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentVersion_documentId_key" ON "DocumentVersion"("documentId");
CREATE UNIQUE INDEX "DocumentVersion_storageKey_key" ON "DocumentVersion"("storageKey");

ALTER TABLE "DocumentVersion"
  ADD CONSTRAINT "DocumentVersion_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
