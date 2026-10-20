-- Run only against the isolated synthetic migration database. The legacy seed
-- intentionally includes a manually uploaded generated report; it must survive
-- the migration without being silently rebound to a different analysis.
DO $tests$
DECLARE
  row_count integer;
  matching_snapshot jsonb;
  mismatch_case record;
BEGIN
  SELECT count(*) INTO row_count FROM "DocumentVersion"
  WHERE "ingestionOrigin" = 'LEGACY_UNKNOWN'
    AND "mimeType" = 'application/pdf'
    AND "originalFilename" IN ('thesis-fixture.pdf', 'turniting_paragraph-technical_fixture.pdf');
  IF row_count <> 2 THEN RAISE EXCEPTION 'Legacy source metadata backfill failed'; END IF;

  SELECT count(*) INTO row_count FROM "AnalysisRun" AS run
  JOIN "DocumentVersion" AS version ON version.id = run."documentVersionId"
  WHERE run."sourceDocumentId" = version."documentId"
    AND run."sourceDocumentVersionId" = version.id;
  IF row_count <> 2 THEN RAISE EXCEPTION 'Legacy run source backfill failed'; END IF;

  SELECT count(*) INTO row_count FROM "ReportArtifact" AS report
  JOIN "AnalysisRun" AS run ON run.id = report."analysisRunId"
  JOIN "DocumentVersion" AS version ON version.id = run."documentVersionId"
  WHERE report."sourceDocumentId" = version."documentId"
    AND report."sourceDocumentVersionId" = version.id
    AND report."sourceChecksum" = version."fileHash"
    AND report."generatedBy" = 'TURNITING'
    AND report.status = 'AVAILABLE'
    AND report."analysisSnapshot" IS NULL;
  IF row_count <> 2 THEN RAISE EXCEPTION 'Legacy report source backfill changed evidence'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ReportArtifact"
    WHERE id = '88888888-8888-4888-8888-888888888888'
      AND "sourceDocumentId" = '22222222-2222-4222-8222-222222222222'
      AND "sourceChecksum" = repeat('b', 64)
      AND "contentHash" = repeat('e', 64)
      AND "storageKey" = 'synthetic-report-nested.pdf'
  ) THEN RAISE EXCEPTION 'Manually uploaded legacy report was rewritten'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "AnalysisRun" WHERE id = '55555555-5555-4555-8555-555555555555'
      AND "documentScore" = 0.434 AND threshold = 0.59
      AND "scoredSegments" = 8 AND "insufficientSegments" = 2
  ) THEN RAISE EXCEPTION 'Persisted analysis values changed during migration'; END IF;

  -- Mutable document display names cannot rename an already bound source.
  UPDATE "Document" SET "originalName" = 'renamed-display.pdf'
  WHERE id = '11111111-1111-4111-8111-111111111111';
  IF NOT EXISTS (
    SELECT 1 FROM "DocumentVersion" WHERE id = '33333333-3333-4333-8333-333333333333'
      AND "originalFilename" = 'thesis-fixture.pdf'
  ) THEN RAISE EXCEPTION 'Source filename followed mutable document display name'; END IF;

  -- Older callers may omit all added fields; triggers derive their exact source.
  INSERT INTO "Document" (id,"originalName","mimeType",size,status,"updatedAt")
  VALUES ('99999999-9999-4999-8999-999999999999','legacy-insert.pdf','application/pdf',10,'EXTRACTED',CURRENT_TIMESTAMP);
  INSERT INTO "DocumentVersion" (id,"documentId","storageKey","fileHash","updatedAt")
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','99999999-9999-4999-8999-999999999999','legacy-insert.pdf',repeat('f',64),CURRENT_TIMESTAMP);
  INSERT INTO "AnalysisRun" (id,"documentVersionId",status,"analyzerMode","analyzerVersion","thresholdProfile")
  VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','PENDING','ENSEMBLE','synthetic-test','BALANCED');
  IF NOT EXISTS (
    SELECT 1 FROM "AnalysisRun" AS run JOIN "DocumentVersion" AS version ON version.id = run."sourceDocumentVersionId"
    WHERE run.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      AND run."sourceDocumentId" = '99999999-9999-4999-8999-999999999999'
      AND version."originalFilename" = 'legacy-insert.pdf'
      AND version."mimeType" = 'application/pdf'
      AND version."ingestionOrigin" = 'LEGACY_UNKNOWN'
  ) THEN RAISE EXCEPTION 'Legacy insert defaults are incompatible'; END IF;

  BEGIN
    INSERT INTO "AnalysisRun" (id,"documentVersionId","sourceDocumentId",status,"analyzerMode","analyzerVersion","thresholdProfile")
    VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','PENDING','ENSEMBLE','synthetic-test','BALANCED');
    RAISE EXCEPTION 'Mismatched run insert was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'ANALYSIS_SOURCE_BINDING_MISMATCH' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "AnalysisRun" SET "documentVersionId" = '44444444-4444-4444-8444-444444444444'
    WHERE id = '55555555-5555-4555-8555-555555555555';
    RAISE EXCEPTION 'Run source rebinding was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'ANALYSIS_SOURCE_BINDING_IMMUTABLE' THEN RAISE; END IF;
  END;

  -- Extraction/status updates remain supported after the source is bound.
  UPDATE "DocumentVersion" SET "extractedText" = 'Synthetic extraction refreshed', "wordCount" = 3
  WHERE id = '33333333-3333-4333-8333-333333333333';
  UPDATE "AnalysisRun" SET "completedAt" = CURRENT_TIMESTAMP
  WHERE id = '55555555-5555-4555-8555-555555555555';
  BEGIN
    UPDATE "DocumentVersion" SET "fileHash" = repeat('0',64)
    WHERE id = '33333333-3333-4333-8333-333333333333';
    RAISE EXCEPTION 'Analyzed source checksum mutation was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'ANALYZED_DOCUMENT_SOURCE_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "DocumentVersion" SET "storageKey" = 'different-source.pdf'
    WHERE id = '33333333-3333-4333-8333-333333333333';
    RAISE EXCEPTION 'Analyzed source storage mutation was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'ANALYZED_DOCUMENT_SOURCE_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "DocumentVersion" SET "originalFilename" = 'different-name.pdf'
    WHERE id = '33333333-3333-4333-8333-333333333333';
    RAISE EXCEPTION 'Analyzed source filename mutation was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'ANALYZED_DOCUMENT_SOURCE_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "DocumentVersion" SET "mimeType" = 'application/octet-stream'
    WHERE id = '33333333-3333-4333-8333-333333333333';
    RAISE EXCEPTION 'Analyzed source MIME mutation was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'ANALYZED_DOCUMENT_SOURCE_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "DocumentVersion" SET "ingestionOrigin" = 'USER_UPLOAD'
    WHERE id = '33333333-3333-4333-8333-333333333333';
    RAISE EXCEPTION 'Analyzed provenance mutation was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'ANALYZED_DOCUMENT_SOURCE_IMMUTABLE' THEN RAISE; END IF;
  END;

  matching_snapshot := jsonb_build_object(
    'version', 'f00941-analysis-source-v1',
    'source', jsonb_build_object(
      'documentId', '11111111-1111-4111-8111-111111111111',
      'documentVersionId', '33333333-3333-4333-8333-333333333333',
      'originalFilename', 'thesis-fixture.pdf',
      'mimeType', 'application/pdf',
      'sourceChecksum', repeat('a',64)
    ),
    'run', jsonb_build_object(
      'id', '55555555-5555-4555-8555-555555555555',
      'globalScore', 0.434,
      'threshold', 0.59,
      'analyzerMode', 'ENSEMBLE',
      'analyzerVersion', 'synthetic-test',
      'thresholdProfile', 'BALANCED',
      'paragraphMode', NULL
    )
  );
  INSERT INTO "ReportArtifact" (id,"documentId","documentVersionId","analysisRunId",type,status,filename,"storageKey",fingerprint,"generationVersion","expiresAt","updatedAt","analysisSnapshot")
  VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','AI_ORIGINAL_REVIEW','GENERATING','original-source.pdf','source-review.pdf',repeat('1',64),'test-renderer',CURRENT_TIMESTAMP + interval '24 hours',CURRENT_TIMESTAMP,matching_snapshot);
  IF NOT EXISTS (
    SELECT 1 FROM "ReportArtifact" WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      AND "sourceDocumentId" = '11111111-1111-4111-8111-111111111111'
      AND "sourceDocumentVersionId" = '33333333-3333-4333-8333-333333333333'
      AND "sourceChecksum" = repeat('a',64)
      AND "generatedBy" = 'TURNITING'
  ) THEN RAISE EXCEPTION 'Legacy report insert defaults are incompatible'; END IF;

  FOR mismatch_case IN
    SELECT * FROM (VALUES
      ('globalScore', ARRAY['run','globalScore'], '0.769'::jsonb),
      ('threshold', ARRAY['run','threshold'], '0.767'::jsonb),
      ('runId', ARRAY['run','id'], '"66666666-6666-4666-8666-666666666666"'::jsonb),
      ('analyzerMode', ARRAY['run','analyzerMode'], '"F006_1_1_ONLY"'::jsonb),
      ('analyzerVersion', ARRAY['run','analyzerVersion'], '"different-version"'::jsonb),
      ('thresholdProfile', ARRAY['run','thresholdProfile'], '"different-profile"'::jsonb),
      ('paragraphMode', ARRAY['run','paragraphMode'], '"different-mode"'::jsonb),
      ('sourceDocumentId', ARRAY['source','documentId'], '"22222222-2222-4222-8222-222222222222"'::jsonb),
      ('sourceDocumentVersionId', ARRAY['source','documentVersionId'], '"44444444-4444-4444-8444-444444444444"'::jsonb),
      ('sourceChecksum', ARRAY['source','sourceChecksum'], to_jsonb(repeat('b',64))),
      ('originalFilename', ARRAY['source','originalFilename'], '"different-source.pdf"'::jsonb),
      ('mimeType', ARRAY['source','mimeType'], '"application/octet-stream"'::jsonb)
    ) AS cases(label, path, value)
  LOOP
    BEGIN
      INSERT INTO "ReportArtifact" (id,"documentId","documentVersionId","analysisRunId",type,status,filename,"storageKey",fingerprint,"generationVersion","expiresAt","updatedAt","analysisSnapshot")
      VALUES ('12121212-1212-4212-8212-121212121212','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','AI_ORIGINAL_REVIEW','GENERATING','mismatched-snapshot.pdf','mismatched-snapshot.pdf',repeat('5',64),'test-renderer',CURRENT_TIMESTAMP + interval '24 hours',CURRENT_TIMESTAMP,jsonb_set(matching_snapshot,mismatch_case.path,mismatch_case.value));
      RAISE EXCEPTION 'Mismatched analysis snapshot was accepted: %', mismatch_case.label;
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM <> 'REPORT_ANALYSIS_SNAPSHOT_MISMATCH' THEN RAISE; END IF;
    END;
  END LOOP;

  BEGIN
    INSERT INTO "ReportArtifact" (id,"documentId","documentVersionId","analysisRunId",type,status,filename,"storageKey",fingerprint,"generationVersion","expiresAt","updatedAt","analysisSnapshot")
    VALUES ('12121212-1212-4212-8212-121212121212','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','AI_ORIGINAL_REVIEW','GENERATING','missing-snapshot-field.pdf','missing-snapshot-field.pdf',repeat('5',64),'test-renderer',CURRENT_TIMESTAMP + interval '24 hours',CURRENT_TIMESTAMP,matching_snapshot #- '{run,threshold}');
    RAISE EXCEPTION 'Missing analysis snapshot threshold was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'REPORT_ANALYSIS_SNAPSHOT_MISMATCH' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO "ReportArtifact" (id,"documentId","documentVersionId","analysisRunId",type,status,filename,"storageKey",fingerprint,"generationVersion","expiresAt","updatedAt")
    VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555','AI_ORIGINAL_REVIEW','GENERATING','wrong-source.pdf','wrong-source.pdf',repeat('2',64),'test-renderer',CURRENT_TIMESTAMP + interval '24 hours',CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Cross-run report source was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'REPORT_ANALYSIS_SOURCE_MISMATCH' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO "ReportArtifact" (id,"documentId","documentVersionId","analysisRunId","sourceChecksum",type,status,filename,"storageKey",fingerprint,"generationVersion","expiresAt","updatedAt")
    VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555',repeat('b',64),'AI_ORIGINAL_REVIEW','GENERATING','wrong-hash.pdf','wrong-hash.pdf',repeat('3',64),'test-renderer',CURRENT_TIMESTAMP + interval '24 hours',CURRENT_TIMESTAMP);
    RAISE EXCEPTION 'Report checksum from another artifact was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'REPORT_SOURCE_BINDING_MISMATCH' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "ReportArtifact" SET "analysisRunId" = '66666666-6666-4666-8666-666666666666'
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    RAISE EXCEPTION 'Report run rebinding was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'REPORT_SOURCE_BINDING_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "ReportArtifact" SET "sourceChecksum" = repeat('b',64)
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    RAISE EXCEPTION 'Report checksum mutation was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'REPORT_SOURCE_BINDING_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE "ReportArtifact" SET "analysisSnapshot" = '{"globalScore":0.769,"threshold":0.767}'::jsonb
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    RAISE EXCEPTION 'Report persisted analysis snapshot mutation was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'REPORT_SOURCE_BINDING_IMMUTABLE' THEN RAISE; END IF;
  END;

  UPDATE "ReportArtifact" SET status = 'AVAILABLE', "contentHash" = repeat('4',64), "sizeBytes" = 2048
  WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  UPDATE "ReportArtifact" SET status = 'DELETED', "deletedAt" = CURRENT_TIMESTAMP
  WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  IF NOT EXISTS (
    SELECT 1 FROM "ReportArtifact" WHERE id = '77777777-7777-4777-8777-777777777777' AND status = 'AVAILABLE'
  ) OR NOT EXISTS (
    SELECT 1 FROM "DocumentVersion" WHERE id = '33333333-3333-4333-8333-333333333333'
  ) OR NOT EXISTS (
    SELECT 1 FROM "AnalysisRun" WHERE id = '55555555-5555-4555-8555-555555555555'
  ) THEN RAISE EXCEPTION 'Independent report lifecycle changed its source or sibling'; END IF;

  BEGIN
    DELETE FROM "AnalysisRun" WHERE id = '55555555-5555-4555-8555-555555555555';
    RAISE EXCEPTION 'Report analysis provenance was deleted independently';
  EXCEPTION WHEN foreign_key_violation THEN
    IF SQLERRM NOT LIKE '%ReportArtifact_analysisRunId_fkey%' THEN RAISE; END IF;
  END;

  -- Keep the existing Document-delete contract: all its records cascade, while
  -- the separately uploaded report-document remains independent and preserved.
  DELETE FROM "Document" WHERE id = '11111111-1111-4111-8111-111111111111';
  IF EXISTS (SELECT 1 FROM "DocumentVersion" WHERE id = '33333333-3333-4333-8333-333333333333')
    OR EXISTS (SELECT 1 FROM "AnalysisRun" WHERE id = '55555555-5555-4555-8555-555555555555')
    OR EXISTS (SELECT 1 FROM "ReportArtifact" WHERE "documentId" = '11111111-1111-4111-8111-111111111111')
    OR NOT EXISTS (SELECT 1 FROM "ReportArtifact" WHERE id = '88888888-8888-4888-8888-888888888888' AND status = 'AVAILABLE')
  THEN RAISE EXCEPTION 'Document cascade or independent uploaded source was broken'; END IF;

  RAISE NOTICE 'F00941_MIGRATION_ASSERTIONS_PASS: backfill, legacy evidence, manual upload, derived defaults, exact bindings, 13 snapshot mismatch rejections and matching snapshot acceptance, immutability, extraction updates, independent report lifecycle, run deletion restriction, document deletion cascade';
END;
$tests$;
