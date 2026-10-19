# F009.4: original-document fidelity and dual AI reports

## Scope

F009.4 adds two independently stored PDF artifacts for one completed `AnalysisRun`:

- `AI_ORIGINAL_REVIEW` keeps the input pages in their original page order and adds a Turniting cover. It places a translucent highlight only when a flagged paragraph maps to source text with a complete, ordered token match.
- `AI_PARAGRAPH_TECHNICAL` provides the technical summary and every paragraph's local score, persisted threshold, state, presentation exclusion reason, and complete paragraph text.

The pre-existing `AI_REPORT` variant remains supported for older artifacts and clients. All report variants read the same persisted run. They do not run analysis, change scores, change the document score, or modify the document version.

## Source of truth and threshold behavior

The global estimate is `AnalysisRun.documentScore`. The local paragraph score is `AnalysisSegment.calibratedScore`. `AnalysisRun.threshold` is persisted with the run and is the threshold used by both new reports. A paragraph is marked `SEÑALADO` when its local score is greater than or equal to that threshold. A null score is `NO EVALUADO`; it is never converted to zero. The technical report describes local scores as detector estimates, not arithmetic contributions to the global score.

Presentation exclusions retain their score and run data. The technical report lists the exclusion reason. The original-review report does not highlight references or other excluded presentation material. These display rules do not change the analysis or score.

## Original source rendering and mapping

PDF input is loaded directly from its versioned storage key and passed to the renderer without OCR or page rasterization. The renderer adds a cover page and overlays vector rectangles on original pages. PDF page rotation, crop-box origin, and page dimensions are used when mapping text coordinates.

DOCX input is converted locally with headless LibreOffice Writer in an isolated temporary directory. The backend image installs LibreOffice, Poppler `pdftotext`, and compatible fonts. The DOCX is never rewritten. Poppler extracts page, line, and word boxes from the rendered PDF; OCR is not invoked.

Mapping uses ordered, exact normalized token matching against the persisted paragraph text. It handles Unicode NFC normalization, soft hyphens, and common line-break hyphenation. The gate is `mappingCoverage >= 0.95` and `mappingConfidence >= 0.98`. Confidence is conservatively `1` only when every normalized token matches in order and `0` otherwise; with this exact matcher, the confidence gate therefore requires complete coverage. This favors leaving a flagged paragraph unhighlighted over placing an inaccurate overlay. If mapping is incomplete, ambiguous, or missing, the report keeps the original page unchanged and records `FLAGGED_NOT_VISUALLY_LOCATED` in the internal layout map. It does not guess coordinates, and the paragraph's score is unchanged. The map stores token hashes and geometry rather than extracted source text.

## Storage, retention, and privacy

Each report variant has its own report ID, PDF storage key, fingerprint, generation state, deletion, expiry, and regeneration. The source render and layout map have separate cache records tied to the document version, source checksum, renderer, and extraction versions. The existing 24-hour report retention is applied to reports, converted originals, and layout maps. Cleanup runs at startup and hourly; expired layout JSON is cleared after expiry. Deleting one report does not delete the other variant or the underlying analysis run.

Storage keys and local filesystem paths remain internal. Report metadata exposes IDs, variant/renderer labels, expiry, and preview/download availability only. The preview route returns an available PDF inline and does not count a preview as a download.

## UI

The document export panel shows distinct original-review and technical-report sections, each with separate generate/regenerate, preview, and download actions. The report history has separate filters and labels for both variants. `Ver PDF` opens the selected artifact in the report detail panel's embedded PDF viewer; `Descargar` remains a separate action. Existing legacy AI and similarity history remain available.

## Tests and synthetic fixture

`backend/test/fixtures/reports/original-fidelity/f0094-layout-fixture.docx` is generated sample content only. It includes two pages, title and heading styles, a header and synthetic logo, a page-number footer, bold/italic and superscript/subscript runs, an equation, a bordered table, a list, a page break, and a reference. Its layout tests are skipped when LibreOffice or Poppler are unavailable; they run in the backend container.

Relevant local checks:

```powershell
cd backend
npm test -- src/reports/report.service.spec.ts src/reports/report-renderer.spec.ts src/reports/report-cleanup.spec.ts src/reports/original-document-renderer.spec.ts
cd ../frontend
npm test -- src/features/documents/ReportExportPanel.test.tsx src/features/reports/ReportsPage.test.tsx src/features/reports/ReportDetailPanel.test.tsx
```

## Limits and follow-up

- DOCX-to-PDF conversion is a high-fidelity local conversion, not a byte-identical copy of a Microsoft Word render. Installed fonts and LibreOffice version are part of the renderer version and cache key.
- Editing a PDF to add a cover and highlights requires saving a new PDF. Content streams and vector text are retained, but signatures and unsupported interactive PDF features should not be considered preserved.
- Scanned/image-only PDFs remain visually intact, but no OCR means their text cannot receive coordinate highlights. The technical report still contains the paragraph text from the persisted analysis when available.
- Mapping is paragraph-level. Span-level overlays remain future work and must retain the same confidence gates and source-offset integrity checks.
- Unsupported source formats cannot produce `AI_ORIGINAL_REVIEW`; the existing technical report is still generated from the persisted analysis.
