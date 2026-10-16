"""Generate notebooks/colab_train.ipynb (GPU training on Colab, state persisted in Google Drive).

Code is cloned from the public repo; MyDrive/turniting/workdir/ keeps dataset, checkpoints, models,
reports and logs. CPU-run reference manifests + frozen eval ids live in training/datasets/manifests/.
"""

from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "notebooks" / "colab_train.ipynb"
cells: list[dict] = []


def md(src: str) -> None:
    cells.append({"cell_type": "markdown", "metadata": {}, "source": src})


def code(src: str) -> None:
    cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": src})


md("""# Turniting AI Detector — GPU training (Colab)

Full transformer recipe (`configs/training_gpu.yaml`: mDeBERTa-v3-base, 512 tokens, stride 128, all layers,
AMP, ~150k windows, 3 epochs) on `TURNITING_DATASET_V1`.

Code comes from the public repo (branch `exp/ai-detector-training`); `MyDrive/turniting/workdir/` keeps the
dataset, checkpoints, models, reports and logs (persistent). Reference manifests and the frozen evaluation ids
of the CPU run are versioned in `training/datasets/manifests/`.
The dataset is rebuilt from the official public sources with the same scripts and seed, and checked against
the reference split counts. Re-running all cells resumes from `last` after a disconnect.

Independent detector — not a Turnitin model. No Turnitin reports or private documents are used.""")

code("""# 1. Hardware audit
!nvidia-smi
import torch, shutil, psutil
print('torch', torch.__version__, '| cuda available', torch.cuda.is_available(), '| cuda', torch.version.cuda)
if torch.cuda.is_available():
    p = torch.cuda.get_device_properties(0)
    print('GPU', p.name, f'{p.total_memory/1e9:.1f} GB', '| bf16', torch.cuda.is_bf16_supported())
print(f'RAM {psutil.virtual_memory().total/1e9:.1f} GB | disk free {shutil.disk_usage("/content").free/1e9:.1f} GB')
assert torch.cuda.is_available(), 'Runtime is CPU: switch to a GPU runtime before training'""")

code("""# 2. Drive
from google.colab import drive
drive.mount('/content/drive')
import os, json, shutil
DRIVE = '/content/drive/MyDrive/turniting'
W = f'{DRIVE}/workdir'
for sub in ['checkpoints', 'models/baseline', 'reports/eval', 'logs', 'datasets']:
    os.makedirs(f'{W}/{sub}', exist_ok=True)
print(sorted(os.listdir(DRIVE)))""")

code("""# 3. Code + dependencies
if not os.path.exists('/content/Turniting/.git'):
    !git clone -q --branch exp/ai-detector-training https://github.com/Anthgg/Turniting.git /content/Turniting
else:
    !git -C /content/Turniting fetch -q origin exp/ai-detector-training && git -C /content/Turniting checkout -q exp/ai-detector-training && git -C /content/Turniting pull -q --ff-only
%cd /content/Turniting/training
!pip -q install transformers==4.46.3 accelerate==1.1.1 sentencepiece==0.2.0 langid==1.1.6 datasketch==1.6.5 tiktoken protobuf
!git log --oneline -1""")

code("""# 4. Dataset: rebuild TURNITING_DATASET_V1 from the official sources once; persist master to Drive
!mkdir -p /content/ref && cp datasets/manifests/split_manifest.json datasets/manifests/master_manifest.json datasets/manifests/eval_sets.parquet datasets/manifests/spanish_weight_selection.json /content/ref/
if not os.path.exists(f'{W}/datasets/normalized/master/train'):
    !python scripts/download_datasets.py 2>&1 | grep -E '==|->' | tail -n 30
    !python scripts/build_dataset.py 2>&1 | grep -E 'stage1 |exact|near|groups|leakage|done|Error|Traceback' | tail -n 40
    shutil.copytree('datasets/normalized/master', f'{W}/datasets/normalized/master', dirs_exist_ok=True)
    for f in ['split_manifest.parquet', 'index.parquet', 'stage2_summary.json']:
        shutil.copy2(f'datasets/normalized/{f}', f'{W}/datasets/normalized/{f}')
    shutil.copytree('datasets/manifests', f'{W}/datasets/manifests', dirs_exist_ok=True)
    shutil.copytree('reports', f'{W}/reports/rebuild', dirs_exist_ok=True)
!rm -rf datasets/normalized && ln -s {W}/datasets/normalized datasets/normalized
!cp {W}/datasets/manifests/*.json datasets/manifests/ && ls datasets/normalized/master""")

code("""# 5. Verify the rebuild matches the CPU-run reference
ref = json.load(open('/content/ref/split_manifest.json'))
new = json.load(open('datasets/manifests/split_manifest.json'))
print('reference splits:', ref['split_counts'])
print('rebuilt splits  :', new['split_counts'])
print('reference status:', ref['status_counts'])
print('rebuilt status  :', new['status_counts'])
SAME = ref['split_counts'] == new['split_counts'] and ref['status_counts'] == new['status_counts']
print('IDENTICAL SPLITS' if SAME else 'WARNING: splits differ from the CPU run -> eval sets rebuilt from this master')""")

