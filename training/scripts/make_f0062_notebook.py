"""Writes training/notebooks/colab_f006_2.ipynb (F006.2, Track A). Run: python training/scripts/make_f0062_notebook.py"""

from __future__ import annotations

import json
from pathlib import Path

BRANCH = "exp/f006-2-modern-spanish-academic-hardening"
MD = """# F006.2 — Spanish academic + modern generator hardening (Track A: AI writing detection)

Runs from scratch on a fresh Colab VM and resumes after a disconnect (re-run cells 1-9, then 10). Drive
`MyDrive/turniting/f006_2/` keeps raw / normalized / split datasets, manifests, checkpoints, final models, reports and logs.
Historical paths (V2, V3, F006.1, F006.1.1, ENSEMBLE_V2_V3) are read-only. Track B (similarity) has its own notebook and branch.

Pipeline order (scripts/f0062_pipeline.sh): approved sources -> Claude training data -> normalise / dedup / leakage audit ->
freeze splits + FINAL_EXTERNAL_HOLDOUT -> baseline F006.1.1 + hard-example mining -> candidate A (continual FT) ->
candidate B (continual FT + replay) -> compare on VALIDATION -> calibrate (CALIBRATION) -> select -> MODEL_LOCK ->
FINAL_EXTERNAL_HOLDOUT once -> reports -> model saved on Drive (EXPERIMENTAL only).
Research use only. Never a Turnitin score; no Turnitin data, private documents or user theses are used."""

