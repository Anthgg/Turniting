# TURNITING_RESEARCH_V3 — training report (summary)

Full machine-generated report and evaluation JSON live in Google Drive:
`MyDrive/turniting/v3/reports/TRAINING_V3_REPORT.md`, `TRAINING_V3_REPORT.json`, `reports/eval/v3_evaluation.json`.
Pipeline: `training/notebooks/colab_v3.ipynb` → `training/scripts/v3_pipeline.sh` (Colab A100, 2026-10-17).

Independent research detector, research / non-commercial use only. Not a Turnitin model. No Turnitin reports,
VALIDATION_CASE_001 or private documents were used for training, tuning, calibration or thresholds.
CANDIDATE_MODEL_V2 (`MyDrive/turniting/workdir/models/gpu/calibrated_spanish_academic`) is untouched.

## Dataset V2

| | |
|---|---:|
| rows kept | 4,303,857 (V1 1,338,257 + new 2,965,600) |
| human / AI-generated+paraphrased / mixed / AI-edited | 1,316,737 / 2,261,144 / 221,480 / 504,496 |
| span-labelled rows | 227,532 |
| Spanish / academic | 126,379 / 1,701,181 |
| languages / generator families | 27 / 39 |
| exact / near duplicates removed | 840,042 / 82,946 |
| leakage (exact, near, group, parent/child) | 0 / 0 / 0 / 0 — PASS |
| validation V2 | 20,000 docs (+5k Spanish, +5k academic) |

Downloaded: MGTBench 2.0 (AI_Polish_clean), DetectRL-X, OpAI-Bench, Heterogeneous AI Spans, Academic arXiv/GPT/Gemini,
Nigerian Academic, AIGTxt (dataset holdout), GRADTEX, TXD-22, Beemo, MDTA, OUTFOX, COLING 2025 MGT en, OpenLLMText,
SeqXGPT, AI Text Detection Benchmark 2026 (external holdout only).
Blocked: MGTPD and EditLens (gated, no HF token granted), MultiSocial (restricted on Zenodo).
First build found 283 train/eval groups joined only through excluded bridge rows; fixed (`4f4cfbb`) and rebuilt
before any training.

## Training

| | GLOBAL | SPANISH_ACADEMIC refinement |
|---|---|---|
| windows | 1,000,000 (dual raw/canonical view + 10 % synthetic zero-width/homoglyph/whitespace) | 200,000 (70 % es/academic/mixed/edited, 30 % replay) |
| sampling weights (chosen on validation V2) | Spanish 3.0, academic 1.25 | same |
| micro-batch (auto-batch, A100 40 GB) | 48 (64 OOM), bf16 | 48 |
| GPU utilisation / VRAM | mean 95.9 %, ~37 GB | mean 89.7 % |
| stop | early stopping at step 27,500 (1.32 epochs); best step 15,000 | 1 epoch |
| duration | 4.14 h | 0.71 h |

## Results (positive = any AI involvement; each model at its own validation-chosen BALANCED threshold)

| set | CANDIDATE_MODEL_V2 | V3 SPANISH_ACADEMIC (selected) |
|---|---:|---:|
| validation V2 primary (model choice) | 0.792 | 0.932 |
| test V2 macro F1 / AUC / FPR | 0.744 / 0.846 / 0.162 | 0.879 / 0.953 / 0.158 |
| Spanish test V2 | 0.778 | 0.893 |
| academic test V2 (FPR) | 0.766 (0.138) | 0.935 (0.069) |
| mixed recall | 0.372 | 0.853 |
| AI-edited macro F1 | 0.684 | 0.899 |
| unseen generator / unseen domain | 0.784 / 0.750 | 0.887 / 0.806 |
| adversarial recall | 0.736 | 0.921 |
| zero-width / homoglyph (synthetic) | 0.441 / 0.751 | 0.887 / 0.890 |
| AIGTxt dataset holdout | 0.618 | 0.859 |
| external holdout 2026 (AUC / recall / FPR) | 0.881 / 0.696 / 0.124 | 0.990 / 1.000 / 0.160 |
| V1 frozen test macro F1 / FPR | **0.888 / 0.135** | 0.844 / **0.275** |
| V1 frozen Spanish test macro F1 / FPR | **0.869 / 0.145** | 0.831 / 0.269 |
| V1 frozen OOD / adversarial | 0.861 / 0.803 | 0.937 / 0.919 |
| token-level span F1 (head C) | n/a | 0.916 |

Version stability: on human texts with small edits both models are equally stable (unchanged-paragraph drift
0.018). On control→mixed / next-version pairs V3 flags the AI-changed paragraphs (93-99 % vs 25-35 % for V2), but
because 512-token windows span several paragraphs its context-window scores also move for neighbouring unchanged
paragraphs (drift 0.16-0.61 vs 0.11); paragraph-local scoring is needed before using V3 for version comparison.

## Decision

The automatic rule (better validation V2 primary and ≥ 5 improved target criteria) selects
**TURNITING_RESEARCH_V3_SPANISH_ACADEMIC → CANDIDATE_MODEL_V3**
(`MyDrive/turniting/v3/models/spanish_academic`, checkpoint `v3/checkpoints/20261017_0604_v3_es_acad/best`).

Caveat: on the frozen V1 test distribution V3 doubles the false-positive rate at its BALANCED threshold (AUC is
similar, 0.948 vs 0.957), so the threshold must be revisited (LOW_FALSE_POSITIVE operating point or recalibration
including V1-like human text) before any use where false accusations matter. V2 stays available as reference.
