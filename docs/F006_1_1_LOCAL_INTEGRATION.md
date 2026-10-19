# F006.1.1 local integration

## Local default

Docker Compose sets `LOCAL_PREFERRED_ANALYZER=EXPERIMENTAL_F006_1_MODEL` and a configured fallback of `CANDIDATE_MODEL_V3`. The analyzer resolves the preference only when the artifact is present and passes validation. If it does not, the API reports the resolved fallback and a warning. The UI selects the resolved local model on first load, and live availability refreshes preserve the user's current selection.

F006.1 is mounted read-only from `data/models/f006_1/experimental_f006_1` at `/data/models/local/f006_1/experimental_f006_1`. The checked-in local model lock expects the combined weight digest `c451a0062321189f026a1cc3779f50aa1b398a580d4cedfb9365a9486c835a90`. The artifact currently present in this checkout matches that digest. F006.1 remains `EXPERIMENTAL`, `active=false`, and `candidate=false`; the local preference does not change scientific status.

## F006.1.1

The model is registered as `EXPERIMENTAL_F006_1_1_MODEL`, with parent `C3_f006` / `EXPERIMENTAL_F006_MODEL`, training commit `632dc6f7a852ee9c1dfc511a35a76cd1ce63428e`, and source report commit `0ad01f5fb75b48cdd1cce3a9b0084511253a69f1`. It remains inactive and is never a candidate.

The required Drive folder is `MyDrive/turniting/f006_1_1/models/experimental_f006_1_1`. Compose mounts it read-only from `data/models/f006_1_1/experimental_f006_1_1` at `/data/models/local/f006_1_1/experimental_f006_1_1`. On 2026-10-19, the complete folder was installed from the user's downloaded ZIP. Its ten model files passed manifest, inference, tokenizer, calibration, and threshold validation. The 1,112,897,768-byte checkpoint matched the separately downloaded copy, and all nine auxiliary files matched copies fetched from the connected Drive folder. F006.1.1 is now available and selectable in research mode. A missing or invalid artifact still leaves its individual model unavailable without breaking general health.

The observed checkpoint SHA-256 is `67244cac5d09b6aecc55829d57398f2e0b1e0414a43004f950ea41b321c1accc`. `LOCAL_IMPORT_MANIFEST.json`, stored beside the ignored model files, records the import source, ZIP digest, and individual file hashes. This records the installed bytes; it does not establish an expected digest from the research model lock. The model API and UI explicitly distinguish validated metadata from a validated expected weight checksum.

The locked routing is `GLOBAL_ISO` for `en` and `other`, and `ES_PLATT` for `es`. Both `GLOBAL_THRESHOLD` and `SPANISH_THRESHOLD` are `0.767241379310345`, chosen on `F006_1_1_VALIDATION`. Language is an explicit request field; there is no automatic language detector. The available report does not lock a SHA-256 digest for the F006.1.1 weight files; artifact metadata validation is distinct from a weight checksum check.

Reported final holdout: macro-F1 `0.8704`, overall human FPR `0.0541`, Spanish human FPR `0.0190`, academic human FPR `0.0307`, unseen-generator human FPR `0.0967`, mixed recall `0.5832`, AI-edited F1 `0.9023`, OOD F1 `0.9383`, and span token F1 `0.7694`. The report records 8/11 gates passed and failures A, H, and I. The F006.1.1 report does not establish paragraph stability. These are historical research metrics, not an ACTIVE decision.

## Span and future unified contract

`EXPERIMENTAL_SPAN_MODEL_V1` is metadata-only. It is not included in the serving registry, cannot be selected, and is not loaded by the AI service. `spanServingReady=false`, `spanHighlighting=false`, and granularity remains `PARAGRAPH`; existing threshold-based paragraph review is retained.

The future unified preparation is type-only in `backend/src/analysis/unified-model.contract.ts`: `UnifiedModelConfig`, `ComponentScore`, `UnifiedAnalysisResult`, `UnifiedInferenceCacheIdentity`, and a format-independent `UnifiedArtifactLoader` interface. Config permits only ENSEMBLE_V2_V3, F006.1, and F006.1.1 as global components, retains component versions and result component IDs for audit, and leaves the meta-model, calibration artifact, and threshold unset until research defines them. No config instance, fusion weights, score, selectable model, route, database migration, or fake persistence is created. The API reports `unifiedReady=false` and `spanServingReady=false`.

The future cache identity includes fusion version, meta-model hash, calibration artifact hash, sorted component model IDs and versions, threshold profile and optional custom threshold, explicit language, paragraph mode, and text hash. Research must define the artifact schema and format before implementing the loader; JSON, joblib, and ONNX remain options rather than selected dependencies. Existing F009.3 future presentation types remain preparatory and do not enable serving.

