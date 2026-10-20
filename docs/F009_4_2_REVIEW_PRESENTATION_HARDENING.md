# F009.4.2 — Review presentation hardening

## Scope and authority

Base: `feat/f009-4-1-report-source-integrity`, commit `106df73e31428605821fb6b2151282ad41d86c96`. This phase changes presentation of existing analysis results. The persisted `AnalysisRun`, its `AnalysisSegment` rows and model results remain authoritative.

The transform is `AnalysisRun → verified persisted segments → presentation classification/grouping → PDF or web detail`. It does not invoke extraction, OCR, segmentation or inference. It does not write groups to the database, modify segment offsets or text hashes, replace scientific classifications, recalculate global scores or average local scores. The existing source resolver, version/checksum locks, report snapshots and original-page integrity checks remain in force.

New report renderer versions are:

- `f00942-original-review-renderer-v2`.
- `f00942-paragraph-technical-renderer-v2`.

Existing PDF bytes remain available under their existing report IDs. New generation or explicit regeneration uses the current renderer and the selected run's unchanged analysis values. No historical report is rewritten or rebound.

## Reference classifier

`detectReferenceSectionStart(text, context)` is the shared central helper in `backend/src/analysis/review-presentation.ts`. It normalizes Unicode NFC, trims and collapses whitespace, and compares heading syntax without case sensitivity. Matching is anchored at the beginning of the segment; the classifier does not search arbitrary prose for the word “referencias”.

Accepted aliases include `Referencias`, `Referencias bibliográficas`, `Bibliografía`, `References` and `Bibliography`, with or without a final colon. Existing compatible aliases such as `Works cited`, `Literature cited` and `Literatura citada` remain supported. Arabic section numbers and valid Roman section numbers are accepted, including `5. Referencias`, `6 REFERENCIAS` and `VI. Referencias`.

An exact heading followed by a colon also starts the section when content follows in the same segment: `References: Smith et al…`, `Referencias: Pérez et al…` or `Bibliografía: García…`. A separate heading line followed by content is accepted when a validated heading-like structural hint confirms the formatting. The classifier returns a rule (`EXACT_HEADING`, `INLINE_COLON`, `NUMBERED_HEADING` or `HEADING_LINE`), whether it is inline and whether it is numbered; it does not log the bibliographic content.

Normal prose remains body text, including “Las referencias utilizadas…”, “Las referencias [1] y [2] muestran…”, “Estas referencias permiten…” and “La bibliografía analizada demuestra…”. A leading heading alias must be the complete heading or be immediately followed by the heading colon. Additional prose without that boundary does not qualify.

Once a reference section starts, subsequent persisted segments remain `REFERENCE_SECTION` until the end of the document or an explicit annex transition. Accepted exits include standalone/numbered `ANEXO`, `ANEXOS`, `APPENDIX`, `APPENDICES` and supported Spanish apéndice forms, optionally with a clear identifier or colon. A prose sentence about appendices does not exit the section. The annex heading is structural; subsequent annex body text may be actionable under the usual threshold rules. A later explicit reference heading may open another reference section.

## Exclusion and counts

`presentationExcluded` is a display policy, independent of the scientific score and flagged state. A reference with a real score above the run threshold retains its exact score, evaluated status and `SEÑALADO` state. It is marked `EXCLUIDO DE REVISIÓN VISUAL · REFERENCE_SECTION` and has no original-review highlight. It is never changed to an insufficient or null-score result.

The original review retains its overall design: one Turniting cover followed by the original source pages and actionable highlights. Cover and web review distinguish:

- **Señalados por detector / Superan el umbral:** evaluated segments meeting the persisted run threshold.
- **Resaltados para revisión / Mostrados en revisión:** those flagged segments after presentation exclusions.
- **Señalados excluidos:** the difference, with the original scientific scores still available in technical detail.

Navigation through previous/next flagged items uses actionable review indices and skips excluded reference/metadata items. The dedicated regression fixture has six raw flagged segments, two presentation-excluded flagged segments and four actionable body highlights. These are fixture expectations, not claims about every document.

## AnalysisSegment and TechnicalDisplayUnit

An `AnalysisSegment` is a persisted scientific unit. A `TechnicalDisplayUnit` is a temporary visual container and has no aggregate score. The display types are `EVALUATED_SEGMENT`, `INSUFFICIENT_SEGMENT`, `STRUCTURAL_GROUP`, `REFERENCE_GROUP`, `TABLE_GROUP`, `METADATA_GROUP`, `CAPTION_GROUP` and `HEADING_GROUP`.

