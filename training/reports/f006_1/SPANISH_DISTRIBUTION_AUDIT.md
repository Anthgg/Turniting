# F006.1 — Spanish distribution audit

Question: why was the F006 Spanish human FPR 0.014 on F006 validation but 0.142 on the F006 final holdout?

Decisions use TRAIN + VALIDATION only. The observed F006 holdout is only described here (composition and
per-source error rates, marked DESCRIPTIVE_ONLY); it feeds no parameter. Full numbers:
`spanish_distribution_audit.json`.

## 1. Where the Spanish humans come from

TURNITING_DATASET_V2 Spanish rows by split: train 26,770 humans, validation 3,380, test 18,828, unseen-domain
test 4,157. Every Spanish human row comes from three sources: AuTexTification 2023, IberAuTexTification and
DetectRL. **There are no Spanish MIXED or AI-edited rows at all**, so Spanish machine text means AI_GENERATED or
PARAPHRASED_AI only.

| Spanish humans | F006 validation | F006 holdout (observed) |
|---|---:|---:|
| detectrl_x | 796 | 751 |
| autextification2023 | 750 | 726 |
| iberautextification | 679 | 1,151 |
| rows taken from an official V1 test split | 0 % | 71 % (1,679 test + 198 unseen-domain test) |

## 2. Domains (Spanish humans, metadata only)

| source | TRAIN / VALIDATION domains | official TEST domains |
|---|---|---|
| IberAuTexTification | literary, news, tweets, wikipedia | **chat (2,014), how-to (2,237)**, literary, news, tweets, wikipedia |
| AuTexTification 2023 | legal, tweets, wiki | **news (5,218)**, legal, tweets, wiki |
| DetectRL | Academic, News, Novel, SEO, Webtext, Wiki | same six |

The official test sets of both shared tasks contain domains that never occur in their train/validation
splits: chat and how-to for IberAuTexTification, news for AuTexTification. In F006 a V1-origin row could enter
validation only when it came from a V1 validation split, so the F006 validation never contained these domains,
while the holdout (never-observed TEST-side groups) did.

## 3. Error rates by source (each model at its locked F006 BALANCED threshold)

| source | split | n | V3 FPR | F006 FPR |
|---|---|---:|---:|---:|
| iberautextification | F006 validation | 679 | 0.010 | 0.012 |
| autextification2023 | F006 validation | 750 | 0.029 | 0.031 |
| detectrl_x | F006 validation | 796 | 0.000 | 0.000 |
| iberautextification | official test (holdout, DESCRIPTIVE_ONLY) | 1,059 | 0.355 [0.327–0.384] | 0.294 [0.267–0.322] |
| autextification2023 | official test (holdout, DESCRIPTIVE_ONLY) | 620 | 0.144 [0.118–0.173] | 0.081 [0.062–0.105] |
| detectrl_x | test (holdout, DESCRIPTIVE_ONLY) | 751 | 0.000 | 0.001 |
| iberautextification | unseen-domain test (reviews) | 92 | 0.043 | 0.000 |

## 4. Conclusion

The 0.014 to 0.142 gap is not noise. It is a domain shift in human text: chat and how-to from IberAuTexTification
and news from AuTexTification, which the train-like validation could not represent. F006 already reduced the
error on these domains compared with V3 (0.294 against 0.355 and 0.081 against 0.144), but it never trained on
them.

## 5. What F006.1 changes (fixed before training)

1. Spanish groups that were never evaluated, from any non-TRAIN V2 split (including the official test
   domains), are re-partitioned by group hash: 40 % TRAIN_EXTRA, 30 % new validation, 30 % new locked holdout.
   The F006 holdout groups, the V1 frozen sets and all previously evaluated ids stay out.
2. New public Spanish human sources: XL-Sum Spanish (BBC Mundo, published before 2021) and CC-NEWS-ES (news
   from 2019, split by country).
3. Hard Spanish humans are mined from F006.1 TRAIN only. Both V3 and F006 are compared as parents.
4. Calibration options (global, Spanish isotonic, Spanish Platt, Spanish threshold) are compared on the new
   validation before deciding whether a full fine-tune is needed.

Caveat: after step 1, the V1 historical benchmark is no longer fully independent of training, because rows from
the same official test distributions are in TRAIN_EXTRA. It is reported only for continuity.
