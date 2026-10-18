# F008 — Similarity engine (Track B)

**Status: EXPERIMENTAL.** SIMILARITY_PIPELINE_V1 was not created and nothing is ACTIVE. The pipeline passes 4
of the 5 criteria on the single evaluation of the locked final holdout. No fine-tuning was run: this is a
zero-shot baseline.

## Pipeline that was locked (`reports/f008/model_lock.json`)

- **Chunking:** paragraph-aware, about 200 words (150–400 tokens), cut at sentence boundaries, with the
  original offsets kept.
- **Retrieval:** BM25 (k1 1.2, b 0.75). It had the best validation MRR among BM25, BGE-M3 dense, BGE-M3
  sparse, multilingual-E5-large-instruct, RRF fusions and weighted fusions.
- **Reranker:** BAAI/bge-reranker-v2-m3. Alignment uses lexical 4-gram seeds plus semantic regions
  (BGE-M3 and the reranker), then overlap resolution and coverage on eligible tokens. References, URLs, DOIs,
  e-mails and boilerplate are excluded from coverage.
- **Alignment thresholds:** tau_doc 0.2, tau_sem 0.85, tau_rr 0.4, chosen on VALIDATION from a grid of 8.

## Data (`reports/f008/f008_dataset_manifest.json`)

| Source | Status |
|---|---|
| PAN-PC-11 (Zenodo 3250095, CC-BY-4.0) | DOWNLOADED: 15,846 suspicious and 11,093 source documents, 61,064 cases |
| MIRACL-es | DOWNLOADED: 1.5M passages, 103,326 articles (3 of 21 shards) |
| mMARCO-es | DOWNLOADED: 2,000 dev queries and 190,258 passages (BM25 top-100) |
| PAWS-X-es | DOWNLOADED from Google's HF copy (the GCS bucket returns 403): 53,401 pairs |
| PAN 2025 / PAN 2026 | PENDING_ACCESS (restricted; no unofficial mirrors used) |

**Evaluation sets** (locked 2026-10-18 08:04 UTC, before any tuning):
- The holdout has 2,413 documents: 515 PAN suspicious documents, 898 Spanish synthetic documents and 1,000
  PAWS-X pairs.
- Validation has 1,587 documents. PAN documents, MIRACL articles and PAWS-X dev/test splits are disjoint between
  the two.

**Spanish synthetic cases** contain exact copies, near copies (case, punctuation, whitespace, Cyrillic
look-alikes), partial excerpts, same-topic negatives (passages that are not in the corpus), generic academic
boilerplate (also planted in corpus documents) and unrelated original text.

**Retrieval corpus:** 1,697,445 passages. It holds every PAN source referenced by an evaluation document plus
300 distractor sources, and 278,107 Spanish passages (all source articles plus 250k distractors).

## Final holdout (`reports/f008/final_holdout.json`)

| Family | Recall@1 | Recall@5 | Recall@10 | MRR | nDCG@10 | Char P / R / F1 |
|---|---|---|---|---|---|---|
| Spanish synthetic | 0.997 | 0.9995 | 0.9995 | 0.998 | 0.998 | 0.756 / 0.983 / **0.855** |
| PAN-PC-11 | 0.262 | 0.309 | 0.330 | 0.286 | 0.290 | 0.829 / 0.028 / 0.055 |
| PAWS-X (paraphrase) | 0.037 | 0.838 | 0.929 | 0.333 | 0.477 | paraphrase precision **0.484** |

- **All spans together:** precision 0.608, recall 0.235, F1 0.339, mean IoU 0.359.
- **False matches:** same-topic false-match rate 0.000 and boilerplate false-match rate 0.000.
- **Document coverage:** MAE 0.153.

| Criterion | Value | Passes |
|---|---|---|
| Spanish recall@10 ≥ 0.90 | 0.9995 | ✓ |
| Spanish char F1 ≥ 0.80 | 0.855 | ✓ |
| Same-topic FPR ≤ 0.05 | 0.000 | ✓ |
| Boilerplate FPR ≤ 0.05 | 0.000 | ✓ |
| Paraphrase precision ≥ 0.80 | 0.484 | ✗ |

## Index benchmark (MIRACL-es, 1.5M vectors, 1024 dimensions; `index_benchmark.json`)

| Index | Recall@10 vs exact | Latency per query | Size |
|---|---|---|---|
| Exact GPU fp16 | 1.0 | 15.7 ms (batch) | 3.1 GB |
| HNSW32 | **0.929** | 0.06 ms | 6.6 GB |
| IVF4096-PQ64 (nprobe 64) | 0.553 | 0.34 ms | 0.13 GB |

Encoding speed on the RTX PRO 6000 was about 1,500 passages per second for both BGE-M3 and E5.

## Findings

- **Spanish copy detection works.** Exact, near and partial copies are found almost perfectly with BM25, and
  same-topic text and boilerplate do not trigger matches.
- **PAN-PC-11 is not solved zero-shot.** It contains machine-translated and heavily obfuscated cases. The
  locked chunk-level retrieval misses most sources, and alignment recall is about 3%.
- **The reranker did not help.** It slightly lowers PAN ranking and hurts PAWS-X badly (recall@10 falls from
  0.93 to 0.43), because it rewards high lexical overlap that is not paraphrase.
- **Paraphrase precision (0.48) is the failing criterion.** PAWS-X negatives share almost all their words with
  the source, and the current alignment cannot tell them apart.

## Next step

Fine-tune on validation-justified data: cross-language and obfuscated pairs from PAN and an adversarial
paraphrase set. The main candidates are a bi-encoder or reranker trained on PAWS-X train (the translated
split) and PAN 2011 train pairs, plus a cross-lingual dense retriever for translated plagiarism.

## Evaluation protocol and notes

- **Protocol (fixed before holdout access):** retrieval metrics use capped positive query passages
  (PAN 4,000, Spanish 3,000, PAWS 1,000). Reranking is evaluated on 2,937 queries at depth 50. Span alignment
  runs on 1,978 whole documents, of which 80 PAN documents were selected by hash.
- **Runtime:** the evaluation was run once. The first try was lost when the Colab VM was recycled (compute
  units ran out) and was repeated from scratch on a new VM with the same locked holdout and configuration.
  Nothing was tuned between the two runs.
- **Rules:** no Turnitin data, private documents or the user's thesis were used. No backend or frontend
  changes, no ACTIVE status.
