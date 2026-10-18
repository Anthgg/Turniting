# F006.1.2 — Span localization hardening

**STATUS: EXPERIMENTAL_SPAN_MODEL_V1.** It is not CANDIDATE_SPAN_MODEL_V1 and not ACTIVE.

- Locked model: `MyDrive/turniting/f006_1_2/models/f006_1_2_locked`
- Copy: `models/experimental_span_model_v1`

## Decision before training (sections 1–2)

F006.1.1 finished as EXPERIMENTAL with span token F1 0.769 (precision 0.645, recall 0.953), char F1 0.771,
mixed recall 0.583, overall FPR 0.054, Spanish FPR 0.019 and unseen-generator FPR 0.097.

The span F1 is below 0.86, so ADDITIONAL_TRAINING_REQUIRED = true and SPAN_SERVING_READINESS_EVAL was not
applicable (`reports/f006_1_2/decision_after_f006_1_1.json`).

## Data (`dataset_manifest.json`, `leakage_report.json`, `holdout_lock.json`)

| Split | Units | With spans | Gold spans | ES / EN |
|---|---|---|---|---|
| Train | 135,993 | 86,859 | 316,368 | 56,232 / 79,761 |
| SPAN_VALIDATION | 25,581 | 15,879 | 58,242 | 11,486 / 14,095 |
| SPAN_FINAL_HOLDOUT (LOCKED before training) | 30,914 | 19,275 | 58,521 | 14,281 / 16,633 |

Each unit is one paragraph-sized target.

**Sources used:**
- V2 exact AI spans: OPAI-bench (EN) and Heterogeneous AI Spans, a single canonical view.
- Spanish human paragraphs: COWSL2H, academic abstracts ES, SciELO, SBW and V2 humans.
- Hard negatives: real academic boilerplate, methodology, lists and headings.
- Synthetic REFERENCE_ONLY and METADATA_ONLY sets, with fake names and DOIs and no span.
- Spanish mixed units (ES_SPLICE): real Spanish AI sentences inserted into real Spanish human paragraphs,
  with exact offsets by construction. **No Spanish corpus with exact spans exists.**

**Not usable:**
- AIUD-SPAN v2: BLOCKED_ACCESS.
- SemEval-2024 Task 8 C: UNAVAILABLE (the repository needs credentials).
- GRADTEX and Beemo: no character offsets in their releases.
- CEDEL2: MANUAL_ACCESS_REQUIRED.

**Leakage = 0** for exact, near-duplicate (cross-set MinHash/LSH), group, document, lineage, parent-child,
participant (COWSL2H) and prompt. No unit from an earlier holdout was used.

## Offsets (sections 10–12, 52–54)

- **Normalization:** NFC with a character map back to the original. Whitespace, line breaks, zero-width
  characters and homoglyphs are kept.
- **Spans:** tokenizer `offset_mapping` is used for char-to-token and token-to-char mapping. Spans are trimmed
  to visible characters, because SentencePiece offsets carry the leading space of a word.
- **Round trip:** exact for accents, ñ, quotes, decomposed Unicode, line breaks, punctuation, emoji,
  zero-width, homoglyphs and multiple spans (`offset_validation.json`).
- **Context:** offsets are always relative to the target paragraph, never to the context.

## Stage A (8 ablations of 120k windows, VALIDATION only; `ablation_summary.json`)

| Run | Parent | Scheme | α/β | Token loss | Char F1 | Span F1 (IoU ≥ .5) | Human FH | Paragraph regression (macro F1 / human FPR / ES FPR, pp) |
|---|---|---|---|---|---|---|---|---|
| S1 | F006.1.1 | binary | .4/.6 | weighted | 0.901 | 0.476 | 0.015 | 1.38 / 3.12 / 6.07 |
| S2 | F006.1 | binary | .4/.6 | weighted | 0.900 | 0.470 | 0.016 | 0.79 / 1.88 / 1.66 |
| S3 | F006.1 | BIO | .4/.6 | weighted | 0.899 | 0.438 | 0.014 | 0.61 / 1.40 / 1.29 |
| S4 | F006.1 | BIO | .5/.5 | weighted | 0.897 | 0.454 | 0.015 | 0.67 / 1.53 / 1.60 |
| S5 | F006.1 | BIO | .3/.7 | weighted | 0.900 | 0.452 | 0.015 | 0.69 / 1.57 / 1.86 |
| **S6** | F006.1 | BIO | .4/.6 | **focal** | 0.892 | **0.496** | **0.006** | **0.54** / 1.21 / 1.50 |
| S7 | F006.1 | BIO | .4/.6 | weighted, positive weight 4 | 0.889 | 0.387 | 0.023 | 0.78 / 1.81 / 1.74 |
| S8 | F006.1 | BIO | .4/.6 | focal, 40% replay | 0.893 | 0.488 | 0.009 | 0.84 / 2.01 / 2.60 |

