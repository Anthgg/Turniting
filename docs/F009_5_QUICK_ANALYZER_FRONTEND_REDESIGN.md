# F009.5 — Quick text analyzer and frontend redesign

## Scope

This phase adds a quick, temporary text analysis flow and reorganizes the existing frontend around the user’s main tasks. The initial route and interface audit is recorded in [F009_5_FRONTEND_AUDIT.md](./F009_5_FRONTEND_AUDIT.md).

The change preserves the existing document analysis and review, both report libraries, version comparison, model catalog, and dataset catalog. It does not change training, model weights, calibration, datasets, research scores, scientific thresholds, or holdout handling.

## Navigation and page hierarchy

The workspace uses grouped navigation for **Inicio**, **Analizar**, **Resultados**, and **Configuración**. On desktop the sidebar can collapse to an icon rail; at tablet widths it becomes a compact rail; on mobile it opens as a drawer with Escape dismissal, focus containment, focus return, and a backdrop.

The home page puts document analysis and quick text analysis first, followed by recent documents. Service health and the project phase footer live on the technical status page. Existing routes remain reachable:

| Route | Purpose |
| --- | --- |
| `/` | Main actions and recent documents |
| `/documents` | Upload and document library |
| `/analysis/quick` | Temporary pasted-text analysis |
| `/documents/:id` | Document review and existing analysis controls |
| `/reports` | Turniting-generated report library |
| `/history` | Analysis run history |
| `/turnitin-reports` and `/turnitin-reports/:id` | Imported Turnitin reports |
| `/analysis/compare` | Compare document analyses |
| `/models` | Model catalog and technical model information |
| `/datasets` and `/datasets/:id` | Dataset catalog and detail |
| `/settings` | Local service status |

The legacy paths `/settings/system` and `/settings/models` redirect to `/settings` and `/models`, respectively.

## Quick text flow

The page keeps input only in component memory. It does not autosave, create a document, create a report, or add a history entry. The user starts one inference with the button or Ctrl/Cmd+Enter; typing does not call the analyzer. Clearing the input also clears the result. Input is limited to 20,000 characters as counted by JavaScript `String.length`, with a live word and character count, loading state, and scoped error messages.

The browser sends `{ text }` to `POST /api/analysis/quick`. The backend resolves the configured preferred local analyzer and invokes the existing paragraph inference service in `BALANCED` and `STRICT_PARAGRAPH` modes. The response includes the aggregate evaluator score and its scientific/review flags, thresholds and model/language/latency metadata, plus per-paragraph status, calibrated score, scientific flag, and review-highlight flag. It does not return the input, its hash, or character offsets. No document, analysis-run, segment, report-artifact, or comparison writes are performed by this endpoint.

Insufficient paragraphs have `score: null`, `scientificFlag: null`, and render as **No evaluado**. The scientific flag follows the configured scientific decision. Visual review highlighting uses the existing `REVIEW_HIGHLIGHT_THRESHOLD` and a strict `score > threshold` comparison; the default 20% review threshold remains separate from the scientific threshold. The interface explains both signals and puts model/version, language, and latency in expandable analysis details. There is no user-facing model selector.

## Responsive and accessibility behavior

Document review now uses a split workspace on desktop: the text and highlighted paragraphs remain in the main column while the selected paragraph's signal, review state, global signal, and highlight count stay in a contextual panel. On narrow screens that context collapses into a bottom sheet; selecting a highlighted paragraph or moving between highlights opens it, and Escape closes it. Analyzer version, threshold profile, calibration labels, run/document/segment IDs, and related diagnostics remain under collapsed technical details.

- Desktop: compact, grouped, collapsible navigation with text labels and tooltips in the collapsed rail.
- Tablet: persistent icon rail to preserve page width.
- Mobile: drawer with labelled toggle, modal semantics, backdrop, Escape close, focus trap, and focus return; the underlying page is inert while open.
- Pages: flexible content widths, stacked quick-analysis cards on narrow screens, visible focus indicators, reduced-motion support, labelled text input, live loading status, and `No evaluado` rather than a fabricated zero.
- Review: desktop split context panel and a collapsible mobile bottom sheet, with keyboard dismissal and technical diagnostics behind disclosure.

## Verification record

This section is updated after integrated verification. Test text and result fixtures are synthetic. No private document contents or screenshots are committed.

| Check | Result |
| --- | --- |
| Quick analyzer frontend tests | PASS: synthetic QuickAnalysisPage and helper tests included in the full suite. |
| Frontend suite | PASS: 17 files / 91 tests. Vitest required `TEMP`/`TMP` to point inside the workspace because the sandbox denied writes to the default Windows temp directory. |
| Frontend production build | PASS: TypeScript and Vite build; 209 modules. Output: CSS 92.73 kB and JS 606.78 kB (169.22 kB gzip). Vite reports the JS chunk exceeds 500 kB. |
| Frontend lint | PASS with one existing warning: `AnalysisPanel.tsx:155` (`react(set-state-in-effect)`). |
| Backend quick-analysis unit tests | PASS: 5/5 focused tests. |
| Backend suite and E2E route check | PASS: unit suite 272 passed / 13 skipped (25 files); E2E 35/35 across 4 files; Nest build succeeds. Lint exits 0 with one existing warning in `documents.service.ts:765`. |
| AI service tests | Not rerun in F009.5 because no AI-service code changed. The recorded F009.4.3 result is 73 passed / 1 skipped and Ruff passes; a separate F009.5 attempt stalled at `tests/test_analyze.py::test_analyze_test_returns_text_metrics` and was interrupted. |
| Runtime quick-analysis smoke | PASS earlier with two synthetic paragraphs only: global score 94.7%, AI signal, review suggested above 20%, paragraph scores 99.3% and 86.7%; model `F006.1 Experimental`, version `F006_1_SPANISH_GENERALIZATION_EXPERIMENTAL`, language `OTHER`. Nest to local AI service returned a response and did not create Documents, AnalysisRuns, or ReportArtifacts; database counts were unchanged at 88 / 119 / 173. Cold request: 58,723 ms; warm request: 1,259 ms. The submitted phrase was absent from inspected AI-service logs; this does not cover external infrastructure/proxy telemetry. |
| Responsive browser review | PARTIAL: the earlier six viewport and mobile-drawer review predates the final Review context-panel adjustment. Post-adjustment visual verification is blocked because Docker Desktop's Linux engine is unavailable (`dockerDesktopLinuxEngine` pipe not found), and local app URLs refuse connections. No post-adjustment browser PASS is claimed. |
| Git / branch / push | PASS: implementation commit `7e58c5f` pushed to `origin/feat/f009-5-quick-analyzer-frontend-redesign`. No PR or merge. |

## Final Review-context presentation

The final revision places paragraph review content and context side by side on desktop. The contextual panel reports the global signal and highlight count plus the selected paragraph's signal, detector state, and review state. On mobile it becomes a collapsible bottom sheet. Technical IDs, analyzer version, threshold profile, calibration details, and related metadata are available in a closed-by-default disclosure. Structural tests and TypeScript checks pass; visual behavior at the final breakpoint layout was not rechecked in a live browser because the local runtime was unavailable.
