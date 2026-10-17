# Training report — Turniting AI Detector V1 (TURNITING_AI_V1)

Generated 2026-10-16T23:11:32Z · commit `e1dd45b5b7` · dataset `TURNITING_DATASET_V1`

> Independent detector. Not a Turnitin model, not equivalent to Turnitin scores. Outputs P(HUMAN)/P(MACHINE).

**Status:** FAIL_WITH_FINDINGS (TRAINING_SUCCESS criteria met; see Findings)  
**Recommended model:** `BEST_BASELINE`

## Hardware

- CPU: AMD Ryzen 7 5700U with Radeon Graphics (8 cores / 16 threads)
- RAM: 12.16 GB
- GPU: none (no CUDA, no MPS); display adapters: ['AMD Radeon(TM) Graphics']
- Disk free before: 73.5 GiB; safe floor: 51.1 GB

## Datasets and licences

| dataset | status | license | valid rows | note |
|---|---|---|---|---|
| iberautextification | DOWNLOADED | CC-BY-NC-ND-4.0 | 153024 |  |
| autextification2023 | DOWNLOADED | CC-BY-NC-SA-4.0 | 107769 |  |
| multitude | BLOCKED_ACCESS | CC-BY-4.0 (per Zenodo metadata) | n/a | Zenodo record 10013755 access_right=restricted; files require owner approval |
| semeval2024_task8 | DOWNLOADED | Not declared on Zenodo/GitHub (public shared-task release for research) | 485047 |  |
| mage | DOWNLOADED | Apache-2.0 | 436606 |  |
| hc3 | DOWNLOADED | CC-BY-SA-4.0 | 85421 |  |
| hc3_chinese | DOWNLOADED | cc-by-sa-4.0 | 38145 |  |
| turingbench | DOWNLOADED | Apache-2.0 | 327984 |  |
| ghostbuster_essay | DOWNLOADED | CC-BY-3.0 | 6994 |  |
| raid | DOWNLOADED | MIT | 322388 |  |
| m4 | DOWNLOADED | Not declared in repository (public research benchmark) | 231750 |  |

RAID: 5,615,820 labelled rows available, stratified sample 322,560 (5.74 %), cap 96 per stratum over 3360 strata (model × domain × attack × decoding × repetition penalty); every attack type equally represented.

## Master dataset

| metric | value |
|---|---|
| rows_original | 2204463 |
| rows_valid | 2195128 |
| exact_duplicates_removed | 625144 |
| near_duplicates_removed | 15795 |
| label_conflicts | 10 |
| holdout_exclusions | 215922 |
| kept_rows | 1338257 |
| human | 437866 |
| machine | 885273 |
| mixed | 15118 |
| spanish | 76540 |
| academic | 114862 |
| groups | 1020386 |
| largest_group | 9419 |

Splits: `{"train": 865590, "test": 201824, "validation": 93894, "unseen_domain_test": 49916, "ood_test": 44406, "unseen_generator_test": 36468, "adversarial_test": 16276, "mixed": 15118, "adversarial_validation": 14765}`

Invalid rows removed: `{"broken_html": 45, "below_min_chars": 1766, "below_min_words": 143, "empty_or_whitespace": 7354, "null": 27}`

### Leakage controls

```json
{
  "groups_spanning_train_and_eval": 0,
  "exact_hashes_spanning_train_and_eval": 0,
  "near_duplicate_pairs_spanning_train_and_eval": 0,
  "result": "PASS"
}
```

### Per-dataset usage

