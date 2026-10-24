# F008.2 — Paraphrase + translated similarity (Track B)

Status: EXPERIMENTAL; active model: NONE.

Selected configuration: B_RERANK. Frozen zero-shot reference (ZS): precision 0.9772727272727273, recall 0.27388535031847133, F1 0.42786069651741293 on the same final holdout.

## Output contract

```
STATUS = COMPLETED
PHASE = F008_2
GIT_BRANCH = exp/f008-2-paraphrase-similarity-training
GIT_COMMIT = 2b742f433b807f6a86942106b06095dc6ffd8bd6
GIT_PUSH = SEE_BRANCH
COLAB_NOTEBOOK = training/notebooks/colab_f008_2.ipynb
COLAB_USED = YES
DRIVE_ROOT = MyDrive/turniting/f008_2
GPU = NVIDIA RTX PRO 6000 Blackwell Server Edition
VRAM = 95.0
NEW_PARAPHRASE_SOURCES = Sushi corpus (CC0, final holdout), STS-es MTEB test (CC BY 4.0, OOD), Claude pairs (train only)
NEW_PAIR_COUNT = 64659
CLAUDE_PAIR_COUNT = 10999
HARD_NEGATIVE_COUNT = 31787
TRANSLATED_PAIR_COUNT = 1000
EXACT_DUP_REMOVED = 2653
NEAR_DUP_REMOVED = 0
CROSS_SPLIT_LEAKAGE = 0
PARENT_LEAKAGE = 0
SOURCE_LEAKAGE = 0
TRAIN_PAIRS = 57747
VALIDATION_PAIRS = 3243
CALIBRATION_PAIRS = 3365
FINAL_HOLDOUT_PAIRS = 6912
BEST_RETRIEVER = BM25 + frozen BGE-M3 (RRF)
BEST_RERANKER = fine-tuned bge-reranker-v2-m3
BEST_FUSION = B_RERANK
RECALL_AT_1 = 0.08280254777070063
RECALL_AT_5 = 0.7898089171974523
RECALL_AT_10 = 0.8726114649681529
MRR = 0.36000386219777936
NDCG10 = 0.48150962097478395
PARAPHRASE_PRECISION = 0.989247311827957
PARAPHRASE_RECALL = 0.2929936305732484
PARAPHRASE_F1 = 0.4520884520884521
SAME_TOPIC_FPR = 0.00015192950470981463
LEXICAL_HARD_NEGATIVE_FPR = 0.056724611161939616
NEGATION_FPR = 0.0
ENTITY_CHANGE_FPR = 0.184
NUMBER_CHANGE_FPR = 0.09433962264150944
TRANSLATED_RECALL_AT_10 = None
SPAN_PRECISION = 1.0
SPAN_RECALL = 0.25925925925925924
SPAN_F1 = 0.4117647058823529
CHAR_F1 = 0.4642625782768301
DOCUMENT_COVERAGE_MAE = 0.43491931291583386
EXACT_COPY_REGRESSION = PASS
SPANISH_COPY_REGRESSION = FAIL
MODEL_STORAGE = GOOGLE_DRIVE:MyDrive/turniting/f008_2/models/final
MODEL_SHA256 = {'reranker': '9618638bfe4951314ecb5b5d4d36681455aef176e4edae3f86062dd2342bfd6a'}
MODEL_STATUS = EXPERIMENTAL
ACTIVE_MODEL = NONE
```

## Run notes (read before using these numbers)

- **Claude pairs were generated without an API key** by Claude Code subagents (Opus / Sonnet / Haiku): 1,000 seeds, 10,999 pairs, TRAINING ONLY (`training/datasets/selfgen/`).
- **Selected config B_RERANK** (frozen BM25 + BGE-M3 retrieval, fine-tuned bge-reranker-v2-m3). The fine-tuned bi-encoder (A) returned precision 0 at its calibrated cosine threshold and was not eligible.
- **Final holdout (Sushi, human, never trained):** B_RERANK P 0.989 / R 0.293 / F1 0.452 vs frozen ZS 0.977 / 0.274 / 0.428. Recall on Sushi is low for both (strict thresholds; Sushi paraphrases are long-distance rewrites).
- **Other sets, B_RERANK vs ZS:** PAWS-X es test (historical regression) precision 0.923 vs 0.797, recall 0.817 vs 0.676; lexical hard-negative FPR 0.057 vs 0.143; translated OOD (es-de / es-fr) recall 0.821 vs 0.430; STS-es rule negatives: number FPR 0.094 vs 0.264, entity FPR 0.184 vs 0.248, negation 0.000 vs 0.024.
- **SPANISH_COPY_REGRESSION = FAIL** comes from the char-F1 term measured on Sushi document pairs, not on exact copies; exact-copy retrieval regression PASS.
- **Incident:** the first final run crashed in the synthetic span step (no Sushi negatives in the span builder) before writing any result; fixed and run once.
