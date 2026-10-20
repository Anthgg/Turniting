# F009.4.1 report source integrity

## Evidence and root cause

The reported nested review was generated for a **different uploaded Document and AnalysisRun**. A read-only local audit found that the earlier technical report's content hash exactly matched the later uploaded DocumentVersion. HTTP logs showed a separate document upload, a separate analysis request, and then report generation. The original source run and the later report-input run used different models and thresholds. All existing report/run/version/document joins were consistent; there were no upload/report storage-key aliases.

This proves report reingestion, but does not prove automatic ingestion or human intent. The audited frontend uploads only a selected native `File` after explicit submission. Preview and download do not invoke document ingestion. The later source was a genuine uploaded DocumentVersion containing report bytes, a workflow the product continues to permit when explicitly requested.

A separate **synthetic injected-boundary reproduction** exposed a real enforcement gap: the renderer accepted free source fields, a caller-provided matching checksum, and technical-report bytes from a mocked document-storage boundary. It then appended those technical pages after a review cover. That reproduction is recorded in `data/eval/F009_4_1_BUG_REPRO.json` with synthetic IDs/checksums and no private document text. It must not be described as proof of automatic ingestion.

The existing recursive legacy report is preserved, including its file, hash, source version, run, and status. It is documented as a legacy report-input case, not silently rebound to the earlier source run. A manually uploaded report must not be rewritten into an ancestor document or assigned the ancestor's score.

## Authority and immutable bindings

`resolveAnalysisSource(run)` is the single source resolver for AI report generation and is reusable by future report families. It returns:

- An explicit `DOCUMENT_VERSION` source discriminant.
- The run's immutable source document and version IDs.
- The version's frozen original filename, MIME type and checksum.
- A document-storage object key, never a report-storage object.

It rejects missing or inconsistent associations. There is no lookup of a latest file, selected preview, downloaded filename, or report history row. An exact `analysisRunId` is required for individual and dual generation.

The additive migration `20261020000000_f00941_report_source_integrity` backfills existing bindings from persisted versions. It aborts on pre-existing contradictory report associations rather than repairing evidence silently. Database triggers:

- Freeze analyzed source identity, storage key, checksum, name, MIME type and ingestion provenance.
- Populate source IDs for older AnalysisService callers without changing inference code.
- Bind each ReportArtifact to its run's exact source document/version/checksum.
- Reject later rebinding of report/run/source/snapshot/type.
- Validate new report snapshots against persisted score, threshold, run/model configuration and source metadata.
- Permit extraction and report lifecycle updates.

New uploads record `USER_UPLOAD`; historical versions remain `LEGACY_UNKNOWN`. Filename patterns are diagnostic hints only. Equal report/source content hashes do not cause a manual upload to be rejected.

`ReportArtifact.type` remains the canonical variant, and `generationVersion` remains the canonical renderer version. API metadata exposes `variant`, `rendererVersion`, `generatedBy=TURNITING`, source IDs, checksum, and the frozen analysis snapshot. Direct deletion of a run referenced by a report is restricted; deleting a parent document still cascades its own versions/runs/reports, as verified in an isolated database.

## Renderer boundary and cache

`OriginalDocumentRenderer.ensure` requires `sourceArtifactType: DOCUMENT_VERSION`. A ReportArtifact or ambiguous untyped source throws `REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE` before cache or storage access.

The review renderer accepts a verified OriginalRenderResult rather than arbitrary PDF bytes. Source identity, source checksum, render checksum, document/version IDs, run-specific layout identity and cached records are checked together. PDF pass-through additionally requires the render checksum to equal the original source checksum. A shared source render in flight obtains the requesting run's own layout map.

The render cache remains keyed by source version/checksum and renderer/extractor versions. It is never keyed by report filename or report ID. Technical reports consume the run's persisted segments and exact source-text offsets; report generation does not reingest, resegment, or run inference.

Both final PDFs carry `Producer/Creator=TURNITING` and PDF Info entries `turniting.generatedBy`, `turniting.reportId`, `turniting.reportVariant`, `turniting.analysisRunId`, `turniting.sourceDocumentId`, `turniting.sourceDocumentVersionId`, and `turniting.rendererVersion`. This metadata complements the database authority; it does not ban explicit manual uploads.

Structured logs include report/variant/run/source IDs and a checksum prefix. Violations emit `report_source_integrity_violation`. Private text and full local paths are not logged.

## Dual delivery and frontend state

`POST /api/documents/:documentId/reports/ai/both` receives one explicit `analysisRunId`, resolves it once and returns `{originalReview, paragraphTechnical}`. Both artifacts use the same source and analysis snapshot; generating PDFs creates no AnalysisRun.

Each card exposes Ver, Descargar and Regenerar. A requested regeneration creates a fresh artifact from the original run and source, retaining earlier metadata. Deletion removes only that report PDF and marks its artifact deleted; regeneration remains available through the product's normal recovery flow. It does not delete the document, version, run, or sibling report.

The report panel is keyed by document/version, locks its initial completed run, and changes it only through explicit user selection. `previewReportId` is distinct from the document route and uploaded File state. History shows variant, source name, score, model, run, creation and expiry; clicking a report name opens its preview. Frontend contracts reject mismatched dual-run/source/score/threshold/model responses.

## Automated verification

Only synthetic documents are used in automated tests. The fixture generator creates an 18-page source with eight long evaluable body segments, two insufficient segments, one metadata segment and one reference segment. Persisted scores exercise four actionable highlights, including equality at threshold 0.59. The global score is supplied as 0.434 and never recomputed by report generation.