| dataset | available | kept | train pool | used train (baseline) | used train docs (transformers) | validation | test | sampling mass |
|---|---|---|---|---|---|---|---|---|
| autextification2023 | 107868 | 106665 | 52163 | 21823 | 2609 | 6482 | 27917 | 0.2305 |
| ghostbuster_essay | 7000 | 6994 | 5622 | 4240 | 797 | 658 | 714 | 0.0938 |
| hc3 | 85449 | 78531 | 62786 | 5778 | 400 | 7819 | 7926 | 0.0469 |
| hc3_chinese | 39781 | 37403 | 30233 | 2887 | 170 | 3558 | 3612 | 0.0235 |
| iberautextification | 153028 | 123638 | 58629 | 21309 | 2301 | 7354 | 42419 | 0.2181 |
| m4 | 239059 | 27923 | 22266 | 8547 | 737 | 2846 | 2811 | 0.0847 |
| mage | 436606 | 379674 | 247119 | 10315 | 696 | 31233 | 81872 | 0.0815 |
| raid | 322560 | 188849 | 125225 | 10399 | 75 | 1294 | 1369 | 0.1017 |
| semeval2024_task8 | 485128 | 222700 | 128681 | 10959 | 892 | 16421 | 16399 | 0.0879 |
| turingbench | 327984 | 165880 | 132866 | 3743 | 284 | 16229 | 16785 | 0.0313 |

## Baselines

SPANISH_TRAIN_WEIGHT selected on validation: **3.0**

| es weight | val macro F1 | val Spanish macro F1 | objective |
|---|---|---|---|
| 1.0 | 0.8135 | 0.7888 | 0.8012 |
| 1.5 | 0.8121 | 0.8020 | 0.8071 |
| 2.0 | 0.8106 | 0.8068 | 0.8087 |
| 3.0 | 0.8090 | 0.8182 | 0.8136 |

| baseline | val macro F1 | val ES macro F1 | val academic macro F1 | threshold | train s |
|---|---|---|---|---|---|
| tfidf_logreg | 0.8565 | 0.8799 | 0.8477 | 0.5350 | 134.2000 |
| tfidf_svm | 0.8614 | 0.8911 | 0.8588 | 0.5500 | 49.0000 |
| stylometric_gbm | 0.8380 | 0.8331 | 0.8310 | 0.4850 | 4.1000 |
| ensemble_tfidf_stylometric | 0.9053 | 0.9133 | 0.9056 | 0.5250 | 46.6000 |

Best baseline (validation objective): **ensemble_tfidf_stylometric**

### Leave-one-dataset-out (TF-IDF + LR)

| held-out dataset | n | macro F1 | F1 | FPR |
|---|---|---|---|---|
| autextification2023 | 5790 | 0.6129 | 0.5542 | 0.2250 |
| ghostbuster_essay | 643 | 0.6369 | 0.9125 | 0.6989 |
| hc3 | 5374 | 0.8018 | 0.7995 | 0.2442 |
| hc3_chinese | 3361 | 0.3310 | 0.6308 | 0.9840 |
| iberautextification | 5788 | 0.6132 | 0.5752 | 0.2835 |
| m4 | 2586 | 0.6868 | 0.7510 | 0.2936 |
| mage | 6277 | 0.6587 | 0.6560 | 0.3296 |
| raid | 1277 | 0.5420 | 0.8738 | 0.2292 |
| semeval2024_task8 | 6794 | 0.7188 | 0.6856 | 0.1595 |
| turingbench | 3610 | 0.2910 | 0.2257 | 0.0071 |

## Transformer experiments

### `20261015_2102_mdeberta_smoke_v1` (global, smoke)

- model `microsoft/mdeberta-v3-base` @ `a0484667b2`; fallback: None
- windows 1200, epochs 1, lr 5e-05, max_length 256, stride 64, batch 16×2, trainable 28,943,618/278,810,882 params
- train time 0.0 s, stopped at step 38, early stopped: False
- validation macro F1 0.3699, ROC-AUC 0.6752; aggregation mean
- overfitting check: `{"train_loss": 0.6279836906577747, "val_loss": 0.6909489021501074, "train_macro_f1": 0.48412698412698413, "val_macro_f1": 0.36994749562463536, "gap_macro_f1": 0.11417948850234877}`
- checkpoints: best `checkpoints\20261015_2102_mdeberta_smoke_v1\best`, last `checkpoints\20261015_2102_mdeberta_smoke_v1\last`, bytes {'best': 1135946432, 'last': 368094669}

