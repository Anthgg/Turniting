-- Synthetic pre-F009.4.1 records only. Apply after all historical migrations and
-- before the F009.4.1 migration in an empty, isolated test database.
INSERT INTO "Document" (id,"originalName","mimeType",size,status,"updatedAt") VALUES
('11111111-1111-4111-8111-111111111111','thesis-fixture.pdf','application/pdf',1800,'EXTRACTED',CURRENT_TIMESTAMP),
('22222222-2222-4222-8222-222222222222','turniting_paragraph-technical_fixture.pdf','application/pdf',9100,'EXTRACTED',CURRENT_TIMESTAMP);

INSERT INTO "DocumentVersion" (id,"documentId","storageKey","fileHash","pageCount","updatedAt") VALUES
('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','synthetic-upload-source.pdf',repeat('a',64),18,CURRENT_TIMESTAMP),
('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222','synthetic-upload-report.pdf',repeat('b',64),91,CURRENT_TIMESTAMP);

INSERT INTO "AnalysisRun" (id,"documentVersionId",status,"analyzerMode","analyzerVersion","thresholdProfile",threshold,"documentScore","scoredSegments","insufficientSegments") VALUES
('55555555-5555-4555-8555-555555555555','33333333-3333-4333-8333-333333333333','COMPLETED','ENSEMBLE','synthetic-test','BALANCED',0.59,0.434,8,2),
('66666666-6666-4666-8666-666666666666','44444444-4444-4444-8444-444444444444','COMPLETED','F006_1_1_ONLY','synthetic-test','BALANCED',0.767,0.769,8,2);

INSERT INTO "ReportArtifact" (id,"documentId","documentVersionId","analysisRunId",type,status,filename,"storageKey",fingerprint,"contentHash","generationVersion","expiresAt","updatedAt") VALUES
('77777777-7777-4777-8777-777777777777','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','AI_PARAGRAPH_TECHNICAL','AVAILABLE','turniting_paragraph-technical_fixture.pdf','synthetic-report-technical.pdf',repeat('c',64),repeat('b',64),'legacy-renderer',CURRENT_TIMESTAMP + interval '24 hours',CURRENT_TIMESTAMP),
('88888888-8888-4888-8888-888888888888','22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444','66666666-6666-4666-8666-666666666666','AI_ORIGINAL_REVIEW','AVAILABLE','turniting_original-review_fixture.pdf','synthetic-report-nested.pdf',repeat('d',64),repeat('e',64),'legacy-renderer',CURRENT_TIMESTAMP + interval '24 hours',CURRENT_TIMESTAMP);
