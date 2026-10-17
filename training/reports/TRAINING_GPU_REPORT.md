# GPU training report — Turniting AI Detector V1 (TURNITING_AI_V1)

Independent detector; not a Turnitin model. Outputs P(HUMAN)/P(MACHINE). No Turnitin reports, VALIDATION_CASE_001 or private documents were used.

**Status:** PASS (pipeline reproducible, splits identical to the CPU run, leakage 0, training converged, full evaluation, artifacts persisted in Google Drive)  
**Validation winner:** `GPU_CALIBRATED` (CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER_GPU) -> **CANDIDATE_MODEL_V2** (not wired into the backend).

The CPU run (`TRAINING_REPORT.md`) is kept unchanged as provisional evidence.

## Environment

- Google Colab Pro, NVIDIA A100-SXM4-40GB (42.41 GB), CUDA 13.0, bf16 autocast; torch 2.11, transformers 4.46.3
- Code: branch `exp/ai-detector-training` (training at commit 3415eb2; notebook `training/notebooks/colab_train.ipynb`)
- Dataset rebuilt on Colab from the official sources with the same scripts and seed: split and status counts are **identical** to the CPU run (865,590 train / 93,894 validation / 201,824 test ...); leakage checks 0/0/0 -> PASS; same frozen evaluation ids.

## Sampling audit (bug fixed)

- Global: 148,344 windows (120,000 docs); RAID 17,066; Spanish 29,215; academic 21,332; all 10 datasets present.
- Refinement: 30,000 windows (70 % Spanish/academic, 30 % replay); RAID 2,666; Spanish 12,230; academic 8,845.

## Training

| experiment | windows | epochs planned | steps | stopped at | early stop | best | train time | lr | trainable params |
|---|---|---|---|---|---|---|---|---|---|
| 20261017_0117_mdeberta_gpu_v1 (global) | 148,344 | 3 | 13,908 | 4000 (epoch 0.86) | yes | step 2000 (epoch 0.43) | 35.5 min | 2e-5 | 278,810,882 |
| 20261017_0117_mdeberta_gpu_es_acad_v1 (refine) | 30,000 | 1 | 938 | 938 | no | step 938 | 8.4 min | 1e-5 | 278,810,882 |

512 tokens, stride 128, batch 32x1, warmup 6 %, weight decay 0.01, document score = mean of window log-odds (chosen on validation), peak GPU memory 25.5 GB.

Global validation history (900 docs, threshold 0.5): step 1000: macro F1 0.7951, val loss 0.5362, train loss 0.427; step 2000: macro F1 0.8911, val loss 0.3052, train loss 0.2359; step 3000: macro F1 0.8661, val loss 0.3757, train loss 0.1876; step 4000: macro F1 0.8636, val loss 0.3613, train loss 0.1705

Overfitting check: global train macro F1 0.9111 vs val 0.8892 (gap 0.0218); refine 0.8575 vs 0.8542 (gap 0.0033). No strong divergence.

## Calibration (VALIDATION only)

Isotonic selected by 3-fold CV ECE: none 0.1306, temperature 0.1365, Platt 0.0302, **isotonic 0.0235** (CV Brier 0.1130 -> 0.0569). In-sample ECE after isotonic is ~0 by construction; the CV figures are the honest ones.

Thresholds (validation): global: BALANCED=0.93, LOW_FALSE_POSITIVE=0.99, HIGH_PRECISION_AI=0.965; spanish_academic: BALANCED=0.985, LOW_FALSE_POSITIVE=0.99, HIGH_PRECISION_AI=0.99; calibrated_spanish_academic: BALANCED=0.505, LOW_FALSE_POSITIVE=0.875, HIGH_PRECISION_AI=0.585

## Model selection (VALIDATION)

Rule: primary = mean(validation Spanish macro F1, validation academic macro F1); FPR guard <= min + 0.02; ties within 0.01 -> lower ECE, then FPR.

