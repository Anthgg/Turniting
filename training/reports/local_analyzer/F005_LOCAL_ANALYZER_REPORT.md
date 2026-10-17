# F005 — Local AI analyzer: report

Research use only. Every score in this report is an estimate from independent research models. It is not a
score from any commercial service, it does not prove authorship, and it must not be used on its own to make
decisions about a person.

## Scope

- Branch `feat/f005-local-ai-analyzer` was created from 794fb64. There is no merge and no PR.
- The V3 code comes from `claude/project-thread-fm8si4` at commit `c09a0dbd47a5d3b648873e62b9c19272d477a0c5`. No datasets, checkpoints or weights were imported.
- Both `CANDIDATE_MODEL_V2` and `CANDIDATE_MODEL_V3` are registered with status `CANDIDATE`. Neither is activated.
- V3 carries two warnings: `FROZEN_V1_FPR_REGRESSION` and `WINDOW_CONTEXT_DRIFT`.
- No Transformer was trained, fine-tuned or modified. Only post-hoc calibration, thresholds and the ensemble were fitted.

## Data discipline

| stage | data | used for |
|---|---|---|
| calibration, thresholds, ensemble, paragraph mode, aggregation | V1 validation (2,500) + V1 adversarial validation (500 of 625), group-safe | selection |
| single evaluation | V1 frozen test, Spanish test, academic test, OOD, adversarial, unseen generator, unseen domain (400 each, stratified); local synthetic zero-width / homoglyph / clean reference (200 each) | reported once, never fed back |
| paragraph stability | synthetic edits of V1 test / Spanish / academic documents | reported once, after the mode was chosen on validation |

The following were not used: real reports from commercial services, VALIDATION_CASE_001, or any private user
text. The V2 test set and the mixed / AI-edited sets were not copied to this machine, so those rows are quoted
from `training/reports/TRAINING_V3_REPORT.md`, which was evaluated in Colab, and are marked as such.

## Calibration and thresholds (validation)

Calibration was chosen on out-of-fold ECE + Brier. Isotonic won for both models. Cross-validated ECE was:

| model | none | temperature | Platt | isotonic |
|---|---:|---:|---:|---:|
| V3 | 0.0925 | 0.0965 | 0.0139 | **0.0093** |

| profile | V2 threshold (val FPR) | V3 threshold (val FPR / recall) | ENSEMBLE threshold (val FPR / recall / macro F1) |
|---|---|---|---|
| BALANCED | 0.335 | 0.45 (0.048 / 0.913) | 0.59 (0.028 / 0.907 / 0.939) |
| LOW_FALSE_POSITIVE (FPR ≤ 0.05) | 0.605 | 0.45 (0.048 / 0.913) | 0.53 (0.048 / 0.923 / 0.937) |
| VERY_LOW_FALSE_POSITIVE (FPR ≤ 0.02) | 0.83 | 0.845 (0.018 / 0.856) | 0.665 (0.020 / 0.884 / 0.931) |

For V3, BALANCED and LOW_FALSE_POSITIVE coincide because V3's BALANCED point already satisfies FPR ≤ 0.05 on validation.

The ensemble was searched over weighted probability, weighted log-odds and an agreement rule, with w2 from 0 to 1. The best was **weighted probability, w2 = 0.5, w3 = 0.5**.

Validation composite score, computed at LOW_FALSE_POSITIVE: V2_ONLY 0.892, V3_ONLY 0.928, **ENSEMBLE 0.935**.

## Single test evaluation (`ensemble_test.json`)

Each cell shows macro F1 / FPR / recall.

| set | V2 LOW_FALSE_POSITIVE | V3 BALANCED | ENSEMBLE BALANCED |
|---|---|---|---|
| V1 frozen test | 0.925 / 0.085 / 0.934 | 0.871 / 0.190 / 0.929 | **0.927** / 0.111 / 0.962 |
| V1 Spanish test | 0.875 / 0.107 / 0.856 | 0.837 / 0.210 / 0.887 | 0.870 / 0.137 / 0.877 |
| V1 academic test | 0.902 / 0.085 / 0.893 | 0.894 / 0.074 / 0.871 | **0.917 / 0.045** / 0.888 |
| OOD | 0.872 / 0.222 / 0.970 | **0.950 / 0.054** / 0.954 | 0.947 / 0.074 / 0.970 |
| adversarial | 0.782 / 0.082 / 0.775 | 0.904 / 0.061 / 0.921 | **0.917 / 0.041 / 0.927** |
| unseen generator | 0.772 / 0.228 / 0.773 | 0.754 / 0.305 / 0.813 | 0.762 / 0.254 / 0.778 |
| unseen domain | 0.857 / 0.101 / 0.812 | 0.882 / 0.101 / 0.865 | **0.900 / 0.077** / 0.875 |
| zero-width (synthetic) | 0.485 / 0.010 / 0.165 | **0.884** / 0.175 / 0.942 | 0.752 / 0.031 / 0.563 |
| homoglyph (synthetic) | 0.786 / 0.052 / 0.641 | 0.884 / 0.175 / 0.942 | **0.910 / 0.062** / 0.883 |