| step | epoch | train loss | val loss | val macro F1 | lr | RSS GB | elapsed s |
|---|---|---|---|---|---|---|---|
| 20 | 0.5260 | 0.6960 | 0.7130 | 0.3333 | 0.0000 | 1.2339 | 464 |
| 38 | 1.0000 | 0.6535 | 0.6818 | 0.3939 | 0.0000 | 0.9991 | 890 |

### `20261016_0845_mdeberta_es_acad_v1` (refine)

- model `microsoft/mdeberta-v3-base` @ `a0484667b2`; fallback: None
- windows 3000, epochs 1, lr 1e-05, max_length 256, stride 64, batch 16×2, trainable 28,943,618/278,810,882 params
- train time 2110.9 s, stopped at step 94, early stopped: False
- validation macro F1 0.7597, ROC-AUC 0.9058; aggregation mean
- overfitting check: `{"train_loss": 0.4846882332770035, "val_loss": 0.5565907514211483, "train_macro_f1": 0.8218039215686275, "val_macro_f1": 0.7597449525119517, "gap_macro_f1": 0.06205896905667574}`
- checkpoints: best `checkpoints\20261016_0845_mdeberta_es_acad_v1\best`, last `checkpoints\20261016_0845_mdeberta_es_acad_v1\last`, bytes {'best': 1135931780, 'last': 368079483}

| step | epoch | train loss | val loss | val macro F1 | lr | RSS GB | elapsed s |
|---|---|---|---|---|---|---|---|
| 94 | 1.0000 | 0.3183 | 0.5740 | 0.7645 | 0.0000 | 1.8843 | 2107 |

### `20261016_0845_mdeberta_v1` (global)

- model `microsoft/mdeberta-v3-base` @ `a0484667b2`; fallback: None
- windows 9000, epochs 2, lr 5e-05, max_length 256, stride 64, batch 16×2, trainable 28,943,618/278,810,882 params
- train time 12256.3 s, stopped at step 564, early stopped: True
- validation macro F1 0.7546, ROC-AUC 0.8925; aggregation mean
- overfitting check: `{"train_loss": 0.2929319407105342, "val_loss": 0.6698793972396783, "train_macro_f1": 0.8997970891054385, "val_macro_f1": 0.754550250359242, "gap_macro_f1": 0.1452468387461966}`
- checkpoints: best `checkpoints\20261016_0845_mdeberta_v1\best`, last `checkpoints\20261016_0845_mdeberta_v1\last`, bytes {'best': 1135946426, 'last': 368095652}

| step | epoch | train loss | val loss | val macro F1 | lr | RSS GB | elapsed s |
|---|---|---|---|---|---|---|---|
| 150 | 0.5320 | 0.5185 | 0.7590 | 0.6999 | 0.0000 | 1.5575 | 3434 |
| 300 | 1.0640 | 0.3673 | 0.7065 | 0.7565 | 0.0000 | 1.5607 | 6592 |
| 450 | 1.5960 | 0.2644 | 0.7352 | 0.7308 | 0.0000 | 1.4770 | 9758 |
| 564 | 2.0000 | 0.2487 | 0.7723 | 0.7354 | 0.0000 | 1.5303 | 12256 |

## Final comparison (TEST-side sets, evaluated once after selection)

### test

| model | n | acc | prec | recall | F1 | macro F1 | ROC-AUC | PR-AUC | FPR | FNR | MCC | ECE | Brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 4000 | 0.8652 | 0.8464 | 0.9094 | 0.8768 | 0.8641 | 0.9462 | 0.9535 | 0.1840 | 0.0906 | 0.7308 | 0.0418 | 0.0973 |
| GLOBAL_MULTILINGUAL_TRANSFORMER | 4000 | 0.7930 | 0.8420 | 0.7477 | 0.7921 | 0.7930 | 0.8768 | 0.8912 | 0.1565 | 0.2523 | 0.5915 | 0.1779 | 0.1987 |
| SPANISH_ACADEMIC_TRANSFORMER | 4000 | 0.7945 | 0.8216 | 0.7795 | 0.8000 | 0.7943 | 0.8787 | 0.8982 | 0.1888 | 0.2205 | 0.5898 | 0.1768 | 0.1950 |
| CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER | 4000 | 0.7947 | 0.8198 | 0.7828 | 0.8009 | 0.7946 | 0.8772 | 0.8837 | 0.1920 | 0.2172 | 0.5900 | 0.0365 | 0.1416 |

