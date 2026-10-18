# F006.1.1 — Detector hardening (Track A)

**Status: EXPERIMENTAL_F006_1_1_MODEL.** CANDIDATE_MODEL_V4 was not created and the model is not ACTIVE.
The model passes 8 of the 11 gates on the single evaluation of the locked final holdout.

Model on Drive: `MyDrive/turniting/f006_1_1/models/experimental_f006_1_1`, with the lock in `models/f006_1_1_locked`.

## Result on the final holdout

The holdout has 30,363 documents: 13,650 humans, 5,530 of them Spanish. Leakage is 0.

| Metric | F006.1.1 | F006.1 | F006 | V3 | Gate |
|---|---|---|---|---|---|
| Overall human FPR | **0.0541** | 0.0621 | 0.0744 | 0.0785 | A ≤ 0.05 ✗ |
| Spanish human FPR | **0.0190** | 0.0430 | 0.0884 | 0.0669 | B ≤ 0.08 ✓ |
| Academic human FPR | 0.0307 | 0.0367 | 0.0267 | 0.0202 | C ≤ 0.05 ✓ |
| Unseen-generator FPR | **0.0967** | 0.1120 | 0.1253 | 0.1587 | D ≤ 0.10 ✓ |
| AI-edited macro F1 | 0.9023 | 0.8941 | 0.8510 | 0.8458 | E ≥ 0.90 ✓ |
| OOD macro F1 | 0.9383 | 0.9425 | 0.9366 | 0.9441 | F ≥ 0.90 ✓ |
| Leakage | 0 | | | | G ✓ |
| Mixed recall | **0.5832** | 0.5112 | 0.3908 | 0.3756 | H ≥ 0.65 ✗ |
| Span token F1 | 0.7694 | 0.7782 | 0.7758 | 0.7788 | I ≥ 0.86 ✗ |
| Zero-width / homoglyph macro F1 | 0.8609 / 0.8609 | 0.8569 / 0.8589 | | | J (≤ 3 pp regression) ✓ |
| Holdout untouched | yes | | | | K ✓ |
| Overall macro F1 | 0.8704 | 0.8658 | 0.8316 | 0.8298 | |

Each model was evaluated with its own configuration, fitted on validation (calibration and threshold).
The thresholds were not tuned on the holdout.

## What was done

- **New sources.** The downloaded and normalized sources were COWSL2H, academic abstracts ES, SciELO ES,
  Spanish Billion Words, Beemo, GRADTEX (deduplicated against MAGE) and Heterogeneous AI Spans, in a single
  canonical view. Exact deduplication removed 108,193 rows against V2. CEDEL2 is MANUAL_ACCESS_REQUIRED,
  AIUD-SPAN v2 is BLOCKED_ACCESS and SemEval-2024 Task 8 C is UNAVAILABLE (the repository needs credentials).
- **New validation and final holdout.** Validation has 30,657 documents. The final holdout has 30,363
  documents and was locked before any training. Both are group-safe, and leakage is 0 across exact,
  near-duplicate, group, parent-child, participant and source document.
  - The first attempt failed the leakage gate. That record is kept in `f006_1_1_leakage_FAIL.json`.
  - The causes were "None" strings used as parent ids and near-duplicates the LSH chaining missed. The fix was
    an order-independent cross-set MinHash matcher.
- **Hard pools.** Built from train only and scored with V3, F006 and F006.1: 28,666 hard humans and 16,473
  hard Spanish humans.
- **Ablations.** 10 ablations of 120k windows, all eligible on validation (`reports/f006_1_1/ablation_gate_check.json`).
  - Best parent: **C3_f006** (EXPERIMENTAL_F006).
  - Best configuration: **C8_tok06** (token-loss weight 0.6).
- **Full run and lock.** The full run used 400k windows (371,864 effective). The best checkpoint came at step
  1,200, and the model was locked with ES_PLATT calibration.

## Findings

- **Generalization.** Spanish FPR fell to less than half of F006.1's, and the unseen-generator FPR came in
  under the gate. The new Spanish and academic human data generalize.
- **Overall FPR.** It stays 0.4 points above the gate. The general bucket has an FPR of 0.0905 in the holdout.
- **Mixed and spans.** Mixed recall rises 7 points but stays under 0.65. Span quality does not improve: recall
  is 0.95 but precision only 0.64, because the detector over-marks human text. This is the input for F006.1.2.

## Problems found and fixed

- **Duplicated ids.** 4,024 duplicated ids in `train_extra` misaligned labels and tokens, so training ran at
  chance-level loss. The fix deduplicates ids and aborts when the window metadata and the windows differ in
  count.
- **GPU memory.** Running at the same time as the F008 reranker caused an out-of-memory error. The fix was the
  `F006_MAX_MICRO` cap and resuming without repeating finished ablations.

## Rules followed

- No Turnitin data, VALIDATION_CASE_001, the historical 67% value, private documents or the user's thesis
  were used.
- The historical holdouts (F006, F006.1, V1) were used for reference only.
- No backend, frontend, Prisma, Docker, Supabase or Cloud Run changes. No merge, PR or ACTIVE status.
- No weights or tokens are in Git.