V1 frozen test FPR by profile:

| profile | V2 | V3 | ENSEMBLE |
|---|---:|---:|---:|
| BALANCED | 0.196 | 0.190 | 0.111 |
| LOW_FALSE_POSITIVE | 0.085 | 0.190 | 0.169 |
| VERY_LOW_FALSE_POSITIVE | 0.053 | 0.138 | 0.101 |

Rows quoted from the V3 Colab report (not re-evaluated locally):
- V2 test macro F1: V2 0.744, V3 0.879.
- Mixed recall: V2 0.372, V3 0.853.
- AI-edited macro F1: V2 0.684, V3 0.899.

## Paragraph scoring

The paragraph mode and aggregation were chosen on validation, using 120 documents with synthetic paragraphing:
- **STRICT_PARAGRAPH**: unchanged-paragraph drift 0. CONTEXTUAL_PARAGRAPH had p95 0.043.
- Document aggregation: **token_weighted_mean**, with validation macro F1 0.958 and FPR 0.

Paragraphs below 120 chars, 20 words or 32 tokens return `INSUFFICIENT_TEXT`.

Stability on the test side was measured once on V3 with synthetic minor edits and paragraph replacements. The table shows drift on unchanged paragraphs.

| mode | median | p90 | p95 |
|---|---:|---:|---:|
| WINDOW_DOCUMENT (V3 512-token windows) | 0.000 | 0.071 | 0.221 (paragraph replacement p95 0.694) |
| **STRICT_PARAGRAPH** | 0.000 | 0.000 | 0.000 |
| CONTEXTUAL_PARAGRAPH | 0.000 | 0.049 | 0.121 (paragraph replacement p95 0.315) |

The test came from 83 synthetic pairs: 42 minor edits and 41 paragraph replacements.

## Selection (section 42)

The selection rule fixed in advance was: among validation profiles with FPR ≤ 0.05, take the highest validation
macro F1, preferring the analyzer with the best validation composite. That gives **ENSEMBLE_V2_V3 with the BALANCED
profile** (validation FPR 0.028, macro F1 0.939). Here is how it does against each criterion:

- **FPR clearly lower than V3 BALANCED.** Yes on validation (0.028 vs 0.048). On the frozen V1 test it is 0.111 vs 0.190.
- **No severe loss on Spanish, academic or OOD.** None. Spanish and academic are better than V3, and OOD is about equal (0.947 vs 0.950). Mixed was not evaluated locally.
- **Paragraph stability.** STRICT mode removes the V3 window-context drift (see table).
- **Calibration.** Isotonic, with test ECE between 0.06 and 0.10.
- **No test-set tuning.** Confirmed. Test numbers were computed once, after every selection.

## Limits that remain

- **The FPR target does not transfer.** Validation FPR ≤ 0.05 does not hold on the frozen V1 test for any model or profile. The best is V2 VERY_LOW at 0.053, and the ensemble BALANCED reaches 0.111. The V1 validation and V1 test distributions differ, and post-hoc thresholds cannot fix that.
- **Unseen generators remain weak**, with FPR between 0.23 and 0.31 for every option.
- **Zero-width text weakens V2 badly**, and so it drags the ensemble down (recall 0.563). V3 handles it through canonicalization.
- **V2 LOW_FALSE_POSITIVE is the conservative alternative** (V1 test FPR 0.085), but its OOD FPR is 0.222 and its zero-width recall is 0.165.

## Next phase

`NEXT_PHASE = F006_TRANSFORMER_AI_DETECTOR`.

F005 already covers the serving layer, the registry, calibration, the ensemble and paragraph-local inference. F006 still owns:
- a detector whose low FPR holds on the frozen V1 distribution and on unseen generators, which means training or data work, not thresholds;
- a held-out evaluation on mixed and AI-edited text on this machine;
- the decision whether any candidate becomes ACTIVE.