### validation

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 900 | 0.9189 | 0.9216 | 0.9196 | 0.9206 | 0.9189 | 0.9749 | 0.9785 | 0.0818 | 0.0804 | 0.8377 | 0.0281 | 0.0627 |
| CPU_CALIBRATED | 900 | 0.8189 | 0.8596 | 0.7717 | 0.8133 | 0.8187 | 0.9055 | 0.9149 | 0.1318 | 0.2283 | 0.6419 | 0.0241 | 0.1218 |
| GPU_GLOBAL | 900 | 0.9222 | 0.9239 | 0.9239 | 0.9239 | 0.9222 | 0.9804 | 0.9821 | 0.0795 | 0.0761 | 0.8444 | 0.0906 | 0.0839 |
| GPU_SPANISH_ACADEMIC | 900 | 0.9222 | 0.9295 | 0.9174 | 0.9234 | 0.9222 | 0.9808 | 0.982 | 0.0727 | 0.0826 | 0.8445 | 0.1222 | 0.1065 |
| GPU_CALIBRATED | 900 | 0.9233 | 0.9316 | 0.9174 | 0.9244 | 0.9233 | 0.9819 | 0.9805 | 0.0705 | 0.0826 | 0.8467 | 0.0081 | 0.0527 |

### validation_spanish

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 450 | 0.9133 | 0.9279 | 0.8996 | 0.9135 | 0.9133 | 0.9724 | 0.9695 | 0.0724 | 0.1004 | 0.8271 | 0.0364 | 0.0623 |
| CPU_CALIBRATED | 450 | 0.8533 | 0.8863 | 0.8166 | 0.85 | 0.8533 | 0.9395 | 0.9391 | 0.1086 | 0.1834 | 0.7093 | 0.0395 | 0.0996 |
| GPU_GLOBAL | 450 | 0.9244 | 0.9577 | 0.8908 | 0.9231 | 0.9244 | 0.9814 | 0.9836 | 0.0407 | 0.1092 | 0.8512 | 0.0668 | 0.0676 |
| GPU_SPANISH_ACADEMIC | 450 | 0.9178 | 0.9486 | 0.8865 | 0.9165 | 0.9178 | 0.9822 | 0.9849 | 0.0498 | 0.1135 | 0.8376 | 0.097 | 0.086 |
| GPU_CALIBRATED | 450 | 0.9178 | 0.9528 | 0.8821 | 0.9161 | 0.9177 | 0.9833 | 0.9839 | 0.0452 | 0.1179 | 0.8381 | 0.0341 | 0.0511 |

### validation_academic

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 450 | 0.9067 | 0.9084 | 0.9231 | 0.9157 | 0.9056 | 0.9721 | 0.9814 | 0.1133 | 0.0769 | 0.8113 | 0.0533 | 0.0662 |
| CPU_CALIBRATED | 450 | 0.8156 | 0.8661 | 0.7854 | 0.8238 | 0.8152 | 0.8848 | 0.9137 | 0.1478 | 0.2146 | 0.6346 | 0.0443 | 0.1288 |
| GPU_GLOBAL | 450 | 0.9244 | 0.9383 | 0.9231 | 0.9306 | 0.9238 | 0.9765 | 0.9827 | 0.0739 | 0.0769 | 0.8478 | 0.1179 | 0.1015 |
| GPU_SPANISH_ACADEMIC | 450 | 0.9356 | 0.9431 | 0.9393 | 0.9412 | 0.935 | 0.9822 | 0.9869 | 0.069 | 0.0607 | 0.8699 | 0.1733 | 0.1419 |
| GPU_CALIBRATED | 450 | 0.9378 | 0.9469 | 0.9393 | 0.9431 | 0.9372 | 0.9822 | 0.9851 | 0.064 | 0.0607 | 0.8745 | 0.0278 | 0.0527 |

Primary: BEST_BASELINE 0.9095; GPU_GLOBAL 0.9241; GPU_SPANISH_ACADEMIC 0.9264; **GPU_CALIBRATED 0.9275** (also lowest validation FPR 0.0705 and ECE 0.0081) -> winner.

## Final evaluation (TEST-side, run once after selection)

