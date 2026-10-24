# F006.2 — Spanish academic + modern generator hardening (Track A)

Status: EXPERIMENTAL; promoted: NO; active model: NONE.

## Final external holdout (evaluated once, after MODEL_LOCK)

| Set | Metric | F006.2 | F006.1.1 |
|---|---|---|---|
| ALL | fpr | 0.0005 | 0.0092 |
| ALL | recall | 0.5151 | 0.6114 |
| ALL | macro_f1 | 0.7626 | 0.8106 |
| ALL | ece | 0.1319 | 0.157 |
| SPANISH | fpr | 0.0005 | 0.0092 |
| SPANISH | recall | 0.5151 | 0.6114 |
| SPANISH | macro_f1 | 0.7626 | 0.8106 |
| SPANISH | ece | 0.1319 | 0.157 |
| ACADEMIC | fpr | 0.0005 | 0.0092 |
| ACADEMIC | ece | 0.0207 | 0.03 |
| OOD | fpr | 0.0005 | 0.0092 |
| OOD | recall | 0.5151 | 0.6114 |
| OOD | macro_f1 | 0.7626 | 0.8106 |
| OOD | ece | 0.1319 | 0.157 |
| UNSEEN_GENERATOR | fpr | 0.0005 | 0.0092 |
| UNSEEN_GENERATOR | recall | 0.5151 | 0.6114 |
| UNSEEN_GENERATOR | macro_f1 | 0.7626 | 0.8106 |
| UNSEEN_GENERATOR | ece | 0.1319 | 0.157 |

## Output contract

```
STATUS = COMPLETED
PHASE = F006_2
GIT_BRANCH = exp/f006-2-modern-spanish-academic-hardening
GIT_COMMIT = 3535b6dcf2e9b1ef086e0a448a0d048044dc6036
GIT_PUSH = SEE_BRANCH
COLAB_NOTEBOOK = training/notebooks/colab_f006_2.ipynb
COLAB_USED = YES
DRIVE_ROOT = MyDrive/turniting/f006_2
GPU = NVIDIA RTX PRO 6000 Blackwell Server Edition
VRAM = 95.0 GiB
NEW_SOURCES_FOUND = 5
NEW_SOURCES_ALLOWED = 3
NEW_SPANISH_ROWS = 14438
NEW_HUMAN_ACADEMIC_ROWS = 20791
NEW_MACHINE_ROWS = 798
CLAUDE_GENERATED_ROWS = 1173
MIXED_ROWS = 201
EXACT_DUP_REMOVED = 2936
NEAR_DUP_REMOVED = 0
CROSS_SPLIT_LEAKAGE = 0
PARENT_LEAKAGE = 0
SOURCE_LEAKAGE = 0
TRAIN_ROWS = 153500
VALIDATION_ROWS = 10848
CALIBRATION_ROWS = 5770
OOD_ROWS = 2995
UNSEEN_GENERATOR_ROWS = 3011
FINAL_EXTERNAL_HOLDOUT_ROWS = 7017
BASELINE = EXPERIMENTAL_F006_1_1_MODEL
EXPERIMENTAL_MODEL = EXPERIMENTAL_F006_2_MODEL
MACRO_F1 = 0.7626423495201878
ROC_AUC = 0.9924485573201142
PR_AUC = 0.9901050546417565
SPANISH_F1 = 0.7626423495201878
ACADEMIC_F1 = NOT_MEASURABLE_IN_FINAL (human-only academic subset); ACADEMIC_FPR = 0.0004992511233150275
OOD_F1 = 0.7626423495201878
UNSEEN_GENERATOR_F1 = 0.7626423495201878
FPR = 0.0004992511233150275
FNR = 0.48488874128196613
RECALL = 0.5151112587180339
PRECISION = 0.9987121699935608
ECE = 0.13188774718714052
BRIER = 0.08832865157674347
FINAL_EXTERNAL_HOLDOUT_EVALUATED = YES (once)
FINAL_HOLDOUT_TUNING = NO
MODEL_STORAGE = GOOGLE_DRIVE:MyDrive/turniting/f006_2/models/final/experimental_f006_2
MODEL_SHA256 = fa6f721b3dc5902ad38e3e8abe1b82779ad63efe54ce20936a703393a68c2b91
MODEL_STATUS = EXPERIMENTAL
MODEL_PROMOTED = NO
ACTIVE_MODEL = NONE
```

## Run notes (read before using these numbers)

- **Claude data was generated without an API key** by Claude Code subagents (Opus / Sonnet / Haiku), recorded as `claude-code-subagent/<family>`. Usage limits cut generation short: 1,173 rows (AI_GENERATED 490, AI_REVISED 200, HUMAN_WITH_AI_INSERTS 200, AI_WITH_HUMAN_INSERTS 150, HUMAN_REVISED_BY_AI 133) instead of the 10-20k requested. TRAIN / VALIDATION / CALIBRATION only; never in the final holdout.
- **New sources:** TDX theses (HUMAN_ACADEMIC_STRONG, 20,791 paragraphs from 2,677 theses, split by thesis, NON_COMMERCIAL licence), Spanish Synthetic 2026 (OOD + final holdout only). MedAID-ML (restricted), ROBOT-TALK (no licence / download) not used; TXD-22 turned out to be a historical V2 source.
- **Selection outcome (validation, thresholds fitted on CALIBRATION):** F006.1.1 0.801, candidate A 0.764 (selectable), candidate B (replay) 0.878 but rejected by the pre-registered forgetting rule (historical macro F1 -1.55 pp > 1 pp, while historical FPR fell 1.85 pp). The rule locked A even though A does not beat the baseline: **NO IMPROVEMENT over F006.1.1 under the pre-registered rules.**
- **Final external holdout (7,017 docs, once):** F006.2-A FPR 0.0005 vs F006.1.1 0.0092 on new TDX academic humans, but recall on unseen small-generator news 0.515 vs 0.611, macro F1 0.763 vs 0.811, ROC-AUC 0.992 vs 0.971. The holdout is all Spanish, so ALL / SPANISH / OOD / UNSEEN_GENERATOR rows coincide; its academic subset is human-only (F1 not measurable).
- **Regression holdout (F006.1.1 final, continuity only):** FPR 0.070 vs 0.057, unseen-generator FPR 0.135 vs 0.092: A regresses on the old distribution.
- **Incidents:** first final-evaluation attempt crashed before scoring (thresholds.json lacked the BALANCED key; fixed, no metric written); candidate B was restarted once after an accidental interrupt in its first 2 minutes.
- Recommendation for a next round: revisit the forgetting threshold or add replay weight; B is the most promising configuration on validation.