Each display unit keeps `sourceSegmentIds`, the original zero-based persisted paragraph indices, as well as its source members and original start/end positions. Evaluated-member annotations in the web response also expose their persisted database ID when available. PDF source labels are one-based for reading. No new paragraph indices or scientific segments are created. The label `PÁRRAFO` is reserved for a validated explicit `kind: PARAGRAPH`; otherwise evaluated cards say `SEGMENTO`.

The shared helper `buildTechnicalDisplayUnits` validates unique segment indices, ordered non-overlapping offsets and source bounds before grouping. It constructs new arrays/containers and retains the original members. The audit reports every source segment represented once, lost segments and duplicates. A mixed structural group still lists every evaluated member separately with its original local percentage, threshold and flagged state. There is no average, minimum, maximum, weighted or synthetic score for the group.

## Conservative grouping

Grouping uses only persisted segment text/offsets and presentation classification. Consecutive members can join when their offsets are ordered, the gap is whitespace only and at most 32 UTF-16 code units, their structural group identity is compatible and their categories/exclusion reasons agree. It does not combine across a body evaluated segment.

- **References:** consecutive reference fragments form compact textual blocks, including across source pages. Evaluated references retain explicit internal-score annotations. Insufficient references use a compact count instead of one full “NO EVALUADO” card per fragment.
- **Tables:** validated `TABLE`/`TABLE_CELL` hints create a table group. Without an explicit shared table ID, grouping stays on one page; a validated shared table ID permits continuation across pages. Every evaluated cell retains its own score annotation.
- **Metadata:** consecutive compatible excluded cover metadata form a compact block, without a synthesized score.
- **Captions and headings:** compatible consecutive structural members form compact blocks. Their text remains visible and searchable.
- **Insufficient body fragments:** only neighboring members with the same classification, structural type and kind can join; page, gap and group-ID rules still apply. An intervening evaluated segment always ends the group.

Member texts are preserved; only original whitespace gaps or a joining newline are inserted. Content is not rewritten. Structural hints are optional: `presentationStructureHint` accepts only an allowlisted kind/type and safe group ID when the stored hint's text hash and start/end offsets exactly match that segment. Stale/unmatched hints are ignored. The renderer does not infer that an inference granularity is proof of a real paragraph, nor invent table membership from arbitrary text.

## PDF and web presentation

The technical PDF defaults to grouped presentation. Full cards prioritize evaluated body segments, with a local percentage rounded only for display and status `SEÑALADO`, `NO SEÑALADO` or `NO EVALUADO`. Compact structural blocks show source ranges, exclusion reason, insufficient-member counts and individual evaluated annotations where present. No third raw-segment PDF is created.

Technical summaries use “segmentos” for all detected units, and preserve the run's evaluated/insufficient totals. Additional visual-unit/group counts are presentation metrics. The PDF remains selectable/searchable text.

Web technical detail defaults to **Agrupada** and offers **Segmentos** for the existing raw scientific audit view. The grouped endpoint is bound to one explicit run, applies the existing source-text/range checks, reads all persisted members and returns grouped units, exact evaluated annotations, actionable indices, reference audit and grouping metrics. It writes no analysis data and invokes no AI service. The frontend validates the response/run identity before display.

## Performance and logging

Grouping sorts persisted members and makes a linear pass. The endpoint records grouping time and heap delta as local presentation measurements. Structured logs contain the run ID and source/display/group counts, not source text or filesystem paths. Rendering timing and actual page counts are recorded separately during QA; no target page count is hardcoded and compaction never overrides traceability.

The compiled Unicode renderer was also measured on a fully synthetic 526-segment workload. The final reproducible measurement and memory samples are reported below and in [synthetic-526-benchmark.json](evidence/f00942/synthetic-526-benchmark.json); it uses no private text or inference.

## Validation status

Automated tests cover reference aliases/inline and numbered headings/false positives/annex exits, score and threshold invariance, table/metadata/reference grouping, contiguous body fragments, evaluated boundaries, completeness/uniqueness and read-only endpoint behavior. PDF fixtures are entirely synthetic. Final results: **61 frontend tests, 246 backend tests (23 files) and 33 backend e2e tests passed; AI service 73 passed and one skipped**. The final backend suite ran against the rebuilt image in 21.66 seconds with the existing training manifests mounted read-only at the test-required path. Thirty focused PDF tests also passed. Production builds, Ruff and project lint passed; existing lint warnings remain in `documents.service.ts` and the frontend analysis effect. Earlier timeout/configuration and ASCII-only test-extractor failures are preserved in ignored local logs; no scientific assertion was weakened.

### Synthetic browser smoke

The UI used the uploaded synthetic `presentation-hardening-fixture.pdf`, document `7cf2c32d-caf9-45a1-9479-4a5bcbe88bbc`, version `02b17938-df8e-4065-932a-2e9856751f07`, and the explicitly tagged deterministic QA run `62e223e5-1801-4eab-9f10-6d77465b0f2b`. Its scores are persisted synthetic QA data, not a model-performance measurement.

