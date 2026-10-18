#!/usr/bin/env bash
# F006.1.1 detector hardening (Track A). Resumable (.done markers on Drive). Selection reads F006_1_1 VALIDATION only.
#   nohup bash scripts/f0611_pipeline.sh > /content/f0611_pipeline.out 2>&1 &
set -euo pipefail
cd "$(dirname "$0")/.."
D=/content/drive/MyDrive/turniting/f006_1_1
V3CK=/content/drive/MyDrive/turniting/v3/checkpoints/20261017_0604_v3_es_acad/best
F6M=/content/drive/MyDrive/turniting/f006/models/experimental_v4
F61M=/content/drive/MyDrive/turniting/f006_1/models/experimental_f006_1
LOG=$D/logs
mkdir -p "$D"/{datasets,manifests,runs,checkpoints,models,reports,logs} reports/f006_1_1
step() { [ -f "$LOG/$1.done" ]; }
done_() { date -u +%FT%TZ > "$LOG/$1.done"; echo "=== STEP $1 DONE $(date -u +%T)"; }
ts() { echo "=== STEP $1 START $(date -u +%T)"; git pull -q || true; }
export F006_DRIVE=$D F006_SCORE=f006_1_1 F006_ABLATION_REPORT=ablations.json F006_VAL=f006_1_1_validation.parquet F006_REPORT_DIR=f006_1_1
COMMON=(--drive $D --val $D/datasets/f006_1_1_validation.parquet --train-extra $D/datasets/f006_1_1_train_extra.parquet
        --hard-pool $D/datasets/hard_human_pool_v3.parquet --es-hard-pool $D/datasets/spanish_hard_pool_v3.parquet --mixture f006_1_1
        --score f006_1_1 --para-frac 0.30 --loss weighted --hard-ratio 0.3 --aca-w 1.5 --es-mix 0.4,0.3,0.3
        --local /content/turniting-f0611/ckpt --cache-root /content/turniting-f0611/cache)
T() { python scripts/f006_train.py "$@" "${COMMON[@]}" 2>&1 | grep --line-buffered -v -i "warn" | tee -a "$LOG/train_runs.log"; }
S() { python scripts/f006_select.py "$@"; }
W=${ABLATION_WINDOWS:-120000}
BASEMIX=0.30,0.25,0.15,0.10,0.10,0.05,0.05

if ! step splits; then ts splits; python -W ignore scripts/f0611_splits.py 2>&1 | tee $LOG/splits.log; done_ splits; fi
if ! step pools; then ts pools; python -W ignore scripts/f0611_pools.py 2>&1 | tee $LOG/pools.log; done_ pools; fi
if ! step calib_pre; then ts calib_pre; python -W ignore scripts/f0611_lockeval.py calib_pre 2>&1 | tee $LOG/calib_pre.log; done_ calib_pre; fi
[ "${STOP_AFTER:-}" = "calib_pre" ] && { echo "=== STOP_AFTER=calib_pre"; exit 0; }

if ! step a_parent; then ts a_parent
  T --run C1_f0061 --init $F61M --windows $W --human-share 0.5 --human-weight 1.0 --es-w 2.5 --mix $BASEMIX
  T --run C2_v3 --init $V3CK --windows $W --human-share 0.5 --human-weight 1.0 --es-w 2.5 --mix $BASEMIX
  T --run C3_f006 --init $F6M --windows $W --human-share 0.5 --human-weight 1.0 --es-w 2.5 --mix $BASEMIX
  done_ a_parent; fi
BP=$(S --runs C1_f0061 C2_v3 C3_f006)
case "$BP" in C1_f0061) INIT=$F61M;; C2_v3) INIT=$V3CK;; *) INIT=$F6M;; esac
if ! step a_hw; then ts a_hw
  for HW in 1.25 1.5; do T --run C4_hw$HW --init $INIT --windows $W --human-share 0.5 --human-weight $HW --es-w 2.5 --mix $BASEMIX; done
  done_ a_hw; fi
BH=$(S --runs $BP C4_hw1.25 C4_hw1.5); HW=$(S --runs $BH --field human_weight)
if ! step a_data; then ts a_data
  T --run C6_mixspan --init $INIT --windows $W --human-share 0.5 --human-weight $HW --es-w 2.5 --mix 0.25,0.25,0.15,0.15,0.15,0.03,0.02
  T --run C7_h55 --init $INIT --windows $W --human-share 0.55 --human-weight $HW --es-w 2.5 --mix $BASEMIX
  T --run C8_tok06 --init $INIT --windows $W --human-share 0.5 --human-weight $HW --es-w 2.5 --mix $BASEMIX --token-weight 0.6
  T --run C9_es3 --init $INIT --windows $W --human-share 0.5 --human-weight $HW --es-w 3.0 --mix $BASEMIX
  T --run C10_hard35 --init $INIT --windows $W --human-share 0.5 --human-weight $HW --es-w 2.5 --mix 0.25,0.35,0.15,0.10,0.10,0.03,0.02
  done_ a_data; fi
BEST=$(S --runs $BH C6_mixspan C7_h55 C8_tok06 C9_es3 C10_hard35)
S --summary | tee $LOG/ablation_summary.log
ELIG=$(python scripts/f006_1_gatecheck.py)
if [ "$ELIG" != "1" ]; then echo "=== NO ABLATION PASSED THE VALIDATION GATE: no full run"; exit 0; fi
CFG=$(python scripts/f0611_cfg.py "$D/runs/$BEST/run.json")
read -r H HW ES MIX TW <<< "$CFG"
FW=${FULL_WINDOWS:-400000}
if ! step full; then ts full
  T --run F00611_FULL --stage full --init $INIT --windows $FW --human-share $H --human-weight $HW --es-w $ES --mix $MIX --token-weight $TW \
    --eval-every 1200 --min-epochs-before-stop 0.75 --patience 3
  done_ full; fi
S --summary > /dev/null
if ! step lock; then ts lock; python -W ignore scripts/f0611_lockeval.py lock --run F00611_FULL --parent "$BP" 2>&1 | tee $LOG/lock.log; done_ lock; fi
if ! step final_eval; then ts final_eval; python -W ignore scripts/f0611_lockeval.py final 2>&1 | tee $LOG/final_eval.log; done_ final_eval; fi
echo "=== F006.1.1 PIPELINE COMPLETE $(date -u +%T)"
