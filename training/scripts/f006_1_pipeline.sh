#!/usr/bin/env bash
# F006.1 Spanish generalization on Colab. Resumable (.done markers on Drive). Selection reads F006_1 VALIDATION only.
#   nohup bash scripts/f006_1_pipeline.sh > /content/f0061_pipeline.out 2>&1 &
set -euo pipefail
cd "$(dirname "$0")/.."
D=/content/drive/MyDrive/turniting/f006_1
F6=/content/drive/MyDrive/turniting/f006
V3D=/content/drive/MyDrive/turniting/v3
V3CK=$V3D/checkpoints/20261017_0604_v3_es_acad/best
F6M=$F6/models/experimental_v4
LOG=$D/logs
mkdir -p "$D"/{datasets,manifests,runs,checkpoints,models,reports,logs} reports/f006_1
step() { [ -f "$LOG/$1.done" ]; }
done_() { date -u +%FT%TZ > "$LOG/$1.done"; echo "=== STEP $1 DONE $(date -u +%T)"; }
ts() { echo "=== STEP $1 START $(date -u +%T)"; git pull -q || true; }
export F006_DRIVE=$D F006_SCORE=f006_1 F006_ABLATION_REPORT=ablations.json
COMMON=(--drive $D --val $D/datasets/f006_1_validation.parquet --train-extra $D/datasets/f006_1_train_extra.parquet
        --es-hard-pool $D/datasets/spanish_hard_human_pool.parquet --score f006_1 --para-frac 0.30 --loss weighted
        --hard-ratio 0.3 --aca-w 1.5 --local /content/turniting-f0061/ckpt --cache-root /content/turniting-f0061/cache)
T() { python scripts/f006_train.py "$@" "${COMMON[@]}" 2>&1 | grep --line-buffered -v -i "warn" | tee -a "$LOG/train_runs.log"; }
S() { python scripts/f006_select.py "$@"; }
W=${ABLATION_WINDOWS:-120000}

if ! step splits; then ts splits; python -W ignore scripts/f006_1_splits.py 2>&1 | tee $LOG/splits.log; done_ splits; fi
if ! step pools; then ts pools; python -W ignore scripts/f006_1_pools.py 2>&1 | tee $LOG/pools.log; done_ pools; fi
if ! step calib_pre; then ts calib_pre; python -W ignore scripts/f006_1_calib.py 2>&1 | tee $LOG/calib_pre.log; done_ calib_pre; fi
[ "${STOP_AFTER:-}" = "calib_pre" ] && { echo "=== STOP_AFTER=calib_pre"; exit 0; }

# Stage A: parent first, then human/machine ratio, Spanish hard share, human loss weight, Spanish weight
if ! step a_parent; then ts a_parent
  T --run B1_v3 --init $V3CK --windows $W --human-share 0.6 --es-mix 0.4,0.3,0.3 --human-weight 1.25 --es-w 2.5
  T --run B2_f006 --init $F6M --windows $W --human-share 0.6 --es-mix 0.4,0.3,0.3 --human-weight 1.25 --es-w 2.5
  done_ a_parent; fi
BP=$(S --runs B1_v3 B2_f006)
INIT=$([ "$BP" = "B1_v3" ] && echo $V3CK || echo $F6M); PT=$([ "$BP" = "B1_v3" ] && echo v3 || echo f006)
if ! step a_ratio; then ts a_ratio
  for H in 0.5 0.65; do T --run B3_${PT}_h$H --init $INIT --windows $W --human-share $H --es-mix 0.4,0.3,0.3 --human-weight 1.25 --es-w 2.5; done
  done_ a_ratio; fi
BR=$(S --runs $BP B3_${PT}_h0.5 B3_${PT}_h0.65); H=$(S --runs $BR --field human_share)
if ! step a_mix; then ts a_mix
  T --run B5_${PT}_h${H}_es20 --init $INIT --windows $W --human-share $H --es-mix 0.2,0.5,0.3 --human-weight 1.25 --es-w 2.5
  T --run B6_${PT}_h${H}_es30 --init $INIT --windows $W --human-share $H --es-mix 0.3,0.4,0.3 --human-weight 1.25 --es-w 2.5
  done_ a_mix; fi
BM=$(S --runs $BR B5_${PT}_h${H}_es20 B6_${PT}_h${H}_es30); MIX=$(python -c "import json;r=json.load(open('$D/runs/$BM/run.json'));print(','.join(str(x) for x in r['config']['es_mix']))")
if ! step a_hw; then ts a_hw
  for HW in 1.0 1.5; do T --run B7_${PT}_hw$HW --init $INIT --windows $W --human-share $H --es-mix $MIX --human-weight $HW --es-w 2.5; done
  done_ a_hw; fi
BH=$(S --runs $BM B7_${PT}_hw1.0 B7_${PT}_hw1.5); HW=$(S --runs $BH --field human_weight)
if ! step a_esw; then ts a_esw
  for ES in 2.0 3.0; do T --run B9_${PT}_es$ES --init $INIT --windows $W --human-share $H --es-mix $MIX --human-weight $HW --es-w $ES; done
  done_ a_esw; fi
BE=$(S --runs $BH B9_${PT}_es2.0 B9_${PT}_es3.0); ES=$(S --runs $BE --field es_w)
S --summary | tee $LOG/ablation_summary.log
ELIG=$(python scripts/f006_1_gatecheck.py)
if [ "$ELIG" != "1" ]; then echo "=== NO ABLATION PASSED THE VALIDATION GATES (Spanish FPR<=0.08, overall<=0.05): no full run"; exit 0; fi

# Stage B
FW=${FULL_WINDOWS:-350000}
if ! step full; then ts full
  T --run F0061_FULL --stage full --mixture f006_1 --init $INIT --windows $FW --human-share $H --es-mix $MIX --human-weight $HW \
    --es-w $ES --eval-every 1200 --min-epochs-before-stop 0.75 --patience 3
  done_ full; fi
S --summary > /dev/null
if ! step lock; then ts lock; python -W ignore scripts/f006_1_lock.py --run F0061_FULL --parent "$BP" 2>&1 | tee $LOG/lock.log; done_ lock; fi
if ! step final_eval; then ts final_eval; python -W ignore scripts/f006_1_final_eval.py 2>&1 | tee $LOG/final_eval.log; done_ final_eval; fi
echo "=== F006.1 PIPELINE COMPLETE $(date -u +%T)"