CELLS = [
    ("code", """# 1. Mount Google Drive (needs your click)
from google.colab import drive
drive.mount('/content/drive')"""),
    ("code", f"""# 2. Paths (new independent area; historical paths are read-only)
import os, json, shutil, subprocess, hashlib
T = '/content/drive/MyDrive/turniting'
D = f'{{T}}/f006_2'
for s in ['datasets/raw', 'datasets/normalized', 'datasets/splits', 'datasets/manifests', 'models/checkpoints', 'models/final', 'reports', 'logs']:
    os.makedirs(f'{{D}}/{{s}}', exist_ok=True)
REPO, BRANCH = '/content/Turniting', '{BRANCH}'
print(sorted(os.listdir(T)))"""),
    ("code", """# 3. Clone or update the repository (code only; Colab never pushes)
if not os.path.exists(f'{REPO}/.git'):
    !git clone -q --branch {BRANCH} https://github.com/Anthgg/Turniting.git {REPO}
else:
    !git -C {REPO} fetch -q origin {BRANCH} && git -C {REPO} checkout -q {BRANCH} && git -C {REPO} reset -q --hard origin/{BRANCH}
%cd /content/Turniting/training
!git log --oneline -1"""),
    ("code", """# 4. Dependencies
!pip -q install transformers==4.46.3 accelerate==1.1.1 sentencepiece==0.2.0 datasketch==1.6.5 protobuf anthropic
import transformers, anthropic; print('transformers', transformers.__version__, '| anthropic', anthropic.__version__)"""),
    ("code", """# 5-9. GPU: name, VRAM, CUDA, bf16 / fp16
import torch
assert torch.cuda.is_available(), 'switch the runtime to a GPU'
p = torch.cuda.get_device_properties(0)
BF16 = torch.cuda.is_bf16_supported()
print('GPU =', p.name); print('VRAM =', f'{p.total_memory/2**30:.1f} GiB'); print('CUDA =', torch.version.cuda)
print('PRECISION =', 'bf16' if BF16 else 'fp16 (+ loss scaling)')
!nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv"""),
    ("code", """# 10. Validate Drive paths and the historical models F006.2 needs (read-only)
need = {'F006.1.1 model (baseline + init)': f'{T}/f006_1_1/models/experimental_f006_1_1/model_manifest.json',
        'F006.1.1 calibration config': f'{T}/f006_1_1/reports/validation.json',
        'F006.1.1 train_extra (replay)': f'{T}/f006_1_1/datasets/f006_1_1_train_extra.parquet',
        'F006.1.1 validation (historical regression)': f'{T}/f006_1_1/datasets/f006_1_1_validation.parquet',
        'F006.1.1 final holdout (REGRESSION_HOLDOUT)': f'{T}/f006_1_1/datasets/f006_1_1_final_holdout.parquet',
        'F006.1.1 full run config': f'{T}/f006_1_1/runs/F00611_FULL/run.json',
        'V2 master (replay)': f'{T}/v3/datasets/master_v2', 'V2 index': f'{T}/v3/datasets/index_v2.parquet'}
for k, v in need.items():
    print('OK ' if os.path.exists(v) else 'MISSING', k, '->', v.replace(T, 'MyDrive/turniting'))
assert all(os.path.exists(v) for v in need.values()), 'historical inputs missing'
mm = json.load(open(need['F006.1.1 model (baseline + init)'])); print('baseline status:', mm.get('status'), mm.get('modelVersion'))"""),
    ("code", """# 11-14. Datasets, manifests / hashes and split integrity (whatever already exists on Drive; re-run any time)
M, S = f'{D}/datasets/manifests', f'{D}/datasets/splits'
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(8 << 20), b''): h.update(c)
    return h.hexdigest()
if os.path.exists(f'{M}/f006_2_sources.json'):
    for k, v in json.load(open(f'{M}/f006_2_sources.json'))['sources'].items(): print('source', k, v.get('rows'), v.get('license_status'))
hm = f'{M}/f006_2_final_external_holdout.json'
if os.path.exists(hm):
    h = json.load(open(hm))
    print('FINAL_EXTERNAL_HOLDOUT LOCKED:', h['LOCKED'], '| sha ok:', sha(f'{S}/f006_2_final_external_holdout.parquet') == h['holdout_file_sha256'])
    print('leakage:', h['leakage']['result'], h['gates'])
else:
    print('splits not frozen yet')
if os.path.exists(f'{M}/F006_2_MODEL_LOCK.json'): print('MODEL_LOCK present')"""),
    ("code", """# Anthropic key: Colab secret ANTHROPIC_API_KEY (never printed or saved). Optional: CLAUDE_GEN_MODELS, CLAUDE_MAX_USD.
ENV = dict(os.environ)
try:
    from google.colab import userdata
    k = userdata.get('ANTHROPIC_API_KEY')
    if k: ENV['ANTHROPIC_API_KEY'] = k
    print('Anthropic key available:', bool(k))
except Exception as e:
    print('Anthropic key not available:', type(e).__name__)"""),
    ("code", """# Cost / plan preview of the Claude data (no API call) — needs the TDX source; runs the source step first if needed
!python -W ignore scripts/f0062_sources.py
!python -W ignore scripts/f0062_claude.py plan"""),
    ("code", """# Launch the resumable F006.2 pipeline in the background
pid = '/content/f0062.pid'
if os.path.exists(pid) and os.path.exists(f"/proc/{open(pid).read().strip()}"):
    print('pipeline already running')
else:
    out = open('/content/f0062_pipeline.out', 'a')
    pr = subprocess.Popen(['bash', 'scripts/f0062_pipeline.sh'], stdout=out, stderr=subprocess.STDOUT, env=ENV, start_new_session=True)
    open(pid, 'w').write(str(pr.pid)); print('started pid', pr.pid)"""),
    ("code", """# Monitor (re-run any time)
!tail -n 30 /content/f0062_pipeline.out; echo; ls {D}/logs
!nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv"""),
    ("code", """# Report bundle for Git (download it and hand it to Claude; Colab cannot push)
!python -W ignore scripts/f0062_report.py
!tar czf {D}/f006_2_reports_bundle.tgz -C /content/Turniting/training reports/f006_2 reports/F006_2_FINAL_REPORT.md reports/F006_2_FINAL_REPORT.json reports/F006_2_HARD_EXAMPLE_AUDIT.json datasets/manifests/model_registry_f006_2.json 2>/dev/null; ls -la {D}/f006_2_reports_bundle.tgz
from google.colab import files
files.download(f'{D}/f006_2_reports_bundle.tgz')"""),
]


def main() -> None:
    cells = [{"cell_type": "markdown", "metadata": {}, "source": MD.splitlines(keepends=True)}]
    for kind, src in CELLS:
        cells.append({"cell_type": kind, "metadata": {}, "execution_count": None, "outputs": [], "source": src.splitlines(keepends=True)})
    nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"gpuType": "A100", "provenance": []}, "kernelspec": {"display_name": "Python 3", "name": "python3"},
                                       "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 0}
    out = Path(__file__).resolve().parents[1] / "notebooks" / "colab_f006_2.ipynb"
    out.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
