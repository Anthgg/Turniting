#!/usr/bin/env bash
# F006 end-to-end on Colab (A100). Resumable: every step leaves a .done marker on Drive.
#   nohup bash scripts/f006_pipeline.sh > /content/f006_pipeline.out 2>&1 &
# The code is refreshed (git pull) before each step; selection only ever reads F006 VALIDATION.
set -euo pipefail
cd "$(dirname "$0")/.."
F6=${F006_DRIVE:-/content/drive/MyDrive/turniting/f006}
V3=/content/drive/MyDrive/turniting/v3
V3M=$V3/models/spanish_academic
V3CK=$V3/checkpoints/20261017_0604_v3_es_acad/best
V2M=/content/drive/MyDrive/turniting/workdir/models/gpu/calibrated_spanish_academic
MASTER=/content/f006work/master_v2
LOG=$F6/logs
mkdir -p "$F6"/{datasets,manifests,runs,models,reports,logs} /content/turniting-f006 reports/f006
step() { [ -f "$LOG/$1.done" ]; }
done_() { date -u +%FT%TZ > "$LOG/$1.done"; echo "=== STEP $1 DONE $(date -u +%T)"; }
ts() { echo "=== STEP $1 START $(date -u +%T)"; git pull -q || true; }
T() { python scripts/f006_train.py "$@" 2>&1 | grep --line-buffered -v -i "warn" | tee -a "$LOG/train_runs.log"; }
S() { python scripts/f006_select.py "$@"; }

# 0. data on fast local disk
if [ ! -f $MASTER/.complete ]; then
  rsync -a $V3/datasets/master_v2/ $MASTER/ && touch $MASTER/.complete
fi

# 1. gated datasets (status only; integration happens only if GRANTED)
if ! step gated; then ts gated
  python scripts/f006_gated_check.py $F6/manifests/gated_status.json
  cp $F6/manifests/gated_status.json reports/f006/ 2>/dev/null || true
  done_ gated; fi

# 2. F006 final holdout + validation, LOCKED before any training
if ! step splits; then ts splits
  python -W ignore scripts/f006_splits.py --v3 $V3 --master $MASTER --out $F6 --v3-model $V3M 2>&1 | tee $LOG/splits.log
  done_ splits; fi

# 3. hard human pool from TRAIN only (fixed V3)
if ! step hard; then ts hard
  python -W ignore scripts/f006_hard_humans.py --master $MASTER --model $V3M --out $F6 --tag hard_human_pool_v1 --n 250000 2>&1 | tee $LOG/hard.log
  done_ hard; fi

[ "${STOP_AFTER:-}" = "hard" ] && { echo "=== STOP_AFTER=hard"; exit 0; }

# 4. Stage A ablations (150k windows each, same V3 init, same validation, same seed family)
W=${ABLATION_WINDOWS:-150000}
if ! step ablation_sampling; then ts ablation_sampling
  for H in 0.4 0.5 0.6; do T --run A1_h${H}_r0.3_ce --windows $W --human-share $H --hard-ratio 0.3 --loss ce; done
  done_ ablation_sampling; fi
H=$(S --runs A1_h0.4_r0.3_ce A1_h0.5_r0.3_ce A1_h0.6_r0.3_ce --field human_share)
if ! step ablation_hard; then ts ablation_hard
  for R in 0.2 0.4; do T --run A2_h${H}_r${R}_ce --windows $W --human-share $H --hard-ratio $R --loss ce; done
  done_ ablation_hard; fi
R=$(S --runs A1_h${H}_r0.3_ce A2_h${H}_r0.2_ce A2_h${H}_r0.4_ce --field hard_ratio)
BASE=$(S --runs A1_h${H}_r0.3_ce A2_h${H}_r0.2_ce A2_h${H}_r0.4_ce)
if ! step ablation_loss; then ts ablation_loss
  T --run A3_h${H}_r${R}_w1.5 --windows $W --human-share $H --hard-ratio $R --loss weighted --human-weight 1.5
  T --run A3_h${H}_r${R}_focal1 --windows $W --human-share $H --hard-ratio $R --loss focal --focal-gamma 1.0
  BEST3=$(S --runs $BASE A3_h${H}_r${R}_w1.5 A3_h${H}_r${R}_focal1)
  if [ "$BEST3" = "A3_h${H}_r${R}_w1.5" ]; then
    T --run A3_h${H}_r${R}_w2.0 --windows $W --human-share $H --hard-ratio $R --loss weighted --human-weight 2.0
  fi
  done_ ablation_loss; fi
LOSSRUNS="$BASE A3_h${H}_r${R}_w1.5 A3_h${H}_r${R}_focal1 A3_h${H}_r${R}_w2.0"
L=$(S --runs $LOSSRUNS --field loss)
HW=$(S --runs $LOSSRUNS --field human_weight)
FG=$(S --runs $LOSSRUNS --field focal_gamma)
BEST_L=$(S --runs $LOSSRUNS)
ES0=$(S --runs $BEST_L --field es_w); ACA0=$(S --runs $BEST_L --field aca_w)
ES1=$(python -c "print(3.0 if float('$ES0') < 2.75 else 2.0)")
ACA1=$(python -c "print(1.25 if float('$ACA0') != 1.25 else 1.5)")
if ! step ablation_weights; then ts ablation_weights
  T --run A4_es${ES1} --windows $W --human-share $H --hard-ratio $R --loss $L --human-weight $HW --focal-gamma $FG --es-w $ES1 --aca-w $ACA0
  T --run A4_aca${ACA1} --windows $W --human-share $H --hard-ratio $R --loss $L --human-weight $HW --focal-gamma $FG --es-w $ES0 --aca-w $ACA1
  done_ ablation_weights; fi
ES=$(S --runs $BEST_L A4_es${ES1} A4_aca${ACA1} --field es_w)
ACA=$(S --runs $BEST_L A4_es${ES1} A4_aca${ACA1} --field aca_w)
S --summary | tee $LOG/ablation_summary.log

# 5. Stage B: full targeted fine-tune from the V3 best checkpoint with the selected config
FW=${FULL_WINDOWS:-450000}
if ! step full; then ts full
  T --run F006_FULL --stage full --windows $FW --human-share $H --hard-ratio $R --loss $L --human-weight $HW \
    --focal-gamma $FG --es-w $ES --aca-w $ACA --emphasis --eval-every 1500 --min-epochs-before-stop 0.75 --patience 3
  done_ full; fi
S --summary > /dev/null

# 6. calibration + thresholds + ensembles on VALIDATION, then F006_MODEL_LOCK
if ! step lock; then ts lock
  python -W ignore scripts/f006_lock.py --run F006_FULL --v2 $V2M --v3 $V3M --out $F6 2>&1 | tee $LOG/lock.log
  done_ lock; fi

# 7. ONE evaluation after the lock: final holdout, mixed / AI-edited, robustness, span, historical V1, external 2026
if ! step final_eval; then ts final_eval
  python -W ignore scripts/f006_final_eval.py --out $F6 --v2 $V2M --v3 $V3M --v3-dir $V3 --master $MASTER 2>&1 | tee $LOG/final_eval.log
  done_ final_eval; fi
echo "=== F006 PIPELINE COMPLETE $(date -u +%T)"