### test

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 4000 | 0.8652 | 0.8464 | 0.9094 | 0.8768 | 0.8641 | 0.9462 | 0.9535 | 0.184 | 0.0906 | 0.7308 | 0.0418 | 0.0973 |
| CPU_GLOBAL | 4000 | 0.793 | 0.842 | 0.7477 | 0.7921 | 0.793 | 0.8768 | 0.8912 | 0.1565 | 0.2523 | 0.5915 | 0.1779 | 0.1987 |
| CPU_CALIBRATED | 4000 | 0.7947 | 0.8198 | 0.7828 | 0.8009 | 0.7946 | 0.8772 | 0.8837 | 0.192 | 0.2172 | 0.59 | 0.0365 | 0.1416 |
| GPU_GLOBAL | 4000 | 0.895 | 0.8886 | 0.9156 | 0.9019 | 0.8945 | 0.9608 | 0.9585 | 0.128 | 0.0844 | 0.7894 | 0.126 | 0.1165 |
| GPU_SPANISH_ACADEMIC | 4000 | 0.8888 | 0.8782 | 0.9161 | 0.8967 | 0.8881 | 0.9572 | 0.9525 | 0.1417 | 0.0839 | 0.7771 | 0.179 | 0.1595 |
| GPU_CALIBRATED | 4000 | 0.8895 | 0.8836 | 0.9104 | 0.8968 | 0.8889 | 0.9568 | 0.9498 | 0.1338 | 0.0896 | 0.7784 | 0.0356 | 0.0819 |

### test_spanish

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 1200 | 0.8517 | 0.8333 | 0.8703 | 0.8514 | 0.8517 | 0.9316 | 0.9269 | 0.1661 | 0.1297 | 0.7041 | 0.044 | 0.1075 |
| CPU_GLOBAL | 1200 | 0.8042 | 0.8305 | 0.7526 | 0.7896 | 0.8032 | 0.8908 | 0.8736 | 0.1466 | 0.2474 | 0.6099 | 0.1765 | 0.1848 |
| CPU_CALIBRATED | 1200 | 0.7925 | 0.7705 | 0.8191 | 0.794 | 0.7925 | 0.8864 | 0.8663 | 0.2329 | 0.1809 | 0.5865 | 0.0619 | 0.1411 |
| GPU_GLOBAL | 1200 | 0.87 | 0.8479 | 0.8942 | 0.8704 | 0.87 | 0.9417 | 0.9246 | 0.1531 | 0.1058 | 0.7412 | 0.1413 | 0.1371 |
| GPU_SPANISH_ACADEMIC | 1200 | 0.8675 | 0.8483 | 0.8874 | 0.8674 | 0.8675 | 0.9369 | 0.9204 | 0.1515 | 0.1126 | 0.7359 | 0.1833 | 0.1728 |
| GPU_CALIBRATED | 1200 | 0.8692 | 0.8534 | 0.884 | 0.8684 | 0.8692 | 0.9369 | 0.9168 | 0.145 | 0.116 | 0.7389 | 0.0565 | 0.1015 |

### test_academic

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 1000 | 0.918 | 0.9413 | 0.9191 | 0.93 | 0.9155 | 0.9776 | 0.9861 | 0.0835 | 0.0809 | 0.8314 | 0.0272 | 0.057 |
| CPU_GLOBAL | 1000 | 0.755 | 0.8295 | 0.7386 | 0.7814 | 0.7514 | 0.8275 | 0.8806 | 0.2211 | 0.2614 | 0.5093 | 0.2342 | 0.2521 |
| CPU_CALIBRATED | 1000 | 0.78 | 0.8526 | 0.7605 | 0.8039 | 0.7767 | 0.8666 | 0.9113 | 0.1916 | 0.2395 | 0.5599 | 0.0258 | 0.1415 |
| GPU_GLOBAL | 1000 | 0.891 | 0.9172 | 0.8971 | 0.9071 | 0.8876 | 0.9606 | 0.9765 | 0.1179 | 0.1029 | 0.7756 | 0.1061 | 0.1126 |
| GPU_SPANISH_ACADEMIC | 1000 | 0.909 | 0.9226 | 0.9241 | 0.9233 | 0.9057 | 0.9757 | 0.9849 | 0.113 | 0.0759 | 0.8114 | 0.1686 | 0.1407 |
| GPU_CALIBRATED | 1000 | 0.912 | 0.9272 | 0.9241 | 0.9257 | 0.9089 | 0.975 | 0.9822 | 0.1057 | 0.0759 | 0.8178 | 0.0326 | 0.0645 |

