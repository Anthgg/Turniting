#!/usr/bin/env bash
# TURNITING_RESEARCH_V3 end-to-end pipeline for Colab (resumable: each step leaves a .done marker on Drive).
#   nohup bash scripts/v3_pipeline.sh > /content/v3_pipeline.out 2>&1 &
set -euo pipefail
cd "$(dirname "$0")/.."
D=${V3_DRIVE:-/content/drive/MyDrive/turniting/v3}
V1W=${V1_WORKDIR:-/content/drive/MyDrive/turniting/workdir}
RAW=/content/raw_v2
WORK=/content/v3work
LOG=$D/logs
mkdir -p "$D"/{datasets,manifests,checkpoints,models,reports/eval,logs} "$WORK" "$RAW"
IDS=$D/experiment_ids.json
[ -f "$IDS" ] || python - <<EOF
import json, time
s = time.strftime('%Y%m%d_%H%M')
json.dump({"global": f"{s}_v3_global", "refine": f"{s}_v3_es_acad"}, open("$IDS", "w"))
EOF
G=$(python -c "import json;print(json.load(open('$IDS'))['global'])")
R=$(python -c "import json;print(json.load(open('$IDS'))['refine'])")
step() { [ -f "$LOG/$1.done" ]; }
done_() { date -u +%FT%TZ > "$LOG/$1.done"; echo "=== STEP $1 DONE $(date -u +%T)"; }
ts() { echo "=== STEP $1 START $(date -u +%T)"; }

# 0. V1 master to fast local disk
if [ ! -d /content/v1/master ]; then
  mkdir -p /content/v1 && cp -r "$V1W/datasets/normalized/master" /content/v1/master
fi

# 1. downloads (manifest on Drive)
if ! step download; then ts download
  python scripts/v3_download.py --raw $RAW --manifest $D/manifests/TURNITING_DATASET_V2_DOWNLOAD_MANIFEST.json 2>&1 | tee $LOG/download.log
  done_ download; fi

# 2. build V2 (restore from Drive when the runtime was recycled)
if ! step build; then ts build
  python scripts/v3_build_dataset.py --raw $RAW --v1-master /content/v1/master --work $WORK \
    --v1-eval-sets datasets/manifests/eval_sets.parquet 2>&1 | tee $LOG/build.log
  python -c "import json,sys; r=json.load(open('$WORK/stage2_summary.json'))['leakage']; print('leakage', r); sys.exit(0 if r['result']=='PASS' else 3)"
  rsync -a --delete $WORK/master_v2/ $D/datasets/master_v2/
  cp $WORK/*.parquet $WORK/*.json $D/datasets/
  cp $WORK/dataset_v2_statistics.json $WORK/master_v2_manifest.json $D/manifests/
  rm -rf $WORK/stage1   # temporary copy; master_v2 is the normalized copy kept
  done_ build
elif [ ! -d $WORK/master_v2 ]; then
  mkdir -p $WORK && rsync -a $D/datasets/master_v2/ $WORK/master_v2/ && cp $D/datasets/*.parquet $D/datasets/*.json $WORK/
fi

# 3. Spanish / academic weights on validation V2
if ! step weights; then ts weights
  python scripts/v3_select_weights.py --master $WORK/master_v2 --eval-sets $WORK/eval_sets_v2.parquet \
    --out $D/manifests/weight_selection.json 2>&1 | tee $LOG/weights.log
  done_ weights; fi

# 4. GLOBAL V3
if ! step train_global; then ts train_global
  python scripts/v3_train.py --mode global --exp $G --master $WORK/master_v2 --eval-sets $WORK/eval_sets_v2.parquet \
    --drive $D --weights $D/manifests/weight_selection.json 2>&1 | tee -a $LOG/$G.log
  done_ train_global; fi

# 5. SPANISH / ACADEMIC refinement (from global best, global replay inside)
if ! step train_refine; then ts train_refine
  python scripts/v3_train.py --mode refine --exp $R --init-from $D/checkpoints/$G/best --master $WORK/master_v2 \
    --eval-sets $WORK/eval_sets_v2.parquet --drive $D --weights $D/manifests/weight_selection.json 2>&1 | tee -a $LOG/$R.log
  done_ train_refine; fi

# 6. package + calibrate (VALIDATION V2 only)
if ! step calibrate; then ts calibrate
  python scripts/v3_calibrate.py --exp-dir $D/checkpoints/$G --out $D/models/global --name TURNITING_RESEARCH_V3_GLOBAL
  python scripts/v3_calibrate.py --exp-dir $D/checkpoints/$G --out $D/models/calibrated_global --name CALIBRATED_TURNITING_RESEARCH_V3_GLOBAL --calibrate
  python scripts/v3_calibrate.py --exp-dir $D/checkpoints/$R --out $D/models/spanish_academic --name TURNITING_RESEARCH_V3_SPANISH_ACADEMIC
  python scripts/v3_calibrate.py --exp-dir $D/checkpoints/$R --out $D/models/calibrated_spanish_academic --name CALIBRATED_TURNITING_RESEARCH_V3_SPANISH_ACADEMIC --calibrate
  done_ calibrate; fi

# 7. single evaluation on the frozen test sets
if ! step evaluate; then ts evaluate
  BASE=()
  [ -d $D/models/baseline_v1 ] && BASE=(--model BEST_BASELINE=$D/models/baseline_v1)
  python scripts/v3_evaluate.py --work $WORK --out $D/reports/eval "${BASE[@]}" \
    --model CANDIDATE_MODEL_V2=$V1W/models/gpu/calibrated_spanish_academic \
    --model TURNITING_RESEARCH_V3_GLOBAL=$D/models/global \
    --model CALIBRATED_TURNITING_RESEARCH_V3_GLOBAL=$D/models/calibrated_global \
    --model TURNITING_RESEARCH_V3_SPANISH_ACADEMIC=$D/models/spanish_academic \
    --model CALIBRATED_TURNITING_RESEARCH_V3_SPANISH_ACADEMIC=$D/models/calibrated_spanish_academic 2>&1 | tee $LOG/evaluate.log
  done_ evaluate; fi

# 8. report
python scripts/v3_report.py --drive $D --work $WORK 2>&1 | tee $LOG/report.log
echo "=== PIPELINE COMPLETE $(date -u +%T)"