### spanish

| model | n | acc | prec | recall | F1 | macro F1 | ROC-AUC | PR-AUC | FPR | FNR | MCC | ECE | Brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 1200 | 0.8517 | 0.8333 | 0.8703 | 0.8514 | 0.8517 | 0.9316 | 0.9269 | 0.1661 | 0.1297 | 0.7041 | 0.0440 | 0.1075 |
| GLOBAL_MULTILINGUAL_TRANSFORMER | 1200 | 0.8042 | 0.8305 | 0.7526 | 0.7896 | 0.8032 | 0.8908 | 0.8736 | 0.1466 | 0.2474 | 0.6099 | 0.1765 | 0.1848 |
| SPANISH_ACADEMIC_TRANSFORMER | 1200 | 0.7917 | 0.7701 | 0.8174 | 0.7930 | 0.7917 | 0.8894 | 0.8790 | 0.2329 | 0.1826 | 0.5847 | 0.2191 | 0.2071 |
| CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER | 1200 | 0.7925 | 0.7705 | 0.8191 | 0.7940 | 0.7925 | 0.8864 | 0.8663 | 0.2329 | 0.1809 | 0.5865 | 0.0619 | 0.1411 |

### academic

| model | n | acc | prec | recall | F1 | macro F1 | ROC-AUC | PR-AUC | FPR | FNR | MCC | ECE | Brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 1000 | 0.9180 | 0.9413 | 0.9191 | 0.9300 | 0.9155 | 0.9776 | 0.9861 | 0.0835 | 0.0809 | 0.8314 | 0.0272 | 0.0570 |
| GLOBAL_MULTILINGUAL_TRANSFORMER | 1000 | 0.7550 | 0.8295 | 0.7386 | 0.7814 | 0.7514 | 0.8275 | 0.8806 | 0.2211 | 0.2614 | 0.5093 | 0.2342 | 0.2521 |
| SPANISH_ACADEMIC_TRANSFORMER | 1000 | 0.7800 | 0.8539 | 0.7589 | 0.8036 | 0.7768 | 0.8721 | 0.9263 | 0.1892 | 0.2411 | 0.5605 | 0.1872 | 0.2002 |
| CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER | 1000 | 0.7800 | 0.8526 | 0.7605 | 0.8039 | 0.7767 | 0.8666 | 0.9113 | 0.1916 | 0.2395 | 0.5599 | 0.0258 | 0.1415 |

### ood

| model | n | acc | prec | recall | F1 | macro F1 | ROC-AUC | PR-AUC | FPR | FNR | MCC | ECE | Brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 1500 | 0.7913 | 0.7532 | 0.8667 | 0.8060 | 0.7901 | 0.9023 | 0.9083 | 0.2840 | 0.1333 | 0.5894 | 0.0892 | 0.1411 |
| GLOBAL_MULTILINGUAL_TRANSFORMER | 1500 | 0.9027 | 0.8595 | 0.9627 | 0.9082 | 0.9023 | 0.9754 | 0.9673 | 0.1573 | 0.0373 | 0.8112 | 0.2422 | 0.1889 |
| SPANISH_ACADEMIC_TRANSFORMER | 1500 | 0.9053 | 0.8568 | 0.9733 | 0.9114 | 0.9049 | 0.9825 | 0.9834 | 0.1627 | 0.0267 | 0.8183 | 0.2216 | 0.1612 |
| CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER | 1500 | 0.9053 | 0.8568 | 0.9733 | 0.9114 | 0.9049 | 0.9795 | 0.9748 | 0.1627 | 0.0267 | 0.8183 | 0.0940 | 0.0753 |

