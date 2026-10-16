# Turniting AI Detector — training pipeline

Reproducible datasets → baselines → multilingual transformer → Spanish/academic refinement →
calibration → evaluation for **Turniting AI Detector V1** (`TURNITING_AI_V1`), trained on
`TURNITING_DATASET_V1`.

This is an independent detector. It is **not** a Turnitin model, is not affiliated with Turnitin,
and its outputs are `P(HUMAN)` / `P(MACHINE)`, not Turnitin percentages. Real Turnitin reports and
`VALIDATION_CASE_001` are deliberately **not** used anywhere in this pipeline (they are reserved
for later external calibration/comparison).

Nothing here touches the product code (backend, frontend, ai-service, OCR, parser).

## Layout

```
training/
├── configs/            datasets.yaml (pinned sources), build.yaml, training.yaml
├── datasets/
│   ├── manifests/      licenses.json, datasets.json (hashes), master/split manifests, raid_sampling.json  [git]
│   ├── raw/            downloaded files (1 copy)                                                         [ignored]
│   ├── normalized/     master/<split>/<split>-NNNNN.parquet, index + split_manifest.parquet              [ignored]
│   └── cache/          HF model cache, logs                                                              [ignored]
├── models/             baseline/, transformer/, calibrated/, eval_scores/                                [ignored]
├── checkpoints/        <experiment_id>/{best,last}                                                       [ignored]
├── reports/            statistics, metrics, TRAINING_REPORT.{md,json}, error analysis                    [git]
├── scripts/            download_datasets, build_dataset, train_baseline, train_transformer,
│                       calibrate, evaluate, predict, predict_batch, make_report
├── src/turniting_train/  library code (adapters, normalization, dedup, splits, sampling, metrics, ...)
└── tests/              fast unit tests (no training)
```

## Rebuild on a new machine

```bash
cd training
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match -r requirements.txt
# (CUDA hosts: install the matching CUDA torch wheel instead of the CPU index)

python scripts/download_datasets.py          # resumable, sha256-verified, writes manifests/datasets.json
python scripts/build_dataset.py              # stage1 adapt/normalize -> stage2 dedup/groups/splits -> stage3 master
python -m pytest -q tests
python scripts/train_baseline.py
python scripts/train_transformer.py --smoke
python scripts/train_transformer.py --mode global
python scripts/train_transformer.py --mode refine --init-from checkpoints/<global_exp>/best
python scripts/calibrate.py --experiment checkpoints/<global_exp>   --out models/transformer/global --name GLOBAL_MULTILINGUAL_TRANSFORMER
python scripts/calibrate.py --experiment checkpoints/<refined_exp>  --out models/transformer/spanish_academic --name SPANISH_ACADEMIC_TRANSFORMER
python scripts/calibrate.py --experiment checkpoints/<refined_exp>  --out models/calibrated/spanish_academic --name CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER --calibrate --link-weights
python scripts/evaluate.py --model <dir> --name <NAME> --final       # only after model selection
python scripts/make_report.py
```

Inference:

```bash
python scripts/predict.py --model models/transformer/best --text "Texto a analizar..."
python scripts/predict.py --model models/transformer/best --file sample.txt
python scripts/predict_batch.py --model models/transformer/best --input docs.csv --output scores.jsonl
```

Output: `{"machineProbability", "humanProbability", "label", "threshold", "modelVersion"}`.

## Key decisions

* **Labels**: `0 = HUMAN`, `1 = MACHINE`. MAGE's original labels are inverted (0 = machine) and
  are flipped by its adapter (verified against its `src` field). SemEval Subtask C (human→machine
  boundary texts) is kept as `MIXED` and never binarized.
* **Normalization**: Unicode NFC, CRLF→LF, NUL removal, edge-whitespace strip, zero-width removal
  for clean rows only. NFKC was rejected because it folds confusable/full-width characters and
  would undo homoglyph attacks. Adversarial rows keep their original text in `text` (attacks
  preserved) and the clean version in `text_normalized`.
* **Dedup**: exact SHA-256 over normalized text (raw text for adversarial rows). Same text with
  both labels → `LABEL_CONFLICT`, excluded. Near duplicates: MinHash (64 perms, word 3-grams,
  char 5-grams for CJK) + LSH (8 bands × 8 rows, adjacent-in-bucket linking, no O(N²)), confirmed
  at estimated Jaccard ≥ 0.8. Same-label clean near-dups are removed; others are linked.
* **Leakage control**: rows are linked by dataset group keys (prompt, question, source id, essay
  id, RAID `source_id`), exact-duplicate hashes and near-duplicate pairs; connected components
  become `group_id`, and splits are assigned per component (80/10/10 by hash). Any component with
  an official-test/OOD row goes wholly to the evaluation side. The build fails its leakage check
  if any group, exact hash or near-dup pair spans train and evaluation splits.
* **Holdouts**: generator families `mistral`, `cohere` → `unseen_generator_test`; domains
  `reviews`, `recipes` → `unseen_domain_test`; SemEval-2024 official test + MAGE OOD →
  `ood_test`; RAID attacked rows of evaluation groups + MAGE paraphrase OOD →
  `adversarial_test`; leave-one-dataset-out with the TF-IDF baseline.
* **Sampling**: each dataset gets a configurable mass independent of its size, labels balanced
  inside each dataset, Spanish (`SPANISH_TRAIN_WEIGHT`, chosen on validation) and academic
  boosts, adversarial mass capped. Samples are drawn without replacement with weighted keys.
* **RAID**: 5.6 M labelled rows streamed in chunks; deterministic stratified bottom-k sample per
  `model|domain|attack|decoding|repetition_penalty` stratum (all 12 attack types equally
  represented). The 11.8 GB raw CSV is deleted after sampling to respect the disk floor; its
  sha256 stays in `datasets.json` and `download_datasets.py --only raid` restores it.

## Hardware constraints (this run)

The run recorded in `reports/TRAINING_REPORT.md` happened on a laptop CPU (no CUDA/MPS).
mDeBERTa-v3-base measured ~4.7 s per training example at 256 tokens on that CPU, so the
transformer is trained with frozen embeddings/lower layers, 256-token windows (stride 64) and a
weighted sample of windows. `train_transformer.py` switches to the full recipe (512 tokens,
stride 128, all layers trainable) automatically on a CUDA host.

## Disk safety

All writers call `ensure_disk`, which refuses to go below max(10 GB, 10 % of the disk).
Downloads resume from `.part` files; checkpoints keep only `best` and `last`.

## Licences

See `datasets/manifests/licenses.json`. IberAuTexTification (CC BY-NC-ND 4.0) and
AuTexTification (CC BY-NC-SA 4.0) are non-commercial: models trained with them are for research
until the organizers grant commercial permission. MULTITuDE is access-restricted on Zenodo and
was not downloaded.

## GPU training on Colab

```bash
python scripts/export_for_colab.py   # -> datasets/cache/turniting_colab_bundle.zip (master parquet + manifests + frozen eval ids)
```

Upload the zip to `MyDrive/turniting/`, open `notebooks/colab_train.ipynb` on a GPU runtime and run all
cells. It uses `configs/training_gpu.yaml` (512 tokens, stride 128, all layers, AMP, 150k windows,
3 epochs), keeps checkpoints in Drive and resumes from `last` after a disconnect. Inference in the
product does not need a GPU.
