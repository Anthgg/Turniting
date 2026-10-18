#!/usr/bin/env bash
# Rebuild a fresh Colab VM after a recycle and resume the pending work (F008 final, F006.1.2).
# Needs Drive mounted at /content/drive. Everything durable lives on Drive; this only restores /content scratch.
#   bash colab_resume.sh            (run from anywhere; logs in /content/*.log)
set -euo pipefail
R=https://github.com/Anthgg/Turniting.git
T=/content/drive/MyDrive/turniting
for spec in "repo:exp/f006-1-1-detector-hardening" "repo_b:exp/f008-similarity-training" "repo_c:exp/f006-1-2-span-localization"; do
  d=/content/${spec%%:*}; b=${spec#*:}
  [ -d "$d/.git" ] || git clone -q --branch "$b" "$R" "$d"
  git -C "$d" pull -q origin "$b"
done
pip -q install -U FlagEmbedding faiss-cpu py-spy >/dev/null 2>&1 || true
command -v unrar >/dev/null || (apt-get -qq update && apt-get -qq install -y unrar) >/dev/null 2>&1
# master_v2 (F006.1.2 replay windows)
if [ ! -f /content/f006work/master_v2/.complete ]; then
  mkdir -p /content/f006work/master_v2 && rsync -a $T/v3/datasets/master_v2/ /content/f006work/master_v2/ && touch /content/f006work/master_v2/.complete
fi
# F008 scratch: parquet copies from Drive + PAN-PC-11 text (re-download; the extraction paths are reproducible)
mkdir -p /content/f008work
cp -n $T/f008/datasets/*.parquet /content/f008work/ 2>/dev/null || true
GPU_GB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
BATCH=64; [ "$GPU_GB" -lt 60000 ] && BATCH=32
echo "GPU memory ${GPU_GB} MiB -> F006.1.2 batch $BATCH"
# F006.1.2 pipeline (resumable: finished steps / runs are skipped)
cd /content/repo_c/training
F0612_BATCH=$BATCH PYTHONUNBUFFERED=1 nohup python -W ignore scripts/f0612_pipeline.py >> /content/f0612_pipeline.out 2>&1 &
# F008: PAN text, passages, embeddings, then the single locked final evaluation
cd /content/repo_b/training
PYTHONUNBUFFERED=1 nohup sh -c 'python -W ignore scripts/f008_data.py pan2011_pan_pc_11 && python -W ignore scripts/f008_eval.py encode && python -W ignore scripts/f008_eval.py final' >> /content/f008_final.log 2>&1 &
echo "resumed: F006.1.2 -> /content/f0612_pipeline.out ; F008 -> /content/f008_final.log"
