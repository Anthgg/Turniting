# F006 — Low-FPR Transformer + generalization hardening

Research use only. Scores are estimates of an independent research detector, never a Turnitin score.

**Result:** status `EXPERIMENTAL`; CANDIDATE_MODEL_V4 created: **NO**; ACTIVE: NO.

## Data

- F006_FINAL_HOLDOUT (LOCKED before training): 37,214 docs, 15,514 humans, 29,528 groups; ids sha256 `9d881ee8af8aba0b…`. Never-observed TEST-side groups only.
- F006 VALIDATION: 30,490 docs, 13,490 humans.
- Unseen generators: validation proxy ['deepseek'], holdout ['cohere', 'mistral']; unseen domains: validation proxy ['reports'], holdout ['recipes', 'reviews'].
- Leakage (group / exact / parent-child / near-duplicate): PASS.

- HARD_HUMAN_POOL (TRAIN only): 32,665 docs from 250,000 scored TRAIN humans; cut-off raw P >= 0.556 (top 15 %), <= 12 % per source dataset; 0.168 of TRAIN humans already had raw P >= 0.5 under V3.

- Gated datasets: MGTPD NO_TOKEN, EDITLENS NO_TOKEN, MULTISOCIAL RESTRICTED

## Stage A ablations (F006 VALIDATION only)

Selection rule: eligible (FPR all validation humans <= 0.05 at general-human FPR 0.04) first, then max F006_SELECTION_SCORE.

| run | score | FPR all | ES FPR | ACA FPR | UGEN FPR | UDOM FPR | OOD FPR | mixed rec | hard FPR |
|---|---|---|---|---|---|---|---|---|---|
| V3 (init, no training) | 0.5903 | 0.049 | 0.031 | 0.027 | 0.021 | 0.425 | 0.029 | 0.819 | 0.328 |
| A4_aca1.5 | 0.6239 | 0.048 | 0.035 | 0.027 | 0.013 | 0.392 | 0.036 | 0.828 | 0.315 |
| F006_FULL | 0.6033 | 0.050 | 0.031 | 0.031 | 0.013 | 0.409 | 0.039 | 0.824 | 0.330 |
| A3_h0.4_r0.3_w1.5 | 0.5984 | 0.049 | 0.035 | 0.030 | 0.014 | 0.420 | 0.028 | 0.833 | 0.324 |
| A3_h0.4_r0.3_w2.0 | 0.5880 | 0.050 | 0.036 | 0.028 | 0.015 | 0.433 | 0.030 | 0.837 | 0.332 |
| A1_h0.4_r0.3_ce | 0.5784 | 0.049 | 0.034 | 0.028 | 0.016 | 0.440 | 0.026 | 0.831 | 0.326 |
| A2_h0.4_r0.2_ce | 0.5596 | 0.051 | 0.038 | 0.026 | 0.014 | 0.451 | 0.033 | 0.821 | 0.337 |
| A3_h0.4_r0.3_focal1 | 0.5511 | 0.051 | 0.034 | 0.029 | 0.015 | 0.468 | 0.030 | 0.851 | 0.338 |
| A4_es2.0 | 0.5482 | 0.052 | 0.035 | 0.030 | 0.015 | 0.466 | 0.035 | 0.841 | 0.343 |
| A2_h0.4_r0.4_ce | 0.5217 | 0.051 | 0.038 | 0.027 | 0.013 | 0.490 | 0.032 | 0.827 | 0.341 |
| A1_h0.5_r0.3_ce | 0.5145 | 0.053 | 0.034 | 0.030 | 0.015 | 0.497 | 0.032 | 0.829 | 0.348 |
| A1_h0.6_r0.3_ce | 0.5076 | 0.053 | 0.040 | 0.031 | 0.015 | 0.501 | 0.028 | 0.830 | 0.351 |

## Locked configuration

