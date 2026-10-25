#!/usr/bin/env bash
# F006.3 data stage on Colab: new sources + open-generator multilingual AI text. Resumable (.done markers + per-row custom_id).
# vLLM is tried in an isolated venv (/content/vllm_env) so the training environment's torch is never replaced;
# if it cannot be installed the generator falls back to transformers.generate.
set -uo pipefail
cd "$(dirname "$0")/.."
D=/content/drive/MyDrive/turniting/f006_3
LOG=$D/logs
mkdir -p "$D"/datasets/{raw,normalized,multilingual,mixed_language,splits,manifests} "$D"/models/{checkpoints,final} "$D"/{evaluation,reports,logs}
step() { [ -f "$LOG/$1.done" ]; }
done_() { date -u +%FT%TZ > "$LOG/$1.done"; echo "=== STEP $1 DONE $(date -u +%T)"; }
pip -q install langid > /dev/null 2>&1
PY=python
if [ ! -x /content/vllm_env/bin/python ]; then
  python -m venv /content/vllm_env && /content/vllm_env/bin/pip -q install vllm pandas pyarrow langid huggingface_hub > /content/vllm_install.log 2>&1 \
    || echo "=== vLLM venv install failed (see /content/vllm_install.log); using transformers"
fi
/content/vllm_env/bin/python -c "import vllm, torch; assert torch.cuda.is_available(); print('vllm', vllm.__version__)" 2>/dev/null && PY=/content/vllm_env/bin/python
echo "=== generator python: $PY"
if ! step sources; then echo "=== STEP sources START $(date -u +%T)"; python -W ignore scripts/f0063_sources.py 2>&1 | tee -a $LOG/sources.log && done_ sources; fi
for G in qwen2.5-14b mistral-nemo-12b olmo2-7b phi3.5-mini granite3.1-8b; do
  if ! step gen_$G; then
    echo "=== STEP gen_$G START $(date -u +%T)"
    $PY -W ignore scripts/f0063_gen_open.py --gen $G 2>&1 | grep --line-buffered -v -i "warn\|it/s\]" | tee -a $LOG/gen_$G.log \
      && done_ gen_$G
  fi
done
echo "=== F006.3 GEN STAGE COMPLETE $(date -u +%T)"