Direct browser operations completed generate-both, original preview/download, technical preview/download and regeneration of each variant. The initial report IDs were `650d641c-7fd1-43e1-bd55-34ae011e18b1` and `a57ce9c6-15f8-49b0-87c1-6e138f7f7291`; regenerated IDs were `89122d65-c499-4a4a-b4ca-66d49d12c56e` and `340b7d68-eb62-484c-9eb0-2cbb9b248c81`. All four artifacts are AVAILABLE, their bytes match database hashes, and all preserve the same source version/checksum, exact run, global score 0.434, threshold 0.59 and synthetic model. Original reviews contain 19 pages; grouped technical reports contain five.

The 68 scientific source segments are represented exactly once in 12 display units: eight evaluated body cards, one metadata block, one 20-member table block and two compact reference blocks. An 82-code-unit gap between source indices 52 and 53 conservatively starts the second reference block. Ten evaluated annotations remain visible in total, including scored metadata/reference members. Counts are five raw flagged, two excluded flagged and three actionable body highlights. This realistic fixture complements the separate six/raw-four/actionable regression fixture.

The exact synthetic-ID Nginx evidence includes 25 requests between `2026-10-20T13:41:42Z` and `13:45:10Z`: dual generation and both regenerations returned 201; both previews/downloads returned 200; no captured request returned 4xx/5xx and no analysis request occurred during these report operations. Only timestamp, method, synthetic path and status are retained. See [browser-smoke.json](evidence/f00942/browser-smoke.json). A prior interruption of the local Docker runtime was recovered before this completed flow and is not attributed to a product defect.

### Manual TESIS baseline (read-only)

Local baseline captured at `2026-10-20T06:59:56.632Z` for run `950d39fb-237c-45a7-ad53-ac7a5ab44920`:

| Property | Baseline |
| --- | --- |
| Source pages | 18 |
| Global score | 0.4342228555892896 (43.4% displayed) |
| Threshold | 0.59 (59.0% displayed) |
| Model | ENSEMBLE_V2_V3 |
| Scientific segments | 526 |
| Evaluated / insufficient | 50 / 476 |
| Old technical PDF | 91 pages |
| Old original-review PDF | 19 pages |

The baseline records checksums of the source version, complete run, complete segment rows, model results and prior PDF bytes without saving private source text. The local evidence file is ignored and is not an automated fixture. The old valid PDFs and the earlier known recursive legacy PDF are included in the preservation checks. Final manual generation and measured page reduction are recorded below without private text.

### Live read-only scientific and presentation audit

Before manual regeneration, the running new backend was queried for that exact run. Recursive canonical JSON hashing (object keys sorted; array order preserved; dates JSON-normalized) reproduced every baseline checksum exactly: complete run with its ordered segment/model-result rows, source version, all segment rows, all model-result rows and combined source/run. This checks the entire stored scientific record rather than only the displayed rounded percentages.

The new presentation endpoint represented all 526 source indices exactly once: zero lost, zero duplicated. Its 50 evaluated annotations mapped to 50 unique persisted database IDs, with zero mismatches in index, exact local score, threshold or flagged state. It returned 186 visual units and 120 structural groups: one metadata block, 50 evaluated cards, 62 heading blocks, 16 isolated insufficient segments, 52 contiguous-fragment groups, four caption blocks and one reference block. The structural-group metric includes compact singleton structural blocks as well as multi-member groups; it is not a count of 120 multi-member merges. No table identity was fabricated for this older run without validated table hints.

Reference section start is persisted zero-based index **372** (reader-facing **SEGMENTO 373**). It contains 154 scientific segments. Reference raw flagged count and actionable-highlight count are both zero. Overall counts are four raw flagged, zero flagged presentation exclusions and four actionable highlights. Thus this real run is not the six/raw-four/actionable synthetic regression case.

One endpoint measurement grouped the 526 segments in 3.40 ms. Observed heap delta was −144,448 bytes, which includes garbage-collection noise and is not a retained-memory claim. Three pre-existing reports were read from report storage: the 19-page original review, the 91-page technical PDF and the earlier known 92-page recursive legacy review. The final repetition after manual generation confirmed that their bytes still matched both database content hashes and captured baseline checksums; all remained AVAILABLE and undeleted.

### Manual QA finding: Unicode technical text

The first new manual technical PDF contained 36 pages, preserving all 50 local-score/card associations. Exhaustive extraction then found only 487 of 526 segment texts as exact searchable substrings after NFC/whitespace normalization and removal of the known generated footer. The other 39 mismatches persisted with whitespace removed. An in-memory comparison identified unsupported built-in Helvetica encodings for mathematical/Greek/combining characters, including U+0302, U+03B1 and U+2212. The presentation transform still represented all 526 unchanged source members and all scientific digests matched; this finding concerns PDF text encoding. No private text or code excerpts were retained in the diagnostic output.

