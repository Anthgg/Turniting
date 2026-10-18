# F009.2 — AI document review highlights

## Purpose

F009.2 adds a readable review copy of the analyzed document to the AI report PDF and the Analysis screen. The copy answers where a reader may want to review wording; it does not provide rewriting or detector-evasion advice.

## Paragraph-level limitation

The current `ENSEMBLE_V2_V3` pipeline stores evidence by paragraph. The review copy therefore highlights complete paragraphs. It does not claim word-level or sentence-level detection. The evidence contract reserves `SPAN` with explicit offsets for a future analyzer that can supply verified spans; current runs always emit `PARAGRAPH` evidence.

## Shared presentation policy

`getReviewPresentation(segment, documentContext)` is the single presentation policy used by the analysis API and AI report renderer. It reads the persisted `signalLevel` and returns a highlight decision, level, and optional exclusion reason. It does not recalculate a score or threshold.

| Presentation | Review copy |
| --- | --- |
| HIGH | Soft teal background (`#DCEDEA`) and a discreet score label |
| MODERATE | Softer warm background (`#F3F1E8`) and a discreet score label |
| LOW | Plain text; no score label |
| INSUFFICIENT_TEXT | Plain text; no score label |

Recognized cover metadata, author and contact fields, short insufficient headings, figure/table captions, and text from a confidently recognized references heading remain visible without actionable highlights. Reference and metadata exclusions affect only presentation; stored paragraph scores, distribution, and `AnalysisRun` remain unchanged.

## PDF review copy

The `Documento para revisión` section appears after the summary and distribution, before `Detalle por párrafo`. It uses the full `DocumentVersion.extractedText` and persisted segment offsets, hashes, and end-exclusive ranges. A hash or offset mismatch returns a clear conflict and prevents PDF generation. Paragraphs render in character-offset order, with source gaps retained. Page-crossing highlights continue line by line; long paragraphs may split, while short paragraphs and headings are kept together where space permits.

The legend explains the high, moderate, and unhighlighted levels. A compact signal index lists counts and at most twenty paragraph identifiers per level. The document copy retains the original text, including references, while marking the reference section as outside the writing-review highlights. Existing summary, technical detail, history, methodology, limitations, and footer remain in the report.

## Analysis UI

Completed analyses expose `Resumen`, `Revisión`, and `Detalle` tabs within the existing Analysis screen. The review tab requests the full extracted text and all verified segments, then renders in `charStart` order with the same server-provided presentation decisions as the PDF. High and moderate paragraphs open a detail drawer with paragraph, score, level, token and word counts, model, mode, and contextual token counts when available. The heatmap and detail rows navigate to the matching review paragraph.

If the stored document hash or segment offsets do not match, the review endpoint returns a conflict; the UI does not show stale review highlights.

## Renderer, fingerprint, and retention

The AI renderer version is `f0092-report-renderer-v3.1`. Its version participates in the artifact fingerprint, so F009.2 PDFs are distinct from earlier renderer artifacts. The `.1` revision keeps section headings with the following review text when a page break is near. Existing 24-hour retention and report-history behavior are unchanged. Similarity reports and F008 are outside this phase.

## Scope boundaries

F009.2 does not change the model, thresholds, calibration, training data, `AnalysisRun`, persisted scores, or F008 behavior. Private documents are not used in automated tests; QA uses synthetic text only.

## Local temporary files

Older blocked temporary files are not removed by this phase. Their host cleanup remains `MANUAL_LOCAL_CLEANUP_REQUIRED`. Tests and synthetic QA must leave no new temporary files behind.
