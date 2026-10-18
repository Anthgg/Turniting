# F009.0 — Report framework

F009.0 adds two separate PDF types. The AI report is generated from a completed, persisted `AnalysisRun`. The similarity renderer accepts a typed `SimilarityReportInput` contract and is exercised only with synthetic fixtures until F008 supplies a persisted `SimilarityRun` and its final pipeline fields.

## Architecture

- `ReportService` validates run/document context, fingerprints the inputs, reuses a live artifact, and manages the report lifecycle.
- `ReportRenderer` builds independent AI and similarity PDFs with PDFKit. PDFKit writes readable Node streams and draws charts with vector shapes; this keeps Chromium and a browser runtime out of the backend image.
- `ReportStorageAdapter` is the storage boundary. `LocalReportStorage` accepts only backend-generated UUID PDF keys and stores files outside the repository. A cloud adapter is a future implementation and is not included here.
- `ReportCleanup` runs once at startup and every hour. It removes expired report files and marks their metadata `EXPIRED`; it never removes analysis data.
- `ReportArtifact` and `ReportAuditEvent` retain lifecycle metadata and audit events in PostgreSQL. Report audit records contain no document text.

The renderer version is included in the SHA-256 fingerprint with the document version, run ID, report type, and a hash of the relevant run data. The storage path is not part of the fingerprint or API response.

## Reports

### AI report

`AI_REPORT` includes document and run provenance, global score and level, analyzer and model versions, profile, paragraph mode, threshold, aggregation, counts, inference duration, cache state, a distribution by signal level, paragraph excerpts, contextual token counts where available, up to seven prior completed runs, methodology, model-specific limitations, and the independent AI disclaimer.

Paragraph excerpts are materialized from `DocumentVersion.extractedText` using the offsets stored on `AnalysisSegment`. The service rejects a run when its text hash no longer matches the stored version. Contextual reports include token counts only; neighboring paragraph text is not rendered.

### Similarity report

`SIMILARITY_REPORT` takes its `similarityScore`, `matchedCoverage`, token counts, sources, matches, match types, exclusions, and limitations from `SimilarityReportInput`. The renderer does not infer global similarity from cosine scores. Fixtures under `backend/test/fixtures/reports/similarity/` are synthetic and are not database runs.

There is currently no `SimilarityRun` model. The similarity generation endpoint returns HTTP 409 with `SIMILARITY_RUN_UNAVAILABLE` and a user-facing explanation until a persisted F008 run and its pipeline contract are available. The UI keeps similarity export disabled in that state.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/api/documents/:documentId/reports/ai` | Body `{ "analysisRunId": "<uuid>" }`; accepts only a completed run linked to the document and version. Returns metadata in `GENERATING` or `AVAILABLE` state. |
| `POST` | `/api/documents/:documentId/reports/similarity` | Body `{ "similarityRunId": "<uuid>" }`; returns HTTP 409 `SIMILARITY_RUN_UNAVAILABLE` until F008 persists a compatible run. No result payload is accepted. |
| `GET` | `/api/documents/:documentId/reports` | Lists report metadata for the document. |
| `GET` | `/api/reports/:reportId` | Returns lifecycle metadata. |
| `GET` | `/api/reports/:reportId/download` | Streams an available PDF and records a download audit event. |
| `DELETE` | `/api/reports/:reportId` | Deletes only the PDF object and marks the artifact `DELETED`. |

Responses expose report IDs, type, status, generated filename, content hash, timestamps, and (while available) the download endpoint. They never expose a local path, volume path, or storage key. Downloads and deletes accept only UUID report IDs.

## Retention and regeneration

`REPORT_RETENTION_HOURS` is fixed at 24 for this phase. `generatedAt` and `expiresAt` are recorded for each artifact, with the latter exactly 24 hours after generation. The hourly cleanup selects rows with `expiresAt <= now` and `deletedAt IS NULL`, removes the file if present, then atomically writes `EXPIRED`, `deletedAt`, and `REPORT_EXPIRED` audit metadata. A missing file is treated as already removed, so retries are idempotent.

Expired and manually deleted artifacts keep their metadata and audit history. The associated `AnalysisRun`, scores, segments, offsets, sources, and document version are untouched by report cleanup. A later generation creates a new artifact ID, timestamp, expiry, and content hash; it does not revive the old row. A live fingerprint is unique, which prevents repeated clicks from creating duplicate PDFs.

## Storage and PDF engine

Set `REPORT_STORAGE_ROOT` to choose the local storage directory. Docker uses `/data/reports` on the named `turniting_reports` volume. Outside Docker the default is a directory in the operating-system temporary area, not the repository. The adapter validates a UUID-only `.pdf` key, rejects traversal, creates files exclusively with restrictive permissions, and verifies resolved read paths stay under the configured root.

PDFKit uses built-in Helvetica faces and vector elements. It adds no browser binary or Python runtime to the backend. `ReportBundleManifest` records a future-compatible shape only; ZIP export and QR verification are not implemented.

## Disclaimers

The AI report includes:

> Turniting proporciona una estimación probabilística independiente. No es un reporte oficial de Turnitin y no constituye por sí solo prueba de autoría o uso de inteligencia artificial.

The similarity report includes:

> Turniting compara el documento contra las fuentes disponibles en su corpus e índices configurados. La ausencia de una coincidencia no demuestra originalidad absoluta y el porcentaje no equivale al índice de similitud oficial de Turnitin.
