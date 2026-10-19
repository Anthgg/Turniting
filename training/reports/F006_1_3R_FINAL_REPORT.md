# F006.1.3R — Independent Unified Ensemble

Status: EXPERIMENTAL; Candidate: NO; Active model: NONE.

INDEPENDENT_DATA_CERTIFIED = NO. STOP before split lock, fusion fitting, training, calibration, threshold selection, inference, or final holdout.

- Historical scan: 120 text-bearing Parquet files; 8,815,028 rows and 9,421,519 text values; zero read failures.
- Samples: ALIA legal human/synthetic 1,000 each; biomedical/cultural 900/500/900/800 partial; Boletín timed out; Unmasking and TuringBench not sampled.
- Available long-text exact screen: zero historical and candidate-sample hash hits; strings under 40 characters excluded.
- Legal synthetic card links generations to the ALIA human legal corpus; per-item lineage IDs absent.
- Near-duplicate, source URL, group, prompt, parent-child and participant checks remain NOT EVALUATED.
- All meta split sizes are 0; no model lock, split lock, ablations, or final-holdout artifact created.

## Output contract

STATUS = STOPPED_BEFORE_TRAINING
PHASE = F006_1_3R_INDEPENDENT_UNIFIED_ENSEMBLE
GIT_BRANCH = exp/f006-1-3r-independent-unified
GIT_COMMIT = SEE_GITHUB_BRANCH_TIP
GIT_BASE_COMMIT = 1f32b5f22efbba45a6e4b36894b5a59b174f28e
GIT_PUSH = YES_AFTER_ARTIFACT_COMMIT
NEW_DATASETS_FOUND = 9
NEW_DATASETS_ACCEPTED = 0
NEW_DATASETS_REJECTED = 9
INDEPENDENT_DATA_CERTIFIED = NO
ALIA_LEGAL_HUMAN = SAMPLED_1000_UNCERTIFIED
ALIA_LEGAL_SYNTHETIC = SAMPLED_1000_KNOWN_SOURCE_FAMILY_OVERLAP
ALIA_BIOMEDICAL_HUMAN = PARTIAL_900_UNCERTIFIED
ALIA_BIOMEDICAL_SYNTHETIC = PARTIAL_500_UNCERTIFIED
ALIA_CULTURAL_HUMAN = PARTIAL_900_UNCERTIFIED
ALIA_CULTURAL_SYNTHETIC = PARTIAL_800_UNCERTIFIED
BOLETIN_ARGENTINA = NOT_SAMPLED_TIMEOUT
UNMASKING_IMPOSTERS = NOT_SAMPLED_RATE_LIMIT
TURINGBENCH = AUDIT_ONLY_NOT_SAMPLED
EXACT_LEAKAGE = NOT_EVALUATED_FULL_CORPUS; zero sampled long-text hits
NEAR_LEAKAGE = NOT_EVALUATED
SOURCE_LEAKAGE = NOT_EVALUATED_RECORD_LEVEL
GROUP_LEAKAGE = NOT_EVALUATED
LINEAGE_LEAKAGE = NOT_EVALUATED_RECORD_LEVEL
META_TRAIN_SIZE = 0
META_CALIBRATION_SIZE = 0
META_VALIDATION_SIZE = 0
META_FINAL_HOLDOUT_SIZE = 0
FINAL_HOLDOUT_LOCKED = NO
FINAL_HOLDOUT_USED_FOR_TUNING = NO
COMPONENTS = []
BEST_FUSION = None
BEST_WEIGHTS = None
BEST_COEFFICIENTS = None
CALIBRATOR = None
THRESHOLD = None
FINAL_MACRO_F1 = None
FINAL_OVERALL_FPR = None
FINAL_SPANISH_FPR = None
FINAL_ACADEMIC_FPR = None
FINAL_MIXED_RECALL = None
FINAL_AI_EDITED_F1 = None
FINAL_OOD_F1 = None
FINAL_UNSEEN_GENERATOR_FPR = None
FINAL_ECE = None
GATES_PASSED = ['historical text-bearing Parquet scan completed', 'pinned public metadata recorded', 'available-sample long-text exact screen completed with zero hits']
FAILED_GATES = ['1,000 rows per candidate', 'full candidate exact audit', 'near-duplicate audit', 'source/group/lineage audit', 'independent meta splits unavailable']
MODEL_NAME = TURNITING_UNIFIED_EXPERIMENTAL_V1
MODEL_STATUS = EXPERIMENTAL
ACTIVE_MODEL = NONE
TRANSFORMER_TRAINING = NO
META_MODEL_TRAINING = NO
PRIVATE_DOCUMENT_USED = NO
USER_THESIS_USED = NO
TURNITIN_DATA_USED = NO
WEIGHTS_IN_GIT = NO
NEXT_STEP = Complete pinned samples and source/near-duplicate/lineage checks; lock group-safe splits only after independence is proven.