code("""# 6. Persistent models/checkpoints + frozen evaluation ids
!rm -rf checkpoints models && ln -s {W}/checkpoints checkpoints && ln -s {W}/models models
!cp -n /content/ref/spanish_weight_selection.json models/baseline/spanish_weight_selection.json
if SAME and not os.path.exists('models/eval_sets.parquet'):
    shutil.copy2('/content/ref/eval_sets.parquet', 'models/eval_sets.parquet')  # same rows as the CPU run
import pandas as pd
if os.path.exists('models/eval_sets.parquet'):
    print(pd.read_parquet('models/eval_sets.parquet').eval_set.value_counts())""")

code("""# 7. Experiment ids (persisted for resume)
import time
ids_file = f'{W}/experiment_ids.json'
if os.path.exists(ids_file):
    ids = json.load(open(ids_file))
else:
    stamp = time.strftime('%Y%m%d_%H%M')
    ids = {'global': f'{stamp}_mdeberta_gpu_v1', 'refine': f'{stamp}_mdeberta_gpu_es_acad_v1'}
    json.dump(ids, open(ids_file, 'w'))
print(ids)""")

code("""# 8. Sampling audit BEFORE training (aborts if RAID / Iber / AuTex are missing)
!python scripts/train_transformer.py --config configs/training_gpu.yaml --mode global --dry-run-sample --experiment-id dryrun_gpu 2>&1 | grep -E 'sample audit|dry run|ABORT|Error|Traceback'
!cp checkpoints/dryrun_gpu/sample_audit.json {W}/reports/sample_audit_global.json""")

code("""# 9. Training helper: streams to a Drive log, resumes from last/ after a disconnect
import re, subprocess
SHOW = re.compile(r'EVAL|done:|early stopping|Error|Traceback|ABORT|sample audit|resum|step (\\d+)00/')
def train(mode, exp_id, extra=()):
    exp = f'checkpoints/{exp_id}'
    if os.path.exists(f'{exp}/experiment.json'):
        print(exp_id, 'already finished'); return
    args = ['python', 'scripts/train_transformer.py', '--config', 'configs/training_gpu.yaml', '--mode', mode]
    if os.path.exists(f'{exp}/last/trainer_state.pt'):
        args += ['--resume-from-checkpoint', f'{exp}/last']
    else:
        args += ['--experiment-id', exp_id, *extra]
    log = f'{W}/logs/{exp_id}.log'
    print(' '.join(args), '->', log)
    with open(log, 'a') as fh:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in proc.stdout:
            fh.write(line); fh.flush()
            if SHOW.search(line):
                print(line, end='', flush=True)
    assert proc.wait() == 0, f'training failed, see {log}'""")

code("""# 10. GLOBAL_MULTILINGUAL_TRANSFORMER
train('global', ids['global'])""")

code("""# 11. SPANISH_ACADEMIC_TRANSFORMER (from global best; 70 % Spanish/academic + 30 % replay; lr 1e-5)
train('refine', ids['refine'], ['--init-from', f"checkpoints/{ids['global']}/best"])""")

code("""# 12. Package + calibrate (VALIDATION only)
g, r = ids['global'], ids['refine']
!python scripts/calibrate.py --experiment checkpoints/{g} --out models/gpu/global --name GLOBAL_MULTILINGUAL_TRANSFORMER_GPU
!python scripts/calibrate.py --experiment checkpoints/{r} --out models/gpu/spanish_academic --name SPANISH_ACADEMIC_TRANSFORMER_GPU
!python scripts/calibrate.py --experiment checkpoints/{r} --out models/gpu/calibrated_spanish_academic --name CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER_GPU --calibrate""")

code("""# 13. VALIDATION only (model choice)
GPU_MODELS = [('GLOBAL_MULTILINGUAL_TRANSFORMER_GPU', 'models/gpu/global'),
              ('SPANISH_ACADEMIC_TRANSFORMER_GPU', 'models/gpu/spanish_academic'),
              ('CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER_GPU', 'models/gpu/calibrated_spanish_academic')]
for name, path in GPU_MODELS:
    !python scripts/evaluate.py --model {path} --name {name}__validation 2>&1 | grep -E 'macroF1|Error|Traceback'
!cp -r reports/eval/* {W}/reports/eval/""")

code("""# 14. TEST-side sets, once, after the validation choice
for name, path in GPU_MODELS:
    !python scripts/evaluate.py --model {path} --name {name} --final 2>&1 | grep -E 'macroF1|Error|Traceback'
!cp -r reports/eval/* {W}/reports/eval/ && cp checkpoints/*/experiment.json checkpoints/*/train_log.jsonl {W}/reports/ 2>/dev/null
!for d in checkpoints/*/; do n=$(basename $d); cp $d/experiment.json {W}/reports/$n.experiment.json 2>/dev/null; cp $d/train_log.jsonl {W}/reports/$n.train_log.jsonl 2>/dev/null; cp $d/sample_audit.json {W}/reports/$n.sample_audit.json 2>/dev/null; done
!ls {W}/reports {W}/reports/eval""")

nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"provenance": []},
      "kernelspec": {"display_name": "Python 3", "name": "python3"}, "language_info": {"name": "python"}},
      "nbformat": 4, "nbformat_minor": 0}
OUT.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
print(OUT)
