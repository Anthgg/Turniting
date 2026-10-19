# F006.1.3 — Unified Ensemble Calibration

**Status:** EXPERIMENTAL · **Candidate:** NO · **Active model:** NONE

**Final holdout independence:** INSUFFICIENT

**Research branch:** exp/f006-1-3-unified-ensemble from 0ad01f5fb75b48cdd1cce3a9b0084511253a69f1

## Decision

The fusion pool has 0 certified eligible examples and all four meta splits have size 0. Drive contains component training and validation artifacts, but no sealed, independently documented F006.1.3 pool or META_FINAL_HOLDOUT. Existing validation manifests do not establish a new untouched final holdout.

Prior cross-boundary leakage reports remain FAIL: F006.1 records one near-duplicate in Spanish validation versus train-extra and one in Spanish holdout versus train-extra; F006.1.1 records two near-duplicates in eval versus new train data. These are legacy findings, not rates against a new F006.1.3 final holdout.

No transformer inference/training, meta-model fitting, calibration, threshold selection, ablation, disagreement analysis, or final-holdout evaluation was performed. No component scores, fusion weights, coefficients, threshold, or model artifact are claimed.

## Component manifests

| Component | ID | Manifest SHA-256 | Weights changed |
|---|---|---|---|
| V2 | TURNITING_AI_V1 | 63f56bea13363597420d3578f4f60ea86a762266f3447d8de3d9712098a613d4 | No |
| V3 | TURNITING_RESEARCH_V3_SPANISH_ACADEMIC | be0581242a47b02a59fbae130738c5c5df5679fb1007862784f6fd5329845882 | No |
| F006.1 | EXPERIMENTAL_F006_1_MODEL | fc8fb7595a9ba54181b8d9c39a7e94e57609f558985ce163bed368a6a8b2022b | No |
| F006.1.1 | EXPERIMENTAL_F006_1_1_MODEL | 114315db02a06d71abe3093537c190025fe2ffd2d6f9ba5554eb419bde7e1894 | No |

F006.1.1 weight integrity: PROVENANCE_VERIFIED_NOT_RESEARCH_HASH_LOCKED. Component manifest hashes are metadata hashes, not weight hashes.

## Evaluation status

All metric gates are NOT_EVALUATED because no eligible meta splits or final holdout exist. The no-read gate passed for this run. Leakage counts against a new META_FINAL_HOLDOUT are null, not zero.

| Split | Size |
|---|---:|
| FUSION_POOL eligible | 0 |
| META_TRAIN | 0 |
| META_CALIBRATION | 0 |
| META_VALIDATION | 0 |
| META_FINAL_HOLDOUT | 0 |

## Resume requirement

Obtain a new labeled and licensed corpus with document, group, lineage, source, participant, generator-family, prompt, and parent-child identifiers. Audit against every component training manifest, freeze group-safe splits, lock fusion and calibration using validation only, then score the sealed final holdout exactly once.

No F008 similarity, no span model, no component weight changes, and no product/backend/frontend/F009 edits.

Generated at 2026-10-19T20:20:13+00:00.
