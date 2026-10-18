# Turniting research — final reports (2026-10-18)

None of the three models is ACTIVE. No merges, no PRs, no weights in Git. No Turnitin data, private documents
or the user's thesis were used.

## C4 — Track A (F006.1.1)

```
TRACK_A_STATUS = COMPLETED_EXPERIMENTAL
BRANCH = exp/f006-1-1-detector-hardening
COMMIT = 0ad01f5
GPU = NVIDIA A100-SXM4-80GB
NEW_DATASETS = COWSL2H, academic abstracts ES, SciELO ES, Spanish Billion Words, Beemo, GRADTEX, Heterogeneous AI Spans
CEDEL2_STATUS = MANUAL_ACCESS_REQUIRED
COWSL2H_STATUS = DOWNLOADED (3,469)
AIUD_SPAN_STATUS = BLOCKED_ACCESS
HETEROGENEOUS_SPANS_STATUS = DOWNLOADED (312 new after dedup, single view)
GRADTEX_STATUS = DOWNLOADED (35,495, dedup vs MAGE)
BEEMO_STATUS = DOWNLOADED (5,002, grouped by prompt)
SEMEVAL_C_STATUS = UNAVAILABLE
SCIELO_STATUS = DOWNLOADED (60,051)
ACADEMIC_ES_STATUS = DOWNLOADED (11,616)
SPANISH_BILLION_STATUS = DOWNLOADED (59,992)
TRAIN_ROWS = 3,029,191
VALIDATION_SIZE = 30,657
FINAL_HOLDOUT_SIZE = 30,363
LEAKAGE = 0 (PASS)
BEST_PARENT = C3_f006 (EXPERIMENTAL_F006)
BEST_CONFIG = C8_tok06 (token weight 0.6), ES_PLATT calibration
TRAIN_WINDOWS = 371,864 (400k target)
FINAL_MACRO_F1 = 0.8704
FINAL_OVERALL_FPR = 0.0541
FINAL_SPANISH_FPR = 0.0190
FINAL_ACADEMIC_FPR = 0.0307
FINAL_UNSEEN_GENERATOR_FPR = 0.0967
FINAL_MIXED_RECALL = 0.5832
FINAL_AI_EDITED_F1 = 0.9023
FINAL_OOD_F1 = 0.9383
FINAL_SPAN_F1 = 0.7694
FINAL_ZERO_WIDTH = 0.8609
FINAL_HOMOGLYPH = 0.8609
CANDIDATE_MODEL_V4_CREATED = NO
MODEL_STATUS = EXPERIMENTAL_F006_1_1_MODEL (failed gates A, H, I)
MODEL_PATH = MyDrive/turniting/f006_1_1/models/experimental_f006_1_1
```

## C5 — Track B (F008)

```
TRACK_B_STATUS = COMPLETED_EXPERIMENTAL
BRANCH = exp/f008-similarity-training
COMMIT = 4b43a29
GPU = A100-SXM4-80GB + RTX PRO 6000 Blackwell 96GB
PAN2011 = DOWNLOADED (PAN-PC-11, CC-BY-4.0)
PAN2025 = PENDING_ACCESS
PAN2026 = PENDING_ACCESS
MMARCO_ES = DOWNLOADED
MIRACL_ES = DOWNLOADED (1.5M passages)
PAWS_X_ES = DOWNLOADED (Google HF copy)
BEST_DENSE_MODEL = multilingual-e5-large-instruct
BEST_SPARSE = BM25 (selected retriever)
BEST_FUSION = RRF_ALL (not better than BM25)
BEST_RERANKER = bge-reranker-v2-m3 (zero-shot; did not improve)
CORPUS_PASSAGES = 1,697,445
INDEX_TYPE = HNSW32
INDEX_SIZE = 1.5M x 1024 (6.55 GB; recall@10 0.929 vs exact, 0.06 ms)
RECALL_AT_1 = ES 0.997 | PAN 0.262 | PAWS 0.037
RECALL_AT_5 = ES 0.9995 | PAN 0.309 | PAWS 0.838
RECALL_AT_10 = ES 0.9995 | PAN 0.330 | PAWS 0.929
MRR = ES 0.998 | PAN 0.286 | PAWS 0.333
NDCG10 = ES 0.998 | PAN 0.290 | PAWS 0.477
SPAN_PRECISION = 0.608 (ES 0.756)
SPAN_RECALL = 0.235 (ES 0.983)
SPAN_F1 = 0.339 (ES 0.855)
PARAPHRASE_PRECISION = 0.484
SAME_TOPIC_FPR = 0.000
BOILERPLATE_FPR = 0.000
DOCUMENT_COVERAGE_MAE = 0.153
SIMILARITY_PIPELINE_V1_CREATED = NO
MODEL_PATH = zero-shot public models; lock MyDrive/turniting/f008/manifests/F008_MODEL_LOCK.json
INDEX_PATH = benchmark only (not persisted)
```

## F006.1.2 — Span localization