### ood

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 1500 | 0.7913 | 0.7532 | 0.8667 | 0.806 | 0.7901 | 0.9023 | 0.9083 | 0.284 | 0.1333 | 0.5894 | 0.0892 | 0.1411 |
| CPU_GLOBAL | 1500 | 0.9027 | 0.8595 | 0.9627 | 0.9082 | 0.9023 | 0.9754 | 0.9673 | 0.1573 | 0.0373 | 0.8112 | 0.2422 | 0.1889 |
| CPU_CALIBRATED | 1500 | 0.9053 | 0.8568 | 0.9733 | 0.9114 | 0.9049 | 0.9795 | 0.9748 | 0.1627 | 0.0267 | 0.8183 | 0.094 | 0.0753 |
| GPU_GLOBAL | 1500 | 0.8867 | 0.8201 | 0.9907 | 0.8973 | 0.8854 | 0.9865 | 0.9874 | 0.2173 | 0.0093 | 0.7906 | 0.2267 | 0.1818 |
| GPU_SPANISH_ACADEMIC | 1500 | 0.8607 | 0.7869 | 0.9893 | 0.8766 | 0.8583 | 0.9818 | 0.9832 | 0.268 | 0.0107 | 0.7465 | 0.2778 | 0.2435 |
| GPU_CALIBRATED | 1500 | 0.8633 | 0.7908 | 0.988 | 0.8785 | 0.8612 | 0.9796 | 0.9742 | 0.2613 | 0.012 | 0.7504 | 0.1441 | 0.111 |

### adversarial

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 2400 | 0.92 | 0.9758 | 0.9164 | 0.9452 | 0.8986 | 0.9742 | 0.9916 | 0.069 | 0.0836 | 0.8032 | 0.0475 | 0.0592 |
| CPU_GLOBAL | 2400 | 0.7033 | 0.9628 | 0.6301 | 0.7617 | 0.6844 | 0.8167 | 0.94 | 0.0741 | 0.3699 | 0.48 | 0.1677 | 0.1895 |
| CPU_CALIBRATED | 2400 | 0.7117 | 0.9492 | 0.6517 | 0.7728 | 0.6891 | 0.8156 | 0.9347 | 0.1061 | 0.3483 | 0.4712 | 0.1971 | 0.2062 |
| GPU_GLOBAL | 2400 | 0.8525 | 0.9481 | 0.8505 | 0.8967 | 0.8195 | 0.9463 | 0.9821 | 0.1414 | 0.1495 | 0.6533 | 0.0681 | 0.0901 |
| GPU_SPANISH_ACADEMIC | 2400 | 0.835 | 0.956 | 0.8184 | 0.8819 | 0.8042 | 0.9405 | 0.9803 | 0.1145 | 0.1816 | 0.6345 | 0.0825 | 0.101 |
| GPU_CALIBRATED | 2400 | 0.8337 | 0.9571 | 0.8156 | 0.8807 | 0.8032 | 0.9398 | 0.9773 | 0.1111 | 0.1844 | 0.6339 | 0.0916 | 0.1089 |