- loss: {'type': 'weighted', 'human_weight': 1.5, 'focal_gamma': 1.0}
- sampling: {'human_share': 0.4, 'hard_ratio': 0.3, 'es_w': 3.0, 'aca_w': 1.5, 'para_frac': 0.25, 'emphasis': True, 'windows': 450000, 'hard_pool': '/content/drive/MyDrive/turniting/f006/datasets/hard_human_pool_v1.parquet'}
- preprocessing: {'profile': 'V3_CANONICALIZED_V1', 'view': 'canonical', 'aggregation': 'trimmed_mean', 'max_length': 512, 'stride': 128, 'max_windows_per_doc': 8}
- calibration: isotonic; thresholds {'BALANCED': 0.8433420365535249, 'LOW_FALSE_POSITIVE': 0.7694174757281554, 'VERY_LOW_FALSE_POSITIVE': 0.8433420365535249}
- selected analyzer (validation): V4_ONLY
- model sha256 `640247c1f5829de9…`, locked 2026-10-18T01:24:56Z

- training: 440,335 windows, 1.07 h, 114.6 win/s, GPU {'gpu_util_mean': 95.0, 'gpu_util_p50': 100.0, 'gpu_util_p90': 100.0, 'vram_used_max_gb': 72.0, 'vram_total_gb': 80.0, 'samples': 192}, peak VRAM 77.9 GB

## Results (each model at its own BALANCED threshold chosen on F006 VALIDATION)

### F006 VALIDATION

| subset | CANDIDATE_MODEL_V2 | CANDIDATE_MODEL_V3 | ENSEMBLE_V2_V3 | F006_MODEL |
|---|---|---|---|---|
| all | F1 0.652 / FPR 0.038 [0.035-0.041] | F1 0.871 / FPR 0.014 [0.012-0.016] | F1 0.718 / FPR 0.010 [0.008-0.012] | F1 0.870 / FPR 0.013 [0.011-0.015] |
| general | F1 0.709 / FPR 0.019 [0.016-0.023] | F1 0.864 / FPR 0.014 [0.011-0.017] | F1 0.750 / FPR 0.008 [0.006-0.011] | F1 0.863 / FPR 0.013 [0.010-0.016] |
| hard_human | FPR 0.134 [0.120-0.149] | FPR 0.093 [0.081-0.106] | FPR 0.065 [0.055-0.077] | FPR 0.088 [0.077-0.102] |
| spanish | F1 0.766 / FPR 0.039 [0.031-0.048] | F1 0.899 / FPR 0.012 [0.008-0.018] | F1 0.814 / FPR 0.005 [0.003-0.010] | F1 0.887 / FPR 0.014 [0.010-0.020] |
| academic | F1 0.754 / FPR 0.022 [0.018-0.028] | F1 0.917 / FPR 0.005 [0.003-0.008] | F1 0.796 / FPR 0.002 [0.001-0.004] | F1 0.911 / FPR 0.007 [0.005-0.011] |
| mixed | F1 0.487 / FPR 0.062 [0.046-0.082] | F1 0.781 / FPR 0.011 [0.006-0.022] | F1 0.550 / FPR 0.007 [0.003-0.017] | F1 0.791 / FPR 0.017 [0.010-0.030] |
| ai_edited | F1 0.473 / FPR 0.015 [0.008-0.026] | F1 0.857 / FPR 0.003 [0.001-0.010] | F1 0.567 / FPR 0.003 [0.001-0.010] | F1 0.885 / FPR 0.003 [0.001-0.010] |
| ood | F1 0.676 / FPR 0.069 [0.055-0.086] | F1 0.895 / FPR 0.006 [0.003-0.013] | F1 0.743 / FPR 0.003 [0.001-0.009] | F1 0.895 / FPR 0.007 [0.003-0.014] |
| unseen_generator | F1 0.595 / FPR 0.054 [0.044-0.067] | F1 0.959 / FPR 0.009 [0.006-0.016] | F1 0.728 / FPR 0.006 [0.003-0.011] | F1 0.940 / FPR 0.005 [0.003-0.010] |
| unseen_domain | F1 0.369 / FPR 0.146 [0.119-0.178] | F1 0.586 / FPR 0.091 [0.069-0.118] | F1 0.456 / FPR 0.096 [0.074-0.124] | F1 0.580 / FPR 0.085 [0.064-0.112] |
| adversarial | recall 0.511 | recall 0.953 | recall 0.679 | recall 0.961 |