The pre-fix aggregate evidence is preserved in [manual-before-unicode-font.json](evidence/f00942/manual-before-unicode-font.json), and the intermediate result before subscript correction in [manual-before-subscript-font.json](evidence/f00942/manual-before-subscript-font.json). They are retained so later verification does not conceal these QA findings. The technical renderer now embeds the already-installed Liberation Sans fonts, uses Caladea for combining-mark graphemes remaining after NFC, and Carlito for subscript digits U+2080–U+2089. Public synthetic extraction tests preserve Greek letters, minus signs, combining accents and subscripts exactly. The other report renderers retain their previous font behavior. Compact structural introductions reserve enough space for their first annotation/source line, fixing the observed orphan reference heading.

### Final manual and browser results

Final manual audit at `2026-10-20T19:28:06Z`: [manual-final-audit.json](evidence/f00942/manual-final-audit.json).

| Artifact / check | Final result |
| --- | --- |
| Original review | `48dca3a5-122f-46e2-bec4-97803f563c5c`, 19 pages |
| Technical report | `8d7226d8-a13e-45e7-8bbf-03e1dec083ad`, **37 pages**, previously 91 |
| Source segments represented once | 526 / 526; zero lost or duplicated |
| Evaluated member / PDF score-card checks | 50 / 50; zero mismatches |
| Evaluated / insufficient scientific segments | 50 / 476 |
| Visual units / structural groups | 186 / 120 |
| Global / threshold / model | 0.4342228555892896 / 0.59 / ENSEMBLE_V2_V3 |
| Scientific/source digests | All five identical to the baseline |
| Original source content streams | 18 / 18 preserved; zero nested technical-page streams |
| Prior PDFs | All three unchanged, AVAILABLE and undeleted |

All **526/526** source texts are found in extracted final technical text after NFC and removal of the known generated footer, layout whitespace and invisible format characters. No letters, numbers, mathematical symbols or punctuation are folded or discarded in this comparison. A stricter NFC plus collapsed-whitespace substring comparison matches 494/526; the remaining 32 reflect PDF word wrapping/spacing and invisible source characters. This distinction is explicit: the final PDF is selectable/searchable, but byte-identical copied whitespace is not claimed. A PyMuPDF bounds check of the actual browser download covered all 37 pages, with zero text spans outside the page and zero blank pages. The private PDF, its extracted text and document-specific verification scripts were not committed or used as automated fixtures.

Both final technical PDFs were regenerated, previewed and downloaded using the product UI. Final synthetic technical report `3c441496-773c-4459-8078-d2b5d9fcef19` has five pages, all 68 canonical texts exactly once, all ten evaluated annotations, and both reference headings with their score/source content on page five. Every synthetic PDF page was rasterized and inspected; no clipping or overlapping text was found. The final browser console had zero captured errors. Sanitized Nginx evidence contains 58 requests for known synthetic IDs, with zero HTTP 4xx/5xx responses. It excludes private document paths. The recovered earlier Docker interruption is recorded separately from the successful flow.

### Reproducible synthetic performance measurement

Run `backend/scripts/benchmark-f00942-synthetic-526.mjs --synthetic-only <output.json>` against compiled backend modules. It uses no database, private files or inference. The fixture has 48 evaluated body segments plus two evaluated structural annotations, totaling 50 evaluated and 476 insufficient members. Final measurement: **526 segments → 51 visual units / three structural groups / 28 actual PDF pages**; grouping **2.080 ms**, rendering **655.813 ms**. Heap samples were 25.28 MB before, 25.63 MB after grouping and 35.96 MB after rendering; RSS samples were 119.34 MB before and 169.39 MB after rendering. These are process-memory samples, not peak-memory measurements or performance guarantees. Input data remained unchanged, with zero lost/duplicated members, changed local scores or invented group scores. See [synthetic-526-benchmark.json](evidence/f00942/synthetic-526-benchmark.json).

## Limitations

This is a conservative presentation classifier, not an academic-document parser. Safe grouping may leave isolated fragments when offsets/gaps/pages or missing structural metadata make membership uncertain. Legacy runs with no validated table hints are not silently assigned table identities. A strict heading rule intentionally leaves ambiguous prose as body. A grouped block may continue over PDF pages; source-member traceability and exact scores take priority over an arbitrary page target. Global model results are not recalculated after excluding references visually. Technical Unicode rendering requires the system fonts already installed in the supplied Docker image (Windows Arial is the supported host fallback); it fails explicitly if the required font set is absent. No new dependency or font download was introduced. Validation is local; no PR, CI, merge or deployment is claimed.
