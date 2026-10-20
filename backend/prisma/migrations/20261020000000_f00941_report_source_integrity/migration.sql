-- Source bindings are derived from persisted DocumentVersions, never report paths.
-- Legacy sources retain honest provenance: a generated filename is not proof of
-- automatic ingestion, and manually uploaded Turniting reports remain Documents.
BEGIN;

ALTER TABLE "DocumentVersion"
  ADD COLUMN "originalFilename" TEXT,
  ADD COLUMN "mimeType" TEXT,
  ADD COLUMN "ingestionOrigin" TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN';

UPDATE "DocumentVersion" AS version
SET "originalFilename" = document."originalName",
    "mimeType" = document."mimeType"
FROM "Document" AS document
WHERE document.id = version."documentId";

ALTER TABLE "DocumentVersion"
  ALTER COLUMN "originalFilename" SET NOT NULL,
  ALTER COLUMN "mimeType" SET NOT NULL;

ALTER TABLE "AnalysisRun"
  ADD COLUMN "sourceDocumentId" UUID,
  ADD COLUMN "sourceDocumentVersionId" UUID;

UPDATE "AnalysisRun" AS run
SET "sourceDocumentId" = version."documentId",
    "sourceDocumentVersionId" = version.id
FROM "DocumentVersion" AS version
WHERE version.id = run."documentVersionId";

ALTER TABLE "AnalysisRun"
  ALTER COLUMN "sourceDocumentId" SET NOT NULL,
  ALTER COLUMN "sourceDocumentVersionId" SET NOT NULL,
  ADD CONSTRAINT "AnalysisRun_sourceDocumentId_fkey"
    FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AnalysisRun_sourceDocumentVersionId_fkey"
    FOREIGN KEY ("sourceDocumentVersionId") REFERENCES "DocumentVersion"(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AnalysisRun_sourceDocumentVersionId_idx" ON "AnalysisRun"("sourceDocumentVersionId");

ALTER TABLE "ReportArtifact"
  ADD COLUMN "sourceDocumentId" UUID,
  ADD COLUMN "sourceDocumentVersionId" UUID,
  ADD COLUMN "sourceChecksum" CHAR(64),
  ADD COLUMN "generatedBy" TEXT NOT NULL DEFAULT 'TURNITING',
  ADD COLUMN "analysisSnapshot" JSONB;

UPDATE "ReportArtifact" AS report
SET "sourceDocumentId" = version."documentId",
    "sourceDocumentVersionId" = version.id,
    "sourceChecksum" = version."fileHash"
FROM "DocumentVersion" AS version
WHERE version.id = COALESCE(
  (SELECT run."sourceDocumentVersionId" FROM "AnalysisRun" AS run WHERE run.id = report."analysisRunId"),
  report."documentVersionId"
);

-- Do not repair a pre-existing cross-run association silently. Abort deployment
-- if the database contradicts the source bindings rather than rewrite evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ReportArtifact" AS report
    WHERE report."documentId" IS DISTINCT FROM report."sourceDocumentId"
       OR report."documentVersionId" IS DISTINCT FROM report."sourceDocumentVersionId"
  ) THEN
    RAISE EXCEPTION 'REPORT_SOURCE_INTEGRITY_BACKFILL_MISMATCH' USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "ReportArtifact"
  ALTER COLUMN "sourceDocumentId" SET NOT NULL,
  ALTER COLUMN "sourceDocumentVersionId" SET NOT NULL,
  ALTER COLUMN "sourceChecksum" SET NOT NULL,
  ADD CONSTRAINT "ReportArtifact_sourceDocumentId_fkey"
    FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReportArtifact_sourceDocumentVersionId_fkey"
    FOREIGN KEY ("sourceDocumentVersionId") REFERENCES "DocumentVersion"(id) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ReportArtifact_sourceDocumentVersionId_idx" ON "ReportArtifact"("sourceDocumentVersionId");

-- A persisted report cannot lose the AnalysisRun that gives its score/source
-- meaning. Parent Document deletion still cascades reports and their runs.
ALTER TABLE "ReportArtifact"
  DROP CONSTRAINT "ReportArtifact_analysisRunId_fkey",
  ADD CONSTRAINT "ReportArtifact_analysisRunId_fkey"
    FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"(id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- BEFORE INSERT supplies derived defaults for older AnalysisService callers.
