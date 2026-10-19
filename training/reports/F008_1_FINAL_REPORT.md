# F008.1 — Paraphrase / Translated Similarity

Status: STOPPED BEFORE TRAINING; Active model: NONE.

INDEPENDENT_DATA_CERTIFIED = NO. No Track B candidate yielded a usable sample; PAN13 license is undeclared. STOP before training, tuning, split lock, or final holdout.

- Historical F008 Parquets were included in the scan; 8,815,028 rows scanned across all listed roots, zero read failures.
- Track B sample rows: zero for all five candidates (viewer unavailable, rights unresolved, or Hugging Face errors).
- Exact/near/source/group/lineage overlap for Track B is NOT EVALUATED.
- No train pairs, validation pairs, final holdout, metrics, or model were created.

## Output contract

STATUS = STOPPED_BEFORE_TRAINING
PHASE = F008_1_PARAPHRASE_TRANSLATED_HARDENING
GIT_BRANCH = exp/f008-1-paraphrase-translated-hardening
GIT_COMMIT = SEE_GITHUB_BRANCH_TIP
GIT_BASE_COMMIT = 4b43a2928ea1eea91c7141c0af73cb757b27e14c
GIT_PUSH = YES_AFTER_ARTIFACT_COMMIT
SPANISH_PARAPHRASE_STATUS = NOT_SAMPLED_VIEWER_DISABLED
PAN13_STATUS = BLOCKED_LICENSE_UNDECLARED
ALIA_PARALLEL_STATUS = NOT_SAMPLED_RATE_LIMIT_AND_LARGE_SOURCE
SNLI_PARAPHRASE_STATUS = NOT_SAMPLED_RATE_LIMIT
PARALLEL_POOL_STATUS = NOT_SAMPLED_RATE_LIMIT
INDEPENDENT_DATA_CERTIFIED = NO
TRAIN_PAIRS = 0
VALIDATION_PAIRS = 0
FINAL_HOLDOUT_PAIRS = 0
PARAPHRASE_TRAIN_PAIRS = 0
TRANSLATED_TRAIN_PAIRS = 0
OBFUSCATION_TRAIN_PAIRS = 0
HARD_NEGATIVES = 0
BEST_RETRIEVER = None
BEST_RERANKER = None
BEST_FUSION = None
BEST_ALIGNMENT = None
RECALL_AT_1 = None
RECALL_AT_5 = None
RECALL_AT_10 = None
MRR = None
NDCG10 = None
SPAN_PRECISION = None
SPAN_RECALL = None
SPAN_F1 = None
CHAR_F1 = None
PARAPHRASE_PRECISION = None
PARAPHRASE_RECALL = None
PARAPHRASE_F1 = None
TRANSLATED_RECALL_AT_10 = None
TRANSLATED_ALIGNMENT_F1 = None
SAME_TOPIC_FPR = None
BOILERPLATE_FPR = None
DOCUMENT_COVERAGE_MAE = None
EXACT_COPY_REGRESSION = NOT_RUN
SPANISH_COPY_REGRESSION = NOT_RUN
GATES_PASSED = ['historical F008 Parquets included in scan', 'pinned metadata/licenses catalogued where available']
FAILED_GATES = ['no Track B candidate sample', 'PAN13 license undeclared', 'near/source/group/lineage audit not run', 'clean train/validation/final holdout unavailable']
MODEL_NAME = NONE
MODEL_STATUS = NOT_CREATED
ACTIVE_MODEL = NONE
FINAL_HOLDOUT_TUNING = NO
PRIVATE_DOCUMENT_USED = NO
USER_THESIS_USED = NO
TURNITIN_DATA_USED = NO
WEIGHTS_IN_GIT = NO
NEXT_STEP = Resolve PAN13 rights and sample every candidate; audit source, case/group, offsets, and historical overlap before any split.