### adversarial

| model | n | acc | prec | recall | F1 | macro F1 | ROC-AUC | PR-AUC | FPR | FNR | MCC | ECE | Brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 2400 | 0.9200 | 0.9758 | 0.9164 | 0.9452 | 0.8986 | 0.9742 | 0.9916 | 0.0690 | 0.0836 | 0.8032 | 0.0475 | 0.0592 |
| GLOBAL_MULTILINGUAL_TRANSFORMER | 2400 | 0.7033 | 0.9628 | 0.6301 | 0.7617 | 0.6844 | 0.8167 | 0.9400 | 0.0741 | 0.3699 | 0.4800 | 0.1677 | 0.1895 |
| SPANISH_ACADEMIC_TRANSFORMER | 2400 | 0.7117 | 0.9492 | 0.6517 | 0.7728 | 0.6891 | 0.8182 | 0.9418 | 0.1061 | 0.3483 | 0.4712 | 0.1450 | 0.1788 |
| CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER | 2400 | 0.7117 | 0.9492 | 0.6517 | 0.7728 | 0.6891 | 0.8156 | 0.9347 | 0.1061 | 0.3483 | 0.4712 | 0.1971 | 0.2062 |

### unseen_generator

| model | n | acc | prec | recall | F1 | macro F1 | ROC-AUC | PR-AUC | FPR | FNR | MCC | ECE | Brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 2400 | 0.7754 | 0.7642 | 0.7967 | 0.7801 | 0.7753 | 0.8665 | 0.8635 | 0.2458 | 0.2033 | 0.5513 | 0.0994 | 0.1608 |
| GLOBAL_MULTILINGUAL_TRANSFORMER | 2400 | 0.7200 | 0.7667 | 0.6325 | 0.6932 | 0.7178 | 0.7881 | 0.8026 | 0.1925 | 0.3675 | 0.4469 | 0.2290 | 0.2582 |
| SPANISH_ACADEMIC_TRANSFORMER | 2400 | 0.7204 | 0.7372 | 0.6850 | 0.7102 | 0.7201 | 0.7797 | 0.7910 | 0.2442 | 0.3150 | 0.4419 | 0.2276 | 0.2580 |
| CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER | 2400 | 0.7221 | 0.7377 | 0.6892 | 0.7126 | 0.7218 | 0.7770 | 0.7684 | 0.2450 | 0.3108 | 0.4451 | 0.0934 | 0.2028 |

### unseen_domain

| model | n | acc | prec | recall | F1 | macro F1 | ROC-AUC | PR-AUC | FPR | FNR | MCC | ECE | Brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 1200 | 0.7817 | 0.7522 | 0.8400 | 0.7937 | 0.7809 | 0.8666 | 0.8784 | 0.2767 | 0.1600 | 0.5672 | 0.0843 | 0.1595 |
| GLOBAL_MULTILINGUAL_TRANSFORMER | 1200 | 0.7325 | 0.8107 | 0.6067 | 0.6940 | 0.7282 | 0.8094 | 0.8314 | 0.1417 | 0.3933 | 0.4805 | 0.1884 | 0.2286 |
| SPANISH_ACADEMIC_TRANSFORMER | 1200 | 0.7458 | 0.7788 | 0.6867 | 0.7298 | 0.7449 | 0.8113 | 0.8523 | 0.1950 | 0.3133 | 0.4951 | 0.1971 | 0.2331 |
| CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER | 1200 | 0.7433 | 0.7734 | 0.6883 | 0.7284 | 0.7426 | 0.8093 | 0.8336 | 0.2017 | 0.3117 | 0.4896 | 0.0730 | 0.1765 |

### Adversarial robustness (RAID; same human pool, clean vs attacked machine text)

**BEST_BASELINE**