```
STATUS = COMPLETED_EXPERIMENTAL
PHASE = F006_1_2_SPAN_LOCALIZATION_HARDENING
GIT_BRANCH = exp/f006-1-2-span-localization
GIT_COMMIT = 37a590e
GIT_PUSH = YES
PARENT_MODEL = EXPERIMENTAL_F006_1_MODEL
F006_1_1_SPAN_F1 = 0.7694
ADDITIONAL_TRAINING_REQUIRED = YES
DATASETS_USED = OPAI-bench + Heterogeneous AI Spans (V2), ES splices, COWSL2H, abstracts ES, SciELO, SBW, V2 humans, synthetic references/metadata
AIUD_SPAN_STATUS = BLOCKED_ACCESS
HETEROGENEOUS_SPANS_STATUS = USED
SEMEVAL_C_STATUS = UNAVAILABLE
GRADTEX_STATUS = NOT_USED (no offsets)
BEEMO_STATUS = NOT_USED (no offsets)
TRAIN_EXAMPLES = 135,993
VALIDATION_EXAMPLES = 25,581
FINAL_HOLDOUT_EXAMPLES = 30,914
LEAKAGE_EXACT = 0
LEAKAGE_NEAR = 0
LEAKAGE_GROUP = 0
LEAKAGE_LINEAGE = 0
BEST_LABEL_SCHEME = BIO
BEST_LOSS = 0.4 paragraph BCE + 0.6 token focal
BEST_CONFIG = S6_focal -> SFULL (320k windows; tau 0.65, min 6 tokens, abstain 0.70)
FINAL_TOKEN_PRECISION = 0.799
FINAL_TOKEN_RECALL = 0.890
FINAL_TOKEN_F1 = 0.842
FINAL_CHAR_PRECISION = 0.809
FINAL_CHAR_RECALL = 0.871
FINAL_CHAR_F1 = 0.839
FINAL_SPAN_PRECISION = 0.612
FINAL_SPAN_RECALL = 0.380
FINAL_SPAN_F1 = 0.469
FINAL_SPAN_IOU = 0.766
BOUNDARY_START_MAE = 165 chars
BOUNDARY_END_MAE = 167 chars
SPANISH_SPAN_F1 = 0.912 (synthetic splices)
ACADEMIC_SPAN_F1 = 0.636
MIXED_SPAN_F1 = 0.510
HUMAN_FALSE_HIGHLIGHT_RATE = 0.019
REFERENCE_FALSE_HIGHLIGHT_RATE = 0.000
METADATA_FALSE_HIGHLIGHT_RATE = 0.000
UNSEEN_GENERATOR_SPAN_F1 = N/A
UNSEEN_DOMAIN_SPAN_F1 = 0.316
ZERO_WIDTH_SPAN_F1 = 0.562
HOMOGLYPH_SPAN_F1 = 0.439
PARENT_PARAGRAPH_MACRO_F1 = 0.717
NEW_PARAGRAPH_MACRO_F1 = 0.740
PARENT_HUMAN_FPR = 0.050
NEW_HUMAN_FPR = 0.002
PARENT_SPANISH_FPR = 0.022
NEW_SPANISH_FPR = 0.000
GATES_PASSED = D, E, H, I, J, paragraph (holdout units)
FAILED_GATES = A, B, C, F, G (+ document-level paragraph regression on validation: +1.45 pp human FPR)
MODEL_NAME = EXPERIMENTAL_SPAN_MODEL_V1
MODEL_STATUS = EXPERIMENTAL
MODEL_PATH = MyDrive/turniting/f006_1_2/models/experimental_span_model_v1
SPAN_SERVING_READY = NO
OFFSETS_VALIDATED = YES
CONTEXT_TARGET_ONLY = YES
MULTIPLE_SPANS_SUPPORTED = YES
ABSTENTION_SUPPORTED = YES
CANDIDATE_SPAN_MODEL = NONE
ACTIVE_MODEL = NONE
PRIVATE_DOCUMENT_USED = NO
TURNITIN_DATA_USED = NO
MODEL_WEIGHTS_IN_GIT = NO
FINAL_HOLDOUT_TUNING = NO
NEXT_STEP = LOCAL_SPAN_MODEL_INTEGRATION (research only)
```

## Findings, warnings and limitations

- **F006.1.1:** the best detector so far. Spanish FPR is 0.019 and unseen-generator FPR is 0.097. It misses the
  overall FPR gate by 0.4 pp, and mixed recall and span quality do not improve.
- **F008:** Spanish copy detection is near perfect, with zero false matches on same-topic text and boilerplate.
  Translated and obfuscated plagiarism (PAN) and paraphrase precision are not solved zero-shot; they need
  fine-tuning.
- **F006.1.2:** AI characters are localized better (char F1 0.839 vs 0.777) with very few false highlights.
  Span boundaries and very short spans remain weak. The Spanish figure comes from synthetic splices.
- **Warning:** the Colab VM of the first account was recycled when its compute units ran out. The F008 final
  evaluation and the first F006.1.2 ablation were repeated on the second account with the same locked sets.
  No holdout was used twice for selection.
- **Limitations:** there is no real Spanish exact-span corpus, PAN 2025/2026 are restricted, and AIUD-SPAN and
  SemEval C were inaccessible.