### unseen_generator

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 2400 | 0.7754 | 0.7642 | 0.7967 | 0.7801 | 0.7753 | 0.8665 | 0.8635 | 0.2458 | 0.2033 | 0.5513 | 0.0994 | 0.1608 |
| CPU_GLOBAL | 2400 | 0.72 | 0.7667 | 0.6325 | 0.6932 | 0.7178 | 0.7881 | 0.8026 | 0.1925 | 0.3675 | 0.4469 | 0.229 | 0.2582 |
| CPU_CALIBRATED | 2400 | 0.7221 | 0.7377 | 0.6892 | 0.7126 | 0.7218 | 0.777 | 0.7684 | 0.245 | 0.3108 | 0.4451 | 0.0934 | 0.2028 |
| GPU_GLOBAL | 2400 | 0.7929 | 0.7946 | 0.79 | 0.7923 | 0.7929 | 0.8706 | 0.8449 | 0.2042 | 0.21 | 0.5858 | 0.1692 | 0.1883 |
| GPU_SPANISH_ACADEMIC | 2400 | 0.7908 | 0.7884 | 0.795 | 0.7917 | 0.7908 | 0.8654 | 0.8449 | 0.2133 | 0.205 | 0.5817 | 0.224 | 0.2283 |
| GPU_CALIBRATED | 2400 | 0.79 | 0.7915 | 0.7875 | 0.7895 | 0.79 | 0.8642 | 0.8347 | 0.2075 | 0.2125 | 0.58 | 0.1171 | 0.1631 |

### unseen_domain

| model | n | accuracy | precision | recall | f1 | macro_f1 | roc_auc | pr_auc | fpr | fnr | mcc | ece | brier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BEST_BASELINE | 1200 | 0.7817 | 0.7522 | 0.84 | 0.7937 | 0.7809 | 0.8666 | 0.8784 | 0.2767 | 0.16 | 0.5672 | 0.0843 | 0.1595 |
| CPU_GLOBAL | 1200 | 0.7325 | 0.8107 | 0.6067 | 0.694 | 0.7282 | 0.8094 | 0.8314 | 0.1417 | 0.3933 | 0.4805 | 0.1884 | 0.2286 |
| CPU_CALIBRATED | 1200 | 0.7433 | 0.7734 | 0.6883 | 0.7284 | 0.7426 | 0.8093 | 0.8336 | 0.2017 | 0.3117 | 0.4896 | 0.073 | 0.1765 |
| GPU_GLOBAL | 1200 | 0.8233 | 0.8119 | 0.8417 | 0.8265 | 0.8233 | 0.9134 | 0.93 | 0.195 | 0.1583 | 0.6471 | 0.2149 | 0.2055 |
| GPU_SPANISH_ACADEMIC | 1200 | 0.7967 | 0.7781 | 0.83 | 0.8032 | 0.7964 | 0.8993 | 0.9173 | 0.2367 | 0.17 | 0.5947 | 0.2783 | 0.2691 |
| GPU_CALIBRATED | 1200 | 0.8042 | 0.7911 | 0.8267 | 0.8085 | 0.8041 | 0.8989 | 0.9068 | 0.2183 | 0.1733 | 0.609 | 0.0932 | 0.139 |

### Unseen generator families (machine recall / F1)

| model | cohere | mistral |
|---|---|---|
| BEST_BASELINE | 0.7597 / 0.8635 | 0.8521 / 0.9201 |
| GPU_CALIBRATED | 0.7611 / 0.8644 | 0.8271 / 0.9054 |
| GPU_GLOBAL | 0.7375 / 0.8489 | 0.8688 / 0.9298 |

### Adversarial robustness (RAID; F1 / machine recall; same human pool)

