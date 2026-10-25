#!/usr/bin/env bash
# F006.3 MULTILINGUAL ACADEMIC + MODERN GENERATOR HARDENING (Track A only). Run AFTER f0063_gen_stage.sh. Resumable: .done markers on
# Drive; training resumes from the Drive `last` checkpoint (model + optimizer + scheduler + step).
#   python -c "import subprocess; subprocess.Popen(['bash','scripts/f0063_pipeline.sh'], stdout=open('/content/f0063_pipeline.out','a'), stderr=subprocess.STDOUT, start_new_session=True)"
set -euo pipefail
cd "$(dirname "$0")/.."
T=/content/drive/MyDrive/turniting
D=$T/f006_3
F611=$T/f006_1_1/models/experimental_f006_1_1
F62B=$T/f006_2/models/checkpoints/runs/F0062_B/best
S=$D/datasets/splits
S62=$T/f006_2/datasets/splits
LOG=$D/logs
mkdir -p "$D"/datasets/{raw,normalized,multilingual,mixed_language,splits,manifests} "$D"/models/{checkpoints,final} "$D"/{evaluation,reports,logs} reports/f006_3
step() { [ -f "$LOG/$1.done" ]; }
done_() { date -u +%FT%TZ > "$LOG/$1.done"; echo "=== STEP $1 DONE $(date -u +%T)"; }
ts() { echo "=== STEP $1 START $(date -u +%T)"; }
pip -q install langid > /dev/null 2>&1 || true
for G in qwen2.5-14b mistral-nemo-12b olmo2-7b phi3.5-mini granite3.1-8b; do
  step gen_$G || { echo "=== STOP: generator $G not finished (run f0063_gen_stage.sh first)"; exit 2; }
done
if [ ! -f /content/f006work/master_v2/.complete ]; then
  mkdir -p /content/f006work/master_v2 && rsync -a $T/v3/datasets/master_v2/ /content/f006work/master_v2/ && touch /content/f006work/master_v2/.complete
fi

if ! step claude; then ts claude  # Claude Code subagent outputs (auxiliary; never FINAL)
  SG=datasets/selfgen/f006_3_selfgen_outputs.tgz
  [ -f "$SG" ] || { echo "=== STOP: $SG missing"; exit 2; }
  rm -rf /content/selfgen_f0063 && mkdir -p /content/selfgen_f0063 && tar xzf "$SG" -C /content/selfgen_f0063
  python -W ignore scripts/f0063_selfgen.py collect --out /content/selfgen_f0063 2>&1 | tee -a $LOG/claude.log
  cp /content/selfgen_f0063/claude_multilingual.parquet $D/datasets/normalized/claude_multilingual.parquet
  done_ claude; fi
if ! step splits; then ts splits; python -W ignore scripts/f0063_splits.py 2>&1 | tee -a $LOG/splits.log; done_ splits; fi

read -r _H HW ES _MIX TW <<< "$(python scripts/f0611_cfg.py $T/f006_1_1/runs/F00611_FULL/run.json)"
LR=${F0063_LR:-5e-6}
W=${F0063_WINDOWS:-180000}
COMMON=(--stage full --init $F62B --icfg-from $F611/inference_config.json --drive $D/models/checkpoints --val $S/f006_3_validation.parquet
        --train-extra $S/f006_3_train_extra.parquet --hard-pool $S62/f006_2_hard_human_pool.parquet --es-hard-pool $S62/f006_2_spanish_hard_pool.parquet
        --mixture f006_3 --score f006_3 --loss weighted --human-weight $HW --es-w $ES --token-weight $TW --aca-w 1.5 --hard-ratio 0.3
        --para-frac 0.35 --lr $LR --windows $W --eval-every ${F0063_EVAL_EVERY:-500} --min-epochs-before-stop 0.5 --patience 3
        --local /content/turniting-f0063/ckpt --cache-root /content/turniting-f0063/cache)
# pre-registered mixtures (replay, new_human, new_machine, mixed, ai_edited, robustness); fixed before training
declare -A MIX=([B1]=0.25,0.30,0.22,0.12,0.08,0.03 [B2]=0.40,0.24,0.17,0.10,0.06,0.03 [B3]=0.55,0.18,0.12,0.08,0.05,0.02
                [B4]=0.40,0.24,0.17,0.10,0.06,0.03 [B5]=0.40,0.24,0.17,0.10,0.06,0.03)
declare -A EXTRA=([B1]="" [B2]="" [B3]="" [B4]="--kd-teacher $F611 --kd-weight 0.5 --kd-temp 2.0" [B5]="--lang-balance")
for B in ${F0063_RUNS:-B1 B2 B3 B4 B5}; do
  R=F0063_$B
  python scripts/f0063_preflight.py --run $R --base-model $F62B || { echo "=== STOP_BEFORE_TRAINING"; exit 3; }
  if ! step train_$B; then ts train_$B
    # B4 holds a frozen teacher next to the student: cap the micro batch so the memory probe leaves room for it
    if [ "$B" = B4 ]; then export F006_MAX_MICRO=48; else export F006_MAX_MICRO=128; fi
    python scripts/f006_train.py --run $R --mix ${MIX[$B]} ${EXTRA[$B]} "${COMMON[@]}" 2>&1 | grep --line-buffered -v -i "warn" | tee -a $LOG/train_$B.log
    done_ train_$B; fi
done
if ! step compare; then ts compare; python -W ignore scripts/f0063_lockeval.py compare 2>&1 | tee -a $LOG/compare.log; done_ compare; fi
if ! step lock; then ts lock; python -W ignore scripts/f0063_lockeval.py lock 2>&1 | tee -a $LOG/lock.log; done_ lock; fi
if ! step final; then ts final; python -W ignore scripts/f0063_lockeval.py final 2>&1 | tee -a $LOG/final.log; done_ final; fi
python -W ignore scripts/f0063_report.py 2>&1 | tee -a $LOG/report.log
echo "=== F006.3 PIPELINE COMPLETE $(date -u +%T)"