## Verified local runtime: 2026-10-19

Base: `feat/f009-3-threshold-span-ready` at `eef1f93a3a248be47bc1967a4bc054c597ab3b85`. Integration branch: `feat/f006-1-1-local-integration`; initial implementation: `66aba3786d336b22ba568e2300e984d8b512d158`.

The running Docker images initially predated this integration. The AI, backend, and frontend images were rebuilt and recreated using the existing data volumes. A PostgreSQL custom-format backup was saved outside Git before applying `20261019100000_f0061_experimental_analyzers`, which adds the two experimental analyzer enum values. All four services are healthy.

| Local check | F006.1 | F006.1.1 |
| --- | --- | --- |
| Artifact present / metadata valid / available / servable | PASS | PASS |
| Expected weight checksum | Validated against the locked combined digest | No expected digest in the research report |
| Spanish calibrator | ES_ISO | ES_PLATT |
| English / other calibrator | GLOBAL_ISO | GLOBAL_ISO |
| Exact Spanish and global threshold | 0.6442953020134229 | 0.767241379310345 |
| STRICT and CONTEXTUAL compatibility | PASS | PASS |
| Five repeated synthetic paragraph scores | Identical; maximum delta 0 | Identical; maximum delta 0 |
| Model load time | 5,363 ms | 1,859 ms |
| Observed warm paragraph request | 1,382.42 ms | 472.34 ms |
| Observed ten-paragraph request | 5,307.84 ms | 3,690.32 ms |

These are CPU measurements for a synthetic local sample, including request overhead. They are integration observations, not a scientific model comparison. One model is resident at a time; the observed AI container memory after both checks was approximately 966 MiB. The Docker image uses CPU PyTorch, so this check does not measure VRAM.

The browser smoke uploaded a new synthetic TXT, selected F006.1 by default with Spanish calibration, analyzed it, generated and downloaded its AI PDF, then manually selected F006.1.1 and repeated the workflow. Both models retained their exact IDs, calibration sources, thresholds, and model versions in persisted runs. Repeating both analyses produced two cache hits with distinct cache keys. Four completed runs remained visible after reloading the document.

Both AI PDFs contained two pages; all four rendered pages were inspected. Their text and downloaded hashes matched the source and report records. F006.1 highlighted three paragraphs at its saved threshold; F006.1.1 highlighted two, leaving the third paragraph normal even though it belonged to a HIGH visual signal band. The F009.3 threshold rule, clean review, report history, provenance, and exact 24-hour retention were preserved. Console errors and observed HTTP failures during the smoke were zero.

Verification results:

- Backend: 139 tests passed; build and lint completed.
- Frontend: 38 tests passed; build and lint completed.
- AI analyzer unit tests: 25 passed, one skipped because the Windows test environment lacks PyTorch. Real PyTorch inference was separately exercised successfully in Docker for both installed models.
- The installed-state regression covers available and missing artifacts, checksum disclosure, list/detail consistency, and unchanged scientific status.
- The model API exposes no local storage or Drive paths.

The model screen now derives technical availability from the live AI service. Static claims that the checkpoint was absent or that explicit language routing was disconnected were removed from the integration catalog. Scientific limitations, failed gates, and `paragraphStability=NOT_EVALUATED` remain visible.

## Cleanup and evidence

The synthetic document, its four analysis runs, and its two generated reports were removed after verification. The original eight document IDs, 17 analysis runs, and six report records matched the pre-update baseline. The backup is local at `C:\Users\anthg\.codex\backups\turniting\pre-f00611-20261019\database.dump`.

The downloaded checkpoint, its source ZIP, and the two synthetic PDF downloads were deleted only after hash checks and successful integration, releasing 2,114,029,553 bytes from Downloads. Temporary auxiliary and extraction directories were removed. The installed artifacts remain in the ignored model store. Synthetic evidence, rendered PDFs, screenshots, and the runtime JSON are retained locally under ignored `data/eval/`.

Analyzer weights were not staged in Git. No training, recalibration, threshold search, private thesis input, or Turnitin data was used. `ACTIVE_MODEL=NONE`; both experimental models remain inactive and are not candidates. Span serving and the future unified model remain unavailable.

Remaining warnings are the absence of an authoritative F006.1.1 weight digest, the existing frontend `set-state-in-effect` lint warning, the existing backend `no-control-regex` warning, and the existing Vite chunk-size advisory. Poppler emitted a Symbol-font fallback warning; visual inspection found no missing content or layout defects in these PDFs.

Next research phase: `F006_1_3_UNIFIED_ENSEMBLE_CALIBRATION`.