- **Parent:** F006.1 was chosen by comparison, not assumed. F006.1.1 as parent gave 3–6 pp of paragraph
  regression.
- **Labels and loss:** BIO tagging with focal loss and α 0.4 / β 0.6.
- **Post-processing** (validation): tau 0.65, gap 0, min_tokens 6, SPAN_ABSTAIN_THRESHOLD 0.70.
- **Full run:** 320k windows with the S6 configuration. On validation it reached char F1 0.899, token F1
  0.901, span F1 0.502 and human FH 0.008.

## Final holdout (one evaluation after F006_1_2_MODEL_LOCK; `final_holdout.json`)

| Metric | New | Parent F006.1 | Gate |
|---|---|---|---|
| Token P / R / F1 | 0.799 / 0.890 / **0.842** | 0.769 F1 | A ≥ 0.88 ✗ |
| Char P / R / F1 | 0.809 / 0.871 / **0.839** | 0.777 F1 | B ≥ 0.88 ✗ |
| Span overlap P / R / F1 (IoU ≥ 0.5) | 0.612 / 0.380 / **0.469** | 0.304 F1 | C ≥ 0.86 ✗ |
| Span exact F1 | 0.303 | | |
| Mean IoU | 0.766 | | |
| Boundary start / end MAE | 165 / 167 chars | | |
| Human false highlight rate | **0.019** | 0.035 | D ≤ 0.05 ✓ |
| Spanish span F1 (char F1 0.957) | **0.912** | | E ≥ 0.86 ✓ |
| Academic span F1 (char F1 0.952) | 0.636 | | F ≥ 0.85 ✗ |
| Mixed span F1 (char F1 0.831) | 0.510 | | G ≥ 0.84 ✗ |
| Reference false highlight | 0.000 | 0.000 | H ≤ 0.02 ✓ |
| Metadata false highlight | 0.000 | 0.000 | I ≤ 0.02 ✓ |
| Leakage | 0 | | J ✓ |
| Boilerplate false highlight | 0.010 | 0.112 | |

**Paragraph regression** is reported both ways and not hidden:

| Where | Macro F1 | Human FPR (at the parent's recall) | Spanish FPR | Result |
|---|---|---|---|---|
| Holdout units | 0.717 → 0.740 | 0.050 → 0.002 | 0.022 → 0.000 | improves, gate passes |
| F006.1.1 document validation | −0.58 pp | +1.45 pp | +1.43 pp | above the 1 pp tolerance |

The final gate measures paragraph regression on the span holdout units, where it passes. Measured at the
document level on the F006.1.1 validation, the detector worsens more than the 1 pp tolerance. Before integration,
either keep head A of the parent for paragraph scores or retrain with a document-level replay objective.

**Robustness (span units):**

| Perturbation | Char F1 | Span F1 |
|---|---|---|
| Clean | 0.845 | 0.473 |
| Zero-width | 0.830 | 0.562 |
| Homoglyph | 0.822 | 0.439 |
| Line breaks | 0.845 | |
| Extra whitespace | 0.845 | |
| Punctuation | 0.727 | |

**Slices:**
- Unseen domain: char F1 0.765, span F1 0.316.
- Unseen generator: N/A. No span corpus contains generator families that are absent from every training set.
- Recall by span length (tokens): 1–5 0.31, 6–15 0.74, 16–40 0.83, 41–100 0.88, more than 100 0.93.
- Paragraph/span relation:
  - A positive paragraph has spans in 59.7% of units and no span in 7.1%.
  - A strong span appears inside a negative paragraph in only 2 units out of 30,914. This is measured, not
    forced.

## Findings

1. **Localization of AI characters improves clearly over the parent.** Char F1 goes from 0.777 to 0.839 and
   false highlights on human text, boilerplate, references and metadata nearly disappear.
2. **Span-level F1 is the bottleneck.** Gold spans in OPAI-bench are many and adjacent. The model marks the AI
   region correctly but merges or splits spans differently, so IoU-based span matching stays at about 0.47 and
   boundary MAE is about 165 characters. Very short spans (1–5 tokens) are mostly missed.
3. **Spanish 0.91 comes from synthetic splices.** It shows the mechanism works, but it is optimistic compared
   with real mixed Spanish writing.
4. **Paragraph quality stays the open issue.** Every multi-task configuration moved the document-level
   detector by more than 1 pp of FPR.

## Limitations

- There is no real Spanish exact-span corpus. AIUD-SPAN and SemEval C were not accessible.
- No unseen-generator span slice.
- The validation post-processing grid is coarse (54 configurations).

## Next step

LOCAL_SPAN_MODEL_INTEGRATION is possible only as research. Two options:
- Span head from this model, paragraph score from the existing detector.
- A span-merging or boundary-refinement stage trained toward the IoU-based span metric.

Not ACTIVE.

## Rules followed

- No private documents, Turnitin data or user thesis were used.
- No tuning on the final holdout.
- No weights in Git.
- No backend, frontend, F008 or PDF changes.
