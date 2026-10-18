# F009.3 — Threshold review and span-ready evidence

## Review rule

The persisted `AnalysisRun.threshold` is the only actionability boundary for a completed run. A scored segment is flagged when `calibratedScore >= threshold`; a score below the threshold stays unflagged. A segment is evaluable when it has a finite score and is not `INSUFFICIENT_TEXT`. Scores, model output, and document aggregation are not changed by this presentation rule.

The run list reports `evaluatedSegments` and `flaggedSegments`. The flagged count follows the threshold rule, while `presentationExcluded` independently prevents metadata, captions, headings, and references from receiving an actionable highlight. Review navigation includes only flagged segments that are not presentation-excluded.

## Evidence contract

The API returns optional `segment.evidence` for compatibility with older clients and runs:

```ts
interface ReviewEvidence {
  evaluated: boolean;
  flagged: boolean;
  score: number | null;
  threshold: number | null;
  presentationExcluded: boolean;
  excludedReason?: string;
  granularity: "PARAGRAPH" | "SPAN";
  paragraphFlagged: boolean;
  spans: Array<{
    startChar: number;
    endChar: number;
    confidence?: number;
    label?: string;
  }>;
  fallbackReason?: "SPAN_EVIDENCE_UNAVAILABLE";
}
```

Current persisted runs use `granularity: "PARAGRAPH"` and `spans: []`. Older records without evidence use the same paragraph fallback. No database migration or model integration is part of F009.3. Future spans are end-exclusive offsets relative to the original target paragraph and use JavaScript UTF-16 units. Python codepoint spans are normalized at the backend boundary before they reach the API. UI and PDF rendering translate relative offsets with `paragraph.charStart + span.startChar`, validate ranges, merge overlaps for display only, and preserve source text exactly. A flagged `SPAN` result without ranges falls back to the paragraph and carries `SPAN_EVIDENCE_UNAVAILABLE`; it does not invent a span.

Capabilities currently report `spanEvidenceSupported: false`, `spanEvidenceGranularity: "PARAGRAPH"`, and `{ paragraphHighlighting: true, spanHighlighting: false }`.

## User-facing behavior

- The Summary shows evaluated and threshold-flagged counts.
- Review uses one highlight style and has previous/next navigation through actionable flagged paragraphs.
- Opening a flagged paragraph shows its score, threshold, model, token counts, mode, and status.
- The standard AI PDF contains a clean cover followed by the complete document. Only actionable threshold flags are highlighted. It omits paragraph scores, paragraph identifiers, token counts, model internals, run/profile/aggregation/cache/renderer details, and the technical paragraph appendix.
- AI report fingerprint version: `f0093-threshold-span-ready-renderer-v4`. Similarity retains `f0092-report-renderer-v3.1`.
- Version comparison keeps the existing alignment and adds threshold-flag counts and aligned changes. Paragraph indices alone are not used to match versions.

## Scope boundaries

No model training, model score, threshold selection, F006.1.2 integration, F008 behavior, similarity behavior, database schema, or production data is changed by this phase. Browser/PDF smoke inputs must be synthetic, and any cleanup of earlier local temp files remains manual when the existing deletion policy blocks removal.

## Validation record

Validation completed on 2026-10-18:

- Backend: 137 tests passed across 16 files; build passed; lint exited 0 with the existing `no-control-regex` warning in `documents.service.ts`.
- Frontend: 37 tests passed across 8 files; production build and lint passed. Vite reported the existing large JavaScript chunk warning (~550 KB).
- AI service: 70 tests passed and 1 was skipped.
- `docker compose build --no-cache` and `docker compose up -d` completed. `turniting-ai`, `turniting-backend`, `turniting-db`, and `turniting-frontend` were healthy. Backend, AI health, and AI connectivity endpoints returned HTTP 200.
- Browser smoke used the synthetic file `turniting-f0093-synthetic-browser-smoke-20261018.txt`. Its completed run used threshold `0.59`, evaluated 5 paragraphs, flagged 1, and showed score `0.88` / threshold `0.59` in paragraph details. Review navigation, details, report generation, and the PDF download action were exercised.
- The generated AI report was downloaded from the local report endpoint and visually inspected as a two-page PDF (4,659 bytes). The cover contains the global score, applied threshold, generation date, flagged/evaluated counts, and notice. “Documento para revisión” contains the full document with one threshold highlight and no paragraph scores, IDs, token counts, model internals, or renderer metadata.
- The smoke document includes `😀`. The browser review preserves it, but PDFKit's built-in Helvetica font renders that supplementary-plane symbol as incorrect fallback glyphs in the PDF. The rest of the reviewed Spanish and document text rendered correctly. This smoke does not claim supplementary-plane glyph fidelity in PDF output.
- `git diff --check` passed. No database schema or migration files changed.

Next step: `WAIT_FOR_F006_1_2_THEN_LOCAL_SPAN_MODEL_INTEGRATION`.