### F006_FINAL_HOLDOUT (evaluated once, after the lock)

| subset | CANDIDATE_MODEL_V2 | CANDIDATE_MODEL_V3 | ENSEMBLE_V2_V3 | F006_MODEL |
|---|---|---|---|---|
| all | F1 0.620 / FPR 0.043 [0.040-0.046] | F1 0.830 / FPR 0.062 [0.058-0.065] | F1 0.668 / FPR 0.037 [0.034-0.040] | F1 0.831 / FPR 0.045 [0.042-0.048] |
| general | F1 0.676 / FPR 0.038 [0.033-0.043] | F1 0.837 / FPR 0.058 [0.052-0.064] | F1 0.724 / FPR 0.033 [0.029-0.038] | F1 0.835 / FPR 0.040 [0.035-0.045] |
| hard_human | FPR 0.195 [0.180-0.212] | FPR 0.410 [0.390-0.430] | FPR 0.246 [0.229-0.264] | FPR 0.297 [0.279-0.316] |
| spanish | F1 0.737 / FPR 0.116 [0.104-0.130] | F1 0.810 / FPR 0.183 [0.168-0.199] | F1 0.763 / FPR 0.121 [0.109-0.135] | F1 0.810 / FPR 0.142 [0.129-0.157] |
| academic | F1 0.679 / FPR 0.014 [0.011-0.019] | F1 0.896 / FPR 0.003 [0.002-0.006] | F1 0.726 / FPR 0.001 [0.000-0.003] | F1 0.889 / FPR 0.002 [0.001-0.005] |
| mixed | F1 0.107 / FPR 0.083 [0.015-0.354] | F1 0.423 / FPR 0.000 [0.000-0.243] | F1 0.163 / FPR 0.000 [0.000-0.243] | F1 0.419 / FPR 0.000 [0.000-0.243] |
| ai_edited | F1 0.509 / FPR 0.018 [0.011-0.028] | F1 0.852 / FPR 0.005 [0.002-0.012] | F1 0.583 / FPR 0.002 [0.001-0.007] | F1 0.862 / FPR 0.004 [0.002-0.010] |
| ood | F1 0.660 / FPR 0.067 [0.056-0.081] | F1 0.926 / FPR 0.011 [0.007-0.017] | F1 0.728 / FPR 0.009 [0.006-0.016] | F1 0.931 / FPR 0.013 [0.009-0.021] |
| unseen_generator | F1 0.765 / FPR 0.040 [0.033-0.048] | F1 0.818 / FPR 0.089 [0.079-0.101] | F1 0.789 / FPR 0.055 [0.047-0.064] | F1 0.831 / FPR 0.069 [0.060-0.080] |
| unseen_domain | F1 0.696 / FPR 0.023 [0.017-0.032] | F1 0.804 / FPR 0.043 [0.034-0.055] | F1 0.728 / FPR 0.019 [0.013-0.027] | F1 0.813 / FPR 0.018 [0.012-0.026] |
| adversarial | F1 0.292 / FPR 0.000 [0.000-0.658] | F1 0.439 / FPR 0.000 [0.000-0.658] | F1 0.325 / FPR 0.000 [0.000-0.658] | F1 0.432 / FPR 0.000 [0.000-0.658] |

### Robustness (holdout copies)

