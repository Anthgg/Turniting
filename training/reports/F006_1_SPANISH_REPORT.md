# F006.1 — Spanish generalization hardening

Research use only; never a Turnitin score.

**Result:** `EXPERIMENTAL`; CANDIDATE_MODEL_V4 created: **NO**; ACTIVE: NO.

Failed gates: A_overall_human_fpr_le_0.05, D_unseen_generator_fpr_le_0.10, E_mixed_recall_ge_0.64, H_span_f1_ge_0.86

## Diagnosis

See `f006_1/SPANISH_DISTRIBUTION_AUDIT.md`: the F006 Spanish holdout humans came from the official TEST splits of AuTexTification / IberAuTexTification (chat, how-to, news domains) that never occur in TRAIN or the F006 validation.

## Data

- F006_1 VALIDATION: 23,871 docs, 11,371 humans; Spanish 11,000 (6,000 humans).
- F006_1 FINAL HOLDOUT (LOCKED): 24,100 docs, 11,000 humans; Spanish 10,500 (5,500 humans).
- TRAIN_EXTRA: 51,346 rows (40,837 humans). Leakage: PASS.

- New public Spanish human rows: 86,950 ({'cc_news_es_2019': 62472, 'xlsum_es_bbcmundo': 24478}), exact dup vs V2 removed 0, near dup removed 789.

## Stage A (F006_1 validation, proxy operating point general-human FPR 0.04)

| run | score | elig | FPR all | FPR es | F1 es | mixed rec |
|---|---|---|---|---|---|---|
| B7_v3_hw1.0 | 0.5417 | True | 0.048 | 0.036 | 0.885 | 0.800 |
| B7_v3_hw1.5 | 0.5200 | False | 0.050 | 0.038 | 0.884 | 0.805 |
| B3_v3_h0.5 | 0.5102 | True | 0.050 | 0.037 | 0.887 | 0.809 |
| B9_v3_es2.0 | 0.5025 | True | 0.047 | 0.031 | 0.874 | 0.809 |
| B5_v3_h0.5_es20 | 0.4934 | False | 0.055 | 0.048 | 0.881 | 0.800 |
| B6_v3_h0.5_es30 | 0.4881 | True | 0.048 | 0.033 | 0.880 | 0.800 |
| B3_v3_h0.65 | 0.4533 | False | 0.051 | 0.036 | 0.884 | 0.794 |
| B9_v3_es3.0 | 0.4442 | False | 0.053 | 0.041 | 0.883 | 0.799 |
| F0061_FULL | 0.4418 | False | 0.065 | 0.063 | 0.921 | 0.805 |
| B1_v3 | 0.4337 | False | 0.052 | 0.036 | 0.881 | 0.819 |
| B2_f006 | 0.4317 | False | 0.053 | 0.036 | 0.892 | 0.835 |

## Lock

- parent B1_v3; calibration {'option': 'ES_ISO', 'global': 'isotonic', 'spanish': 'isotonic'}; global threshold 0.6443, Spanish threshold 0.6443
- sampling: human share 0.5, Spanish mix [0.4, 0.3, 0.3], human weight 1.0, es weight 2.5, academic weight 1.5, paragraph share 0.3

## F006_1 FINAL HOLDOUT (evaluated once; each model with its own validation-fitted calibration option)