-- Prisma marks these fields dbgenerated; no UUID/random or filename default is
-- allowed to fabricate a source binding when a caller omits them.
CREATE FUNCTION "f00941_document_version_source_guard"() RETURNS trigger AS $$
DECLARE
  source_document "Document"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO STRICT source_document FROM "Document" WHERE id = NEW."documentId";
    NEW."originalFilename" := COALESCE(NEW."originalFilename", source_document."originalName");
    NEW."mimeType" := COALESCE(NEW."mimeType", source_document."mimeType");
    NEW."ingestionOrigin" := COALESCE(NEW."ingestionOrigin", 'LEGACY_UNKNOWN');
  ELSIF EXISTS (SELECT 1 FROM "AnalysisRun" WHERE "documentVersionId" = OLD.id) AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
    OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey"
    OR NEW."fileHash" IS DISTINCT FROM OLD."fileHash"
    OR NEW."originalFilename" IS DISTINCT FROM OLD."originalFilename"
    OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
    OR NEW."ingestionOrigin" IS DISTINCT FROM OLD."ingestionOrigin"
  ) THEN
    RAISE EXCEPTION 'ANALYZED_DOCUMENT_SOURCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "f00941_document_version_source_guard"
BEFORE INSERT OR UPDATE ON "DocumentVersion"
FOR EACH ROW EXECUTE FUNCTION "f00941_document_version_source_guard"();

CREATE FUNCTION "f00941_analysis_source_guard"() RETURNS trigger AS $$
DECLARE
  source_version "DocumentVersion"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."documentVersionId" IS DISTINCT FROM OLD."documentVersionId"
    OR NEW."sourceDocumentId" IS DISTINCT FROM OLD."sourceDocumentId"
    OR NEW."sourceDocumentVersionId" IS DISTINCT FROM OLD."sourceDocumentVersionId"
  ) THEN
    RAISE EXCEPTION 'ANALYSIS_SOURCE_BINDING_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO STRICT source_version FROM "DocumentVersion"
  WHERE id = NEW."documentVersionId" FOR SHARE;
  NEW."sourceDocumentId" := COALESCE(NEW."sourceDocumentId", source_version."documentId");
  NEW."sourceDocumentVersionId" := COALESCE(NEW."sourceDocumentVersionId", source_version.id);
  IF NEW."sourceDocumentId" IS DISTINCT FROM source_version."documentId"
     OR NEW."sourceDocumentVersionId" IS DISTINCT FROM source_version.id THEN
    RAISE EXCEPTION 'ANALYSIS_SOURCE_BINDING_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "f00941_analysis_source_guard"
BEFORE INSERT OR UPDATE ON "AnalysisRun"
FOR EACH ROW EXECUTE FUNCTION "f00941_analysis_source_guard"();