| attack | F1 | macro F1 | F1 drop vs clean | machine recall |
|---|---|---|---|---|
| clean | 0.9750 | 0.8741 | n/a | n/a |
| adversarial_all | 0.9561 | 0.6666 | 0.0189 | n/a |
| alternative_spelling | 0.9705 | 0.9407 | 0.0045 | 0.9487 |
| article_deletion | 0.9630 | 0.9281 | 0.0121 | 0.9346 |
| homoglyph | 0.9619 | 0.9276 | 0.0131 | 0.9329 |
| insert_paragraphs | 0.9834 | 0.9659 | -0.0084 | 0.9737 |
| number | 0.9759 | 0.9526 | -0.0009 | 0.9595 |
| paraphrase | 0.8561 | 0.7018 | 0.1190 | 0.7508 |
| perplexity_misspelling | 0.9790 | 0.9589 | -0.0040 | 0.9655 |
| synonym | 0.9695 | 0.9402 | 0.0055 | 0.9470 |
| upper_lower | 0.9693 | 0.9401 | 0.0057 | 0.9467 |
| whitespace | 0.9691 | 0.9400 | 0.0060 | 0.9463 |
| zero_width_space | 0.9662 | 0.9341 | 0.0088 | 0.9408 |

**GLOBAL_MULTILINGUAL_TRANSFORMER**

| attack | F1 | macro F1 | F1 drop vs clean | machine recall |
|---|---|---|---|---|
| clean | 0.8667 | 0.6315 | n/a | n/a |
| adversarial_all | 0.7720 | 0.4428 | 0.0947 | n/a |
| alternative_spelling | 0.8612 | 0.7746 | 0.0055 | 0.7756 |
| article_deletion | 0.8413 | 0.7540 | 0.0254 | 0.7451 |
| homoglyph | 0.1341 | 0.2557 | 0.7326 | 0.0738 |
| insert_paragraphs | 0.8571 | 0.7726 | 0.0096 | 0.7697 |
| number | 0.8441 | 0.7606 | 0.0226 | 0.7500 |
| paraphrase | 0.8725 | 0.7136 | -0.0057 | 0.7841 |
| perplexity_misspelling | 0.8450 | 0.7638 | 0.0218 | 0.7517 |
| synonym | 0.7698 | 0.6835 | 0.0969 | 0.6424 |
| upper_lower | 0.8244 | 0.7380 | 0.0423 | 0.7200 |
| whitespace | 0.8365 | 0.7516 | 0.0302 | 0.7383 |
| zero_width_space | 0.0500 | 0.2057 | 0.8167 | 0.0263 |

**SPANISH_ACADEMIC_TRANSFORMER**

| attack | F1 | macro F1 | F1 drop vs clean | machine recall |
|---|---|---|---|---|
| clean | 0.8761 | 0.6410 | n/a | n/a |
| adversarial_all | 0.7878 | 0.4524 | 0.0883 | n/a |
| alternative_spelling | 0.8780 | 0.7920 | -0.0019 | 0.8077 |
| article_deletion | 0.8509 | 0.7615 | 0.0252 | 0.7647 |
| homoglyph | 0.2093 | 0.2956 | 0.6668 | 0.1208 |
| insert_paragraphs | 0.8746 | 0.7902 | 0.0016 | 0.8026 |
| number | 0.8409 | 0.7538 | 0.0352 | 0.7500 |
| paraphrase | 0.8688 | 0.7053 | 0.0074 | 0.7807 |
| perplexity_misspelling | 0.8593 | 0.7768 | 0.0168 | 0.7793 |
| synonym | 0.7907 | 0.6997 | 0.0854 | 0.6755 |
| upper_lower | 0.8302 | 0.7407 | 0.0459 | 0.7333 |
| whitespace | 0.8550 | 0.7690 | 0.0211 | 0.7718 |
| zero_width_space | 0.0970 | 0.2287 | 0.7792 | 0.0526 |

**CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER**