| subset | CANDIDATE_MODEL_V3 (ES_ISO) | EXPERIMENTAL_F006_MODEL (ES_THRESH) | F006_1_MODEL (ES_ISO) |
|---|---|---|---|
| all | F1 0.845 / FPR 0.069 [0.065-0.074] / rec 0.772 | F1 0.837 / FPR 0.047 [0.043-0.051] / rec 0.740 | F1 0.891 / FPR 0.055 [0.051-0.060] / rec 0.847 |
| general | F1 0.849 / FPR 0.070 [0.061-0.081] / rec 0.769 | F1 0.842 / FPR 0.048 [0.040-0.057] / rec 0.736 | F1 0.876 / FPR 0.061 [0.052-0.071] / rec 0.814 |
| spanish | F1 0.864 / FPR 0.080 [0.073-0.087] / rec 0.805 | F1 0.857 / FPR 0.054 [0.048-0.060] / rec 0.765 | F1 0.919 / FPR 0.055 [0.049-0.061] / rec 0.892 |
| spanish_academic | F1 0.885 / FPR 0.000 [0.000-0.033] / rec 0.828 | F1 0.866 / FPR 0.000 [0.000-0.033] / rec 0.798 | F1 0.963 / FPR 0.000 [0.000-0.033] / rec 0.946 |
| spanish_non_academic | F1 0.863 / FPR 0.081 [0.074-0.089] / rec 0.804 | F1 0.857 / FPR 0.055 [0.049-0.062] / rec 0.764 | F1 0.918 / FPR 0.056 [0.050-0.063] / rec 0.889 |
| hard_human | FPR 0.460 [0.436-0.484] | FPR 0.310 [0.289-0.333] | FPR 0.356 [0.334-0.380] |
| academic | F1 0.904 / FPR 0.007 [0.004-0.012] / rec 0.822 | F1 0.893 / FPR 0.007 [0.004-0.012] / rec 0.801 | F1 0.929 / FPR 0.016 [0.011-0.024] / rec 0.878 |
| mixed | rec 0.474 | rec 0.471 | rec 0.630 |
| ai_edited | F1 0.892 / FPR 0.003 [0.000-0.014] / rec 0.849 | F1 0.892 / FPR 0.003 [0.000-0.014] / rec 0.848 | F1 0.924 / FPR 0.005 [0.001-0.018] / rec 0.896 |
| ood | F1 0.943 / FPR 0.026 [0.015-0.044] / rec 0.912 | F1 0.943 / FPR 0.018 [0.009-0.034] / rec 0.904 | F1 0.942 / FPR 0.044 [0.029-0.066] / rec 0.928 |
| unseen_generator | F1 0.836 / FPR 0.131 [0.110-0.156] / rec 0.804 | F1 0.844 / FPR 0.099 [0.080-0.121] / rec 0.787 | F1 0.877 / FPR 0.107 [0.088-0.131] / rec 0.861 |
| unseen_domain | F1 0.815 / FPR 0.052 [0.036-0.075] / rec 0.688 | F1 0.809 / FPR 0.014 [0.007-0.029] / rec 0.644 | F1 0.839 / FPR 0.060 [0.042-0.084] / rec 0.742 |
| adversarial | rec 0.804 | rec 0.743 | rec 0.873 |

### Robustness

| model | zero-width F1 | homoglyph F1 | span token F1 |
|---|---|---|---|
| F006_1_MODEL | 0.880 | 0.879 | 0.826 |
| CANDIDATE_MODEL_V3 | 0.861 | 0.860 | 0.822 |
| EXPERIMENTAL_F006_MODEL | 0.848 | 0.848 | 0.822 |

### Historical (observed earlier; continuity only)

| model | HISTORICAL_F006_SPANISH FPR | HISTORICAL_V1 v1_test FPR | v1_test_spanish FPR |
|---|---|---|---|
| F006_1_MODEL | 0.128 | 0.088 | 0.070 |
| CANDIDATE_MODEL_V3 | 0.172 | 0.118 | 0.086 |
| EXPERIMENTAL_F006_MODEL | 0.132 | 0.072 | 0.072 |

historical, observed earlier; continuity only. HISTORICAL_V1 is no longer independent of F006.1 training (sibling rows of the same official test distributions were re-partitioned into TRAIN_EXTRA).

## Gates

- FAIL A_overall_human_fpr_le_0.05
- PASS B_spanish_human_fpr_le_0.08
- PASS C_academic_human_fpr_le_0.05
- FAIL D_unseen_generator_fpr_le_0.10
- FAIL E_mixed_recall_ge_0.64
- PASS F_ai_edited_f1_ge_0.81
- PASS G_ood_f1_ge_0.90_or_drop_le_0.04
- FAIL H_span_f1_ge_0.86
- PASS I_zero_width_homoglyph_no_severe_regression
- PASS J_leakage_0
- PASS K_holdout_not_used_for_tuning