| model | zero-width F1 | homoglyph F1 | span token F1 |
|---|---|---|---|
| F006_MODEL | 0.822 | 0.819 | 0.888 |
| CANDIDATE_MODEL_V3 | 0.841 | 0.839 | 0.885 |
| CANDIDATE_MODEL_V2 | 0.331 | 0.472 | n/a |
| ENSEMBLE_V2_V3 | 0.333 | 0.574 | n/a |

### HISTORICAL_V1_BENCHMARK (observed in F005; continuity only)

| subset | CANDIDATE_MODEL_V2 | CANDIDATE_MODEL_V3 | ENSEMBLE_V2_V3 | F006_MODEL |
|---|---|---|---|---|
| v1_test | F1 0.814 / FPR 0.033 [0.026-0.042] | F1 0.866 / FPR 0.106 [0.093-0.121] | F1 0.859 / FPR 0.045 [0.036-0.055] | F1 0.874 / FPR 0.068 [0.057-0.080] |
| v1_test_spanish | F1 0.790 / FPR 0.039 [0.026-0.058] | F1 0.851 / FPR 0.098 [0.077-0.124] | F1 0.836 / FPR 0.057 [0.041-0.078] | F1 0.844 / FPR 0.081 [0.062-0.106] |
| v1_test_academic | F1 0.878 / FPR 0.005 [0.001-0.018] | F1 0.892 / FPR 0.017 [0.008-0.035] | F1 0.886 / FPR 0.005 [0.001-0.018] | F1 0.888 / FPR 0.017 [0.008-0.035] |
| v1_ood | F1 0.929 / FPR 0.075 [0.058-0.096] | F1 0.945 / FPR 0.008 [0.004-0.017] | F1 0.954 / FPR 0.004 [0.001-0.012] | F1 0.951 / FPR 0.019 [0.011-0.031] |
| v1_adversarial | F1 0.709 / FPR 0.003 [0.001-0.012] | F1 0.837 / FPR 0.019 [0.010-0.033] | F1 0.735 / FPR 0.007 [0.003-0.017] | F1 0.867 / FPR 0.019 [0.010-0.033] |
| v1_unseen_generator | F1 0.750 / FPR 0.079 [0.065-0.096] | F1 0.739 / FPR 0.184 [0.163-0.207] | F1 0.742 / FPR 0.117 [0.100-0.136] | F1 0.768 / FPR 0.145 [0.126-0.166] |
| v1_unseen_domain | F1 0.773 / FPR 0.020 [0.011-0.035] | F1 0.846 / FPR 0.042 [0.028-0.061] | F1 0.804 / FPR 0.025 [0.015-0.041] | F1 0.841 / FPR 0.030 [0.019-0.047] |

### EXTERNAL_HOLDOUT_2026

| model | BALANCED |
|---|---|
| F006_MODEL | F1 0.954 / FPR 0.015 [0.006-0.034] |
| CANDIDATE_MODEL_V3 | F1 0.952 / FPR 0.009 [0.003-0.026] |
| CANDIDATE_MODEL_V2 | F1 0.694 / FPR 0.009 [0.003-0.026] |
| ENSEMBLE_V2_V3 | F1 0.838 / FPR 0.000 [0.000-0.011] |

## CANDIDATE_MODEL_V4 gates

- PASS A_holdout_human_fpr_le_0.05
- PASS B_unseen_generator_fpr_le_0.10_or_clear_gain
- PASS C_academic_strong
- FAIL D_spanish_strong
- PASS E_mixed_recall_drop_le_5pts
- PASS F_ai_edited_f1_drop_le_5pts
- PASS G_ood_no_severe_drop
- PASS H_zero_width_homoglyph_robust
- PASS I_no_leakage
- PASS J_holdout_never_used_for_tuning
- span token F1 >= 0.88 (recommended): PASS

BEST_BASELINE: its artifact is not on Drive, so it was not re-evaluated in F006.
