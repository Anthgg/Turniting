#!/usr/bin/env bash
# F008.2 PARAPHRASE + TRANSLATED SIMILARITY TRAINING (Track B only). Resumable (.done markers on Drive; HF Trainer checkpoints).
#   nohup bash scripts/f0082_pipeline.sh > /content/f0082_pipeline.out 2>&1 &
set -euo pipefail
cd "$(dirname "$0")/.."
D=/content/drive/MyDrive/turniting/f008_2
LOG=$D/logs
mkdir -p "$D"/datasets/{raw,pairs,splits,manifests} "$D"/models/{biencoder,reranker,checkpoints,final} "$D"/{reports,logs} reports/f008_2
step() { [ -f "$LOG/$1.done" ]; }
done_() { date -u +%FT%TZ > "$LOG/$1.done"; echo "=== STEP $1 DONE $(date -u +%T)"; }
ts() { echo "=== STEP $1 START $(date -u +%T)"; }

if ! step claude_pairs; then ts claude_pairs
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "=== STOP: ANTHROPIC_API_KEY missing (Colab secret)"; exit 2; fi
  python -W ignore scripts/f0082_claude.py run 2>&1 | tee -a $LOG/claude.log; done_ claude_pairs; fi
if ! step splits; then ts splits; python -W ignore scripts/f0082_data.py 2>&1 | tee -a $LOG/splits.log; done_ splits; fi
python - <<'EOF' || { echo "=== STOP_BEFORE_TRAINING"; exit 3; }
import json, torch, pandas as pd
D = "/content/drive/MyDrive/turniting/f008_2/datasets"
m = json.load(open(f"{D}/manifests/f008_2_final_external_holdout.json"))
n = {k: len(pd.read_parquet(f"{D}/splits/f008_2_{k}.parquet", columns=["pair_id"])) for k in ("train", "validation", "calibration", "final_external_holdout")}
p = torch.cuda.get_device_properties(0)
lk = m["leakage"]
for k, v in {"PHASE": "F008_2", "GPU": p.name, "VRAM": f"{p.total_memory/2**30:.1f} GiB", "PRECISION": "bf16" if torch.cuda.is_bf16_supported() else "fp16",
             "BASE_MODEL": "BAAI/bge-m3 + BAAI/bge-reranker-v2-m3", "TRAIN_ROWS": n["train"], "VALIDATION_ROWS": n["validation"],
             "CALIBRATION_ROWS": n["calibration"], "FINAL_HOLDOUT_ROWS": n["final_external_holdout"], "BATCH_SIZE": "memory probe at start",
             "GRADIENT_ACCUMULATION": 1, "MAX_SEQUENCE_LENGTH": "256 (bi-encoder) / 384 (reranker)", "LEARNING_RATE": 1e-5,
             "DRIVE_OUTPUT_PATH": "MyDrive/turniting/f008_2/models", "CROSS_SPLIT_LEAKAGE": lk["CROSS_SPLIT_LEAKAGE"], "PARENT_OVERLAP": lk["PARENT_LEAKAGE"],
             "SOURCE_LEAKAGE": lk["SOURCE_LEAKAGE"], "LINEAGE_LEAKAGE": lk["LINEAGE_LEAKAGE"]}.items():
    print(f"{k} = {v}")
raise SystemExit(0 if lk["result"] == "PASS" else 3)
EOF
if ! step biencoder; then ts biencoder; python -W ignore scripts/f0082_train.py biencoder 2>&1 | grep --line-buffered -v -i "warn" | tee -a $LOG/biencoder.log; done_ biencoder; fi
if ! step reranker; then ts reranker; python -W ignore scripts/f0082_train.py reranker 2>&1 | grep --line-buffered -v -i "warn" | tee -a $LOG/reranker.log; done_ reranker; fi
if ! step compare; then ts compare; python -W ignore scripts/f0082_eval.py compare 2>&1 | tee -a $LOG/compare.log; done_ compare; fi
if ! step lock; then ts lock; python -W ignore scripts/f0082_eval.py lock 2>&1 | tee -a $LOG/lock.log; done_ lock; fi
if ! step final; then ts final; python -W ignore scripts/f0082_eval.py final 2>&1 | tee -a $LOG/final.log; done_ final; fi
python -W ignore scripts/f0082_report.py 2>&1 | tee -a $LOG/report.log
echo "=== F008.2 PIPELINE COMPLETE $(date -u +%T)"