| attack | BEST_BASELINE | GPU_GLOBAL | GPU_SPANISH_ACADEMIC | GPU_CALIBRATED |
|---|---|---|---|---|
| clean | 0.975 / None | 0.9657 / None | 0.9761 / None | 0.9752 / None |
| adversarial_all | 0.9561 / None | 0.9178 / None | 0.899 / None | 0.8973 / None |
| alternative_spelling | 0.9705 / 0.9487 | 0.9545 / 0.9423 | 0.9677 / 0.9615 | 0.9644 / 0.9551 |
| article_deletion | 0.963 / 0.9346 | 0.9396 / 0.915 | 0.9568 / 0.9412 | 0.9568 / 0.9412 |
| homoglyph | 0.9619 / 0.9329 | 0.88 / 0.8121 | 0.5899 / 0.4295 | 0.5833 / 0.4228 |
| insert_paragraphs | 0.9834 / 0.9737 | 0.9671 / 0.9671 | 0.9737 / 0.9737 | 0.9737 / 0.9737 |
| number | 0.9759 / 0.9595 | 0.9521 / 0.9392 | 0.973 / 0.973 | 0.973 / 0.973 |
| paraphrase | 0.8561 / 0.7508 | 0.8973 / 0.8272 | 0.9165 / 0.8571 | 0.9165 / 0.8571 |
| perplexity_misspelling | 0.979 / 0.9655 | 0.951 / 0.9379 | 0.9653 / 0.9586 | 0.9617 / 0.9517 |
| synonym | 0.9695 / 0.947 | 0.9167 / 0.8742 | 0.942 / 0.9139 | 0.9347 / 0.9007 |
| upper_lower | 0.9693 / 0.9467 | 0.9347 / 0.9067 | 0.9416 / 0.9133 | 0.9416 / 0.9133 |
| whitespace | 0.9691 / 0.9463 | 0.9559 / 0.9463 | 0.9766 / 0.9799 | 0.9766 / 0.9799 |
| zero_width_space | 0.9662 / 0.9408 | 0.4683 / 0.3158 | 0.1205 / 0.0658 | 0.1205 / 0.0658 |

## Comparison

| question | answer |
|---|---|
| GPU Transformer > BEST_BASELINE on validation? | **Yes** (primary 0.9275 vs 0.9095; FPR 0.071 vs 0.082) |
| Winner on TEST (macro F1) | GPU_CALIBRATED 0.889 vs baseline 0.864 (FPR 0.134 vs 0.184) |
| Spanish test | GPU_CALIBRATED 0.869 vs 0.852 (FPR 0.145 vs 0.166) |
| Academic test | baseline 0.916 vs GPU_CALIBRATED 0.909 (FPR 0.084 vs 0.106): baseline slightly better |
| OOD | GPU_CALIBRATED 0.861 vs baseline 0.790 (CPU transformer 0.905; GPU_GLOBAL 0.885) |
| Unseen generator / domain | GPU_CALIBRATED 0.790 / 0.804 vs baseline 0.775 / 0.781 |
| Adversarial | baseline 0.899 vs GPU_CALIBRATED 0.803: transformer still collapses on zero-width (F1 0.12) and homoglyph (0.58); better on paraphrase (0.917 vs 0.856) |

## Findings

1. With the full GPU recipe and the sampling bug fixed, the transformer beats the baseline on validation and on most test sets (overall, Spanish, OOD, unseen generators/domains) with a lower FPR. It is marked CANDIDATE_MODEL_V2; the backend is not changed.
2. Early stopping (patience 2, evaluated every 1000 steps on 900 docs) stopped the global run at epoch 0.86 of 3; the best checkpoint is at epoch 0.43. The 900-doc validation is noisy; a larger validation set or patience is a cheap next experiment.
3. Character-level attacks remain the main weakness: zero-width-space machine recall 0.07 and homoglyph 0.42 for the calibrated model (global model: 0.32 / 0.81). The Spanish/academic refinement made this worse. An inference-time canonicalisation step (strip zero-width, map confusables) or a baseline+transformer ensemble should be evaluated next; neither was added here.
4. Academic text: the baseline remains marginally better on test (0.916 vs 0.909) even though the transformer wins academic validation (0.937 vs 0.906).
5. OOD FPR is still high for every model (0.21-0.28): human texts from unseen sources are often flagged at BALANCED; use LOW_FALSE_POSITIVE for any user-facing decision.

## Artifacts (Google Drive, MyDrive/turniting/workdir)

- checkpoints/20261017_0117_mdeberta_gpu_v1/{best,last} (1.14 GB / 3.37 GB)
- checkpoints/20261017_0117_mdeberta_gpu_es_acad_v1/{best,last} (1.14 GB / 3.37 GB)
- models/gpu/global, models/gpu/spanish_academic, models/gpu/calibrated_spanish_academic (config, tokenizer, weights, thresholds, manifest; calibration.json in the calibrated one)
- reports/eval/*GPU*.json, high-confidence FP/FN lists, TRAINING_GPU_REPORT.json (full), logs/
