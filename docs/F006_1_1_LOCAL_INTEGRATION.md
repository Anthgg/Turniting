# F006.1.1 local integration

## Local default

Docker Compose sets `LOCAL_PREFERRED_ANALYZER=EXPERIMENTAL_F006_1_MODEL` and a configured fallback of `CANDIDATE_MODEL_V3`. The analyzer resolves the preference only when the artifact is present and passes validation. If it does not, the API reports the resolved fallback and a warning. The UI selects the resolved local model on first load, and a user choice is preserved.

F006.1 is mounted read-only from `data/models/f006_1/experimental_f006_1` at `/data/models/local/f006_1/experimental_f006_1`. The checked-in local model lock expects the combined weight digest `c451a0062321189f026a1cc3779f50aa1b398a580d4cedfb9365a9486c835a90`. The artifact currently present in this checkout matches that digest. F006.1 remains `EXPERIMENTAL`, `active=false`, and `candidate=false`; the local preference does not change scientific status.

## F006.1.1

The model is registered as `EXPERIMENTAL_F006_1_1_MODEL`, with parent `C3_f006` / `EXPERIMENTAL_F006_MODEL`, training commit `632dc6f7a852ee9c1dfc511a35a76cd1ce63428e`, and source report commit `0ad01f5fb75b48cdd1cce3a9b0084511253a69f1`. It remains inactive and is never a candidate.

The required Drive folder is `MyDrive/turniting/f006_1_1/models/experimental_f006_1_1`. Compose mounts it read-only from `data/models/f006_1_1/experimental_f006_1_1` at `/data/models/local/f006_1_1/experimental_f006_1_1`. The Drive checkpoint is 1,112,897,768 bytes; the connected Drive downloader in this environment refused files above 268,435,456 bytes, so this checkout does not contain the checkpoint. The model is therefore shown as unavailable, fails serving selection, and does not affect health checks. Once installed, its files must pass manifest, inference, calibration, and threshold validation before it becomes selectable in research mode.

The locked routing is `GLOBAL_ISO` for `en` and `other`, and `ES_PLATT` for `es`. Both `GLOBAL_THRESHOLD` and `SPANISH_THRESHOLD` are `0.767241379310345`, chosen on `F006_1_1_VALIDATION`. Language is an explicit request field; there is no automatic language detector. The available report does not lock a SHA-256 digest for the F006.1.1 weight files; artifact metadata validation is distinct from a weight checksum check.

Reported final holdout: macro-F1 `0.8704`, overall human FPR `0.0541`, Spanish human FPR `0.0190`, academic human FPR `0.0307`, unseen-generator human FPR `0.0967`, mixed recall `0.5832`, AI-edited F1 `0.9023`, OOD F1 `0.9383`, and span token F1 `0.7694`. The report records 8/11 gates passed and failures A, H, and I. The F006.1.1 report does not establish paragraph stability. These are historical research metrics, not an ACTIVE decision.

## Span and future unified contract

`EXPERIMENTAL_SPAN_MODEL_V1` is metadata-only. It is not included in the serving registry, cannot be selected, and is not loaded by the AI service. `spanServingReady=false`, `spanHighlighting=false`, and granularity remains `PARAGRAPH`; existing threshold-based paragraph review is retained.

The future unified result exists only as a TypeScript type. There is no unified selectable model, score, route, migration, or persistence contract in this phase. The API reports `unifiedReady=false` and `spanServingReady=false`.

## Verification boundaries

Analyzer model weights are ignored local artifacts and are not staged in Git. This integration uses synthetic text in tests and smoke checks; it does not use private theses or Turnitin data. F006.1.1 inference cannot be smoke-tested until its checkpoint is installed locally.