Regressions cover explicit run validation, source resolution, rejected ReportArtifact input, mismatched caches/bytes/run/version, equal dual snapshots, source-name stability, available/deleted regeneration, independent deletion, canonical segment preservation, PDF markers, and the technical → original → technical regeneration → original regeneration sequence. Raw PDF content-stream hashes prove all 18 source pages survive after the cover and technical-report pages are absent. Known generated page footers are removed only for contiguous text-extraction assertions across page breaks.

Database regression uses a temporary PostgreSQL 16 container with tmpfs, no host ports and no application volume. It applies all prior migrations, a synthetic legacy seed, the new migration and assertions for backfill, old insert compatibility, snapshot/source violations, lifecycle updates, direct-run restriction and parent cascades. The temporary container is removed after verification.

The guarded browser seed script accepts only the exact synthetic fixture filename/hash, verified upload bytes, 18 digital pages, USER_UPLOAD origin and a prior UI analysis. It creates a separate clearly marked persisted synthetic run for deterministic visual QA; it does not edit inference results, private documents, models or thresholds.

Browser and manual QA evidence is recorded after execution in the local evaluation outputs. Private source documents and their derived PDFs are never committed as fixtures.

## Executed browser smoke (2026-10-20, local Docker)

The complete requested flow ran through the real UI using `thesis-fixture.pdf`: native file upload, extraction, Analyze IA, explicit selection of a separate labelled persisted-score QA run, Generate both, preview and download each PDF, regenerate each available report, delete the regenerated original, download the surviving technical report, regenerate the deleted original, delete the regenerated technical report, and download the surviving original. The deleted technical report was then regenerated too, leaving both variants available. Clicking the source filename in global report history opened only a report preview and retained the history route.

The synthetic document has exactly two runs: the real UI F006.1 run and the explicitly labelled mock-score run. All six generated report rows bind to the latter run, the same uploaded version/checksum and identical frozen snapshots. The two deleted artifact files are absent; all four available files exist and match their recorded content hashes. No report action created an inference run.

`docs/evidence/f00941/browser-network.json` contains only sanitized method/path/status/time records for this synthetic flow. Nginx confirms dual generation `201 x1`, regeneration `201 x4`, deletion `204 x2`, preview `200 x6`, download `200 x4`, no upload/analyze POST during report actions, and no HTTP 4xx/5xx. Browser error console was empty. CDP's bounded event buffer truncated earlier events, so the retained Nginx records are the complete network authority. Two CUA click acknowledgements timed out after successful deletions; fresh UI state, HTTP 204, database audits and absent files confirmed both actions. CDP also reported canceled empty 204 responses; these were not failed application operations.

Before the successful report flow, the first synthetic seed used raw multiline segment hashes. The production integrity guard correctly rejected generation with `ANALYSIS_SEGMENT_TEXT_MISMATCH` (409), before artifact creation. The guarded repair normalized only eight hashes in that exact labelled synthetic run, with zero report artifacts and all scores/model/offsets preserved. Future seeding validates hashes with the production review verifier. No private run was repaired.

Actual UI-downloaded PDFs were inspected and rendered. Review A has 19 pages (cover + all 18 source pages), preserves every original compressed page content stream and contains no technical-report page streams. Technical B has four pages, 12 canonical paragraph cards, the eight body percentages 80/20/61/40/90/10/58/59, and two NO EVALUADO cards. Both have 43.4% / 59.0% covers, TURNITING metadata, distinct report IDs/bytes and matching source/run markers. Images and checksums are in `docs/evidence/f00941/`.

### Existing classifier limitation found during visual QA

The fixture's inline `References: ...` entry is not recognized as a reference-section heading by the existing presentation classifier. Therefore browser output has four body highlights plus that reference candidate (five visual highlights total); the metadata candidate is correctly excluded. The raw threshold count is six. No inference, classification, span or segmentation code was changed in this phase. Renderer tests with explicit persisted presentation exclusions separately verify that excluded entries are not highlighted. This difference is recorded as `REFERENCE_INLINE_HEADING_NOT_CLASSIFIED`, rather than claiming four total browser highlights. Future seed output calculates the actual presentation counts and labels the expected count as body-only.

## Manual source-document QA

The existing local `TESIS EC.pdf` was used only for manual UI QA after synthetic tests. The report selector explicitly chose original run `950d39fb-237c-45a7-ad53-ac7a5ab44920`; Analyze IA was not invoked. Both previews and downloads displayed TESIS EC.pdf, 43.4%, threshold 59.0%, ENSEMBLE_V2_V3 and the same source version. The new review has 19 pages; the technical detail has 91 pages because it presents all 526 already-persisted segments. That technical page count does not become the source page count of the review. Private PDFs remain outside the repository.

The legacy nested artifact remains AVAILABLE with its original timestamp, null legacy snapshot, source/run associations and unchanged actual SHA256. Its source upload and the original thesis source also retain their original hashes. Concurrent user-created runs/reports observed in the local application were preserved.

## Verification results

- Frontend: 11 files / 51 tests passed; TypeScript/build/lint passed.
- Backend: final full suite 20 files / 169 tests passed; separate e2e 4 files / 33 tests passed. The exact-five regression and real Poppler/LibreOffice tests ran in Docker, with no renderer skips.
- AI service: 73 passed / 1 skipped; Ruff passed; no AI-service code changed.
- Database: all historical migrations, synthetic legacy seed, new additive migration and source/snapshot/lifecycle assertions passed in isolated PostgreSQL 16; temporary containers removed.
- Existing lint advisories remain: frontend AnalysisPanel set-state-in-effect, backend extraction control-character regex; Vite reports a chunk-size advisory.
- No PR or merge is part of this phase. The authorized feature branch is committed and pushed after final verification.
