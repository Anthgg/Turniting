#!/usr/bin/env bash
# F008.3 MULTILINGUAL PARAPHRASE + TRANSLATED SIMILARITY HARDENING (Track B only). Resumable (.done markers on Drive; HF Trainer checkpoints).
# F008.2 artefacts are read-only (R1 starts from a COPY of the locked B_RERANK).
#   python -c "import subprocess; subprocess.Popen(['bash','scripts/f0083_pipeline.sh'], stdout=open('/content/f0083_pipeline.out','a'), stderr=subprocess.STDOUT, start_new_session=True)"
set -euo pipefail
cd "$(dirname "$0")/.."
D=/content/drive/MyDrive/turniting/f008_3
LOG=$D/logs
mkdir -p "$D"/datasets/{raw,pairs,splits,manifests} "$D"/models/{biencoder,reranker,checkpoints,final} "$D"/{evaluation,reports,logs} reports/f008_3
step() { [ -f "$LOG/$1.done" ]; }
done_() { date -u +%FT%TZ > "$LOG/$1.done"; echo "=== STEP $1 DONE $(date -u +%T)"; }
ts() { echo "=== STEP $1 START $(date -u +%T)"; }
pip -q install rank_bm25 langid > /dev/null 2>&1 || true

if ! step claude_pairs; then ts claude_pairs  # Claude Code subagent outputs (TRAIN / VAL / CAL only, never FINAL)
  SG=datasets/selfgen/f008_3_selfgen_outputs.tgz
  [ -f "$SG" ] || { echo "=== STOP: $SG missing"; exit 2; }
  rm -rf /content/selfgen_f0083 && mkdir -p /content/selfgen_f0083 && tar xzf "$SG" -C /content/selfgen_f0083
  python -W ignore scripts/f0083_selfgen.py collect --out /content/selfgen_f0083 2>&1 | tee -a $LOG/claude.log
  cp /content/selfgen_f0083/claude_pairs_multilingual.parquet $D/datasets/pairs/claude_pairs_multilingual.parquet
  done_ claude_pairs; fi
if ! step splits; then ts splits; python -W ignore scripts/f0083_data.py 2>&1 | tee -a $LOG/splits.log; done_ splits; fi
python scripts/f0083_preflight.py || { echo "=== STOP_BEFORE_TRAINING"; exit 3; }
if ! step reranker; then ts reranker; python -W ignore scripts/f0083_train.py reranker 2>&1 | grep --line-buffered -v -i "warn" | tee -a $LOG/reranker.log; done_ reranker; fi
if ! step biencoder; then ts biencoder; python -W ignore scripts/f0083_train.py biencoder 2>&1 | grep --line-buffered -v -i "warn" | tee -a $LOG/biencoder.log; done_ biencoder; fi
if ! step compare; then ts compare; python -W ignore scripts/f0083_eval.py compare 2>&1 | tee -a $LOG/compare.log; done_ compare; fi
if ! step lock; then ts lock; python -W ignore scripts/f0083_eval.py lock 2>&1 | tee -a $LOG/lock.log; done_ lock; fi
if ! step final; then ts final; python -W ignore scripts/f0083_eval.py final 2>&1 | tee -a $LOG/final.log; done_ final; fi
python -W ignore scripts/f0083_report.py 2>&1 | tee -a $LOG/report.log
echo "=== F008.3 PIPELINE COMPLETE $(date -u +%T)"
