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