| attack | F1 | macro F1 | F1 drop vs clean | machine recall |
|---|---|---|---|---|
| clean | 0.8764 | 0.6382 | n/a | n/a |
| adversarial_all | 0.7876 | 0.4510 | 0.0888 | n/a |
| alternative_spelling | 0.8750 | 0.7850 | 0.0014 | 0.8077 |
| article_deletion | 0.8478 | 0.7546 | 0.0286 | 0.7647 |
| homoglyph | 0.2081 | 0.2913 | 0.6683 | 0.1208 |
| insert_paragraphs | 0.8714 | 0.7832 | 0.0050 | 0.8026 |
| number | 0.8377 | 0.7469 | 0.0386 | 0.7500 |
| paraphrase | 0.8672 | 0.6998 | 0.0092 | 0.7807 |
| perplexity_misspelling | 0.8561 | 0.7697 | 0.0203 | 0.7793 |
| synonym | 0.7876 | 0.6931 | 0.0887 | 0.6755 |
| upper_lower | 0.8271 | 0.7338 | 0.0493 | 0.7333 |
| whitespace | 0.8519 | 0.7620 | 0.0245 | 0.7718 |
| zero_width_space | 0.0964 | 0.2249 | 0.7800 | 0.0526 |

## Calibration

Selected: **isotonic** (lowest 3-fold cross-validated ECE on VALIDATION (tie-break Brier))

```json
{
  "ece_before": 0.15469476024940618,
  "ece_after": 9.64042575090323e-17,
  "brier_before": 0.16824133059570837,
  "brier_after": 0.11859696229512273
}
```

CV report:

```json
{
  "none": {
    "cv_ece": 0.15469476024940618,
    "cv_brier": 0.16824133059570837
  },
  "temperature": {
    "cv_ece": 0.15632459801885237,
    "cv_brier": 0.15541764955418916
  },
  "platt": {
    "cv_ece": 0.04971062917678482,
    "cv_brier": 0.12691842290455035
  },
  "isotonic": {
    "cv_ece": 0.02323194035329546,
    "cv_brier": 0.12318781295395859
  }
}
```

Reliability-diagram data: `reports/reliability_diagram.csv`.

## Artifacts

| model | path | MB |
|---|---|---|
| BEST_BASELINE | models/baseline/best | 51.8000 |
| GLOBAL_MULTILINGUAL_TRANSFORMER | models/transformer/global | 0.0000 |
| SPANISH_ACADEMIC_TRANSFORMER | models/transformer/spanish_academic | 0.0000 |
| CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER | models/calibrated/spanish_academic | 0.0000 |


## Model selection

Chosen on VALIDATION only (`reports/model_selection.json`): primary = mean(validation Spanish macro F1,
validation academic macro F1), FPR guard (≤ best FPR + 0.02), ties within 0.01 broken by validation
ECE. **BEST_BASELINE (stacked TF-IDF LR/SVM + stylometric GBM)** wins clearly (primary 0.909 vs
0.835 for the best transformer) with the lowest validation FPR (0.082). The best transformer
variant, `CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER`, is stored in `models/transformer/best/`.

## Findings

1. **Leakage controls hold**: 0 groups, 0 exact hashes and 0 near-duplicate pairs span train and
   evaluation splits after grouping 2.2 M rows into 1.02 M source groups.
2. **Cross-dataset generalisation is the main weakness.** Leave-one-dataset-out macro F1 for the
   TF-IDF baseline ranges 0.29 (TuringBench) – 0.80 (HC3), mean 0.59. In-distribution test scores
   (0.86 macro F1) overstate real-world accuracy.
3. **High false-positive rates out of distribution**: baseline FPR 0.18 on test, 0.28 on OOD, 0.25 on
   unseen generators, 0.28 on unseen domains. At the BALANCED threshold, roughly 1 in 4–5 human
   texts from unseen sources would be flagged. Use `LOW_FALSE_POSITIVE` for any user-facing decision.
4. **The CPU-budget transformer underperforms the baseline in-distribution** (test macro F1 0.79 vs
   0.86) but **generalises better to the SemEval/MAGE OOD set** (0.90 vs 0.79) and is far more robust
   to **paraphrase** (F1 drop 0.007 vs 0.119 for the baseline).