CREATE FUNCTION "f00941_report_source_guard"() RETURNS trigger AS $$
DECLARE
  source_version "DocumentVersion"%ROWTYPE;
  source_run "AnalysisRun"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."documentId" IS DISTINCT FROM OLD."documentId"
    OR NEW."documentVersionId" IS DISTINCT FROM OLD."documentVersionId"
    OR NEW."analysisRunId" IS DISTINCT FROM OLD."analysisRunId"
    OR NEW."sourceDocumentId" IS DISTINCT FROM OLD."sourceDocumentId"
    OR NEW."sourceDocumentVersionId" IS DISTINCT FROM OLD."sourceDocumentVersionId"
    OR NEW."sourceChecksum" IS DISTINCT FROM OLD."sourceChecksum"
    OR NEW."generatedBy" IS DISTINCT FROM OLD."generatedBy"
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW."analysisSnapshot" IS DISTINCT FROM OLD."analysisSnapshot"
  ) THEN
    RAISE EXCEPTION 'REPORT_SOURCE_BINDING_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."analysisRunId" IS NOT NULL THEN
    SELECT * INTO STRICT source_run FROM "AnalysisRun"
    WHERE id = NEW."analysisRunId" FOR SHARE;
    IF NEW."documentId" IS DISTINCT FROM source_run."sourceDocumentId"
       OR NEW."documentVersionId" IS DISTINCT FROM source_run."sourceDocumentVersionId" THEN
      RAISE EXCEPTION 'REPORT_ANALYSIS_SOURCE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO STRICT source_version FROM "DocumentVersion"
  WHERE id = NEW."documentVersionId" FOR SHARE;
  NEW."sourceDocumentId" := COALESCE(NEW."sourceDocumentId", source_version."documentId");
  NEW."sourceDocumentVersionId" := COALESCE(NEW."sourceDocumentVersionId", source_version.id);
  NEW."sourceChecksum" := COALESCE(NEW."sourceChecksum", source_version."fileHash");
  IF NEW."documentId" IS DISTINCT FROM source_version."documentId"
     OR NEW."sourceDocumentId" IS DISTINCT FROM source_version."documentId"
     OR NEW."sourceDocumentVersionId" IS DISTINCT FROM source_version.id
     OR NEW."sourceChecksum" IS DISTINCT FROM source_version."fileHash"
     OR NEW."generatedBy" IS DISTINCT FROM 'TURNITING' THEN
    RAISE EXCEPTION 'REPORT_SOURCE_BINDING_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT'
     AND NEW."analysisSnapshot" IS NOT NULL
     AND NEW."analysisSnapshot" ->> 'version' = 'f00941-analysis-source-v1' THEN
    IF NEW."analysisRunId" IS NULL
       OR jsonb_typeof(NEW."analysisSnapshot" -> 'source') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW."analysisSnapshot" -> 'run') IS DISTINCT FROM 'object'
       OR NOT (NEW."analysisSnapshot" -> 'source' ?& ARRAY[
         'documentId', 'documentVersionId', 'originalFilename', 'mimeType', 'sourceChecksum'
       ])
       OR NOT (NEW."analysisSnapshot" -> 'run' ?& ARRAY[
         'id', 'globalScore', 'threshold', 'analyzerMode', 'analyzerVersion', 'thresholdProfile', 'paragraphMode'
       ])
       OR NEW."analysisSnapshot" #>> '{source,documentId}' IS DISTINCT FROM source_version."documentId"::text
       OR NEW."analysisSnapshot" #>> '{source,documentVersionId}' IS DISTINCT FROM source_version.id::text
       OR NEW."analysisSnapshot" #>> '{source,sourceChecksum}' IS DISTINCT FROM source_version."fileHash"::text
       OR NEW."analysisSnapshot" #>> '{source,originalFilename}' IS DISTINCT FROM source_version."originalFilename"
       OR NEW."analysisSnapshot" #>> '{source,mimeType}' IS DISTINCT FROM source_version."mimeType"
       OR NEW."analysisSnapshot" #>> '{run,id}' IS DISTINCT FROM source_run.id::text
       OR NEW."analysisSnapshot" #> '{run,globalScore}' IS DISTINCT FROM COALESCE(to_jsonb(source_run."documentScore"), 'null'::jsonb)
       OR NEW."analysisSnapshot" #> '{run,threshold}' IS DISTINCT FROM COALESCE(to_jsonb(source_run.threshold), 'null'::jsonb)
       OR NEW."analysisSnapshot" #>> '{run,analyzerMode}' IS DISTINCT FROM source_run."analyzerMode"::text
       OR NEW."analysisSnapshot" #>> '{run,analyzerVersion}' IS DISTINCT FROM source_run."analyzerVersion"
       OR NEW."analysisSnapshot" #>> '{run,thresholdProfile}' IS DISTINCT FROM source_run."thresholdProfile"
       OR NEW."analysisSnapshot" #> '{run,paragraphMode}' IS DISTINCT FROM COALESCE(to_jsonb(source_run."paragraphMode"), 'null'::jsonb)
    THEN
      RAISE EXCEPTION 'REPORT_ANALYSIS_SNAPSHOT_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "f00941_report_source_guard"
BEFORE INSERT OR UPDATE ON "ReportArtifact"
FOR EACH ROW EXECUTE FUNCTION "f00941_report_source_guard"();

COMMIT;