5. **Transformer collapses under character-level attacks**: on RAID homoglyph and zero-width-space
   attacks, machine recall falls to ~0.1 (F1 0.13–0.21), because those characters fragment the
   SentencePiece tokenization. The baseline (char n-grams) is robust to them. A canonicalisation
   pre-step for *inference* (map confusables, strip zero-width) is the obvious mitigation and must
   be evaluated separately on the adversarial split.
6. **Overfitting**: global transformer train macro F1 0.90 vs validation 0.75 (gap 0.15; train loss
   0.29 vs val loss 0.67); best checkpoint at step 300 of 564, later evaluations declined and early
   stopping triggered. The Spanish/academic refinement narrowed the gap (0.82 vs 0.76).
7. **Spanish refinement** improved validation Spanish macro F1 0.848 → 0.853 and academic
   0.770 → 0.817; on test, academic macro F1 rose 0.751 → 0.777 while Spanish dipped 0.803 → 0.792
   with a higher FPR. Effect is small at this training budget.
8. **Calibration**: isotonic chosen by 3-fold CV ECE on validation (CV ECE 0.155 → 0.023, CV Brier
   0.168 → 0.123). In-sample validation ECE after isotonic is ~0 by construction — the CV figures are
   the honest ones. On test, ECE fell 0.177 → 0.037 with unchanged ranking (ROC-AUC 0.879 → 0.877).
9. `SPANISH_TRAIN_WEIGHT` = 3.0 was selected on validation (Spanish macro F1 0.789 → 0.818 for
   −0.005 global macro F1).

10. **Bug found in the CPU transformer runs (fixed for the next run):** the weighted document sample
    was iterated in storage order and cut at the 9,000-window budget, so datasets stored last were
    under-represented — RAID contributed **0** documents to the global transformer (75 to the
    refinement) and TuringBench/HC3 very few. Baselines are not affected (they use the whole
    sample). `train_transformer.py` now shuffles the sample before windowing; the transformer
    numbers above are therefore a pessimistic, non-representative CPU baseline and part of why the
    adversarial (RAID) scores are low.

## Warnings

* MULTITuDE (mandatory) could not be used: the Zenodo record is access-restricted and needs the
  owners' approval; no official open mirror exists.
* IberAuTexTification (CC BY-NC-ND) and AuTexTification (CC BY-NC-SA) are non-commercial: models
  trained with them are research artefacts until the organizers grant permission. SemEval-2024 and
  M4 publish no explicit licence.
* RAID used a 5.74 % stratified sample (322,560 of 5,615,820 rows); the raw 11.8 GB CSV was deleted
  after sampling to respect the disk floor (sha256 kept; re-downloadable).
* The ensemble baseline in the first baseline run was mis-specified (one saga LogReg over TF-IDF +
  raw-scale stylometric columns, val macro F1 0.684). It was replaced by a stacked LogReg trained on a
  disjoint TRAIN sample before any model selection; only validation was used to compare.
* The smoke experiment's `experiment.json` was overwritten by the resume test (train_seconds 0).

## Limitations

* No GPU: the transformer used frozen embeddings + 8 frozen layers, 256-token windows, 9,000
  training windows and 2 epochs — a small fraction of the spec's recipe (512 tokens, all layers,
  full data, 3 epochs). `configs/training_gpu.yaml` + `notebooks/colab_train.ipynb` run the full
  recipe on the same splits and frozen evaluation sets.
* Transformer evaluation sets are capped (test 4,000; OOD 1,500; adversarial 2,400; unseen sets
  1,200–2,400 docs) for CPU inference time; baselines were additionally scored on 40k-row sets.
* Unseen-generator holdout = Mistral + Cohere families; unseen-domain holdout = reviews + recipes.
  Academic text was not held out because it is the target domain.
* Model outputs are P(HUMAN)/P(MACHINE) on public-benchmark distributions. They are **not**
  calibrated against Turnitin reports and must not be presented as Turnitin-equivalent scores.
  `VALIDATION_CASE_001` and real Turnitin reports were not used anywhere.
