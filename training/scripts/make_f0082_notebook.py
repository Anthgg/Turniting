"""Writes training/notebooks/colab_f008_2.ipynb (F008.2, Track B). Run: python training/scripts/make_f0082_notebook.py"""

from __future__ import annotations

import json
from pathlib import Path

BRANCH = "exp/f008-2-paraphrase-similarity-training"
MD = """# F008.2 — Paraphrase + translated similarity training (Track B: textual similarity)

Separate from Track A (AI detection): own branch, datasets, models and Drive area `MyDrive/turniting/f008_2/`.
Frozen references (BM25, BGE-M3, multilingual-E5, bge-reranker-v2-m3) and every F008 result stay untouched.
Order (scripts/f0082_pipeline.sh): Claude training pairs -> download approved pair datasets -> normalise -> parent grouping ->
dedup -> leakage audit -> freeze splits + holdout -> bi-encoder -> reranker -> hybrid evaluation -> select -> MODEL_LOCK ->
final holdout once -> reports -> models on Drive (EXPERIMENTAL only). Re-run cells 1-8 after a disconnect, then the launch cell."""

CELLS = [
    ("code", "# 1. Mount Google Drive (needs your click)\nfrom google.colab import drive\ndrive.mount('/content/drive')"),
    ("code", f"""# 2. Paths
import os, json, subprocess, hashlib
T = '/content/drive/MyDrive/turniting'
D = f'{{T}}/f008_2'
for s in ['datasets/raw', 'datasets/pairs', 'datasets/splits', 'datasets/manifests', 'models/biencoder', 'models/reranker', 'models/checkpoints', 'models/final', 'reports', 'logs']:
    os.makedirs(f'{{D}}/{{s}}', exist_ok=True)
REPO, BRANCH = '/content/repo_f0082', '{BRANCH}'"""),
    ("code", """# 3. Clone or update the repository (Colab never pushes)
if not os.path.exists(f'{REPO}/.git'):
    !git clone -q --branch {BRANCH} https://github.com/Anthgg/Turniting.git {REPO}
else:
    !git -C {REPO} fetch -q origin {BRANCH} && git -C {REPO} checkout -q {BRANCH} && git -C {REPO} reset -q --hard origin/{BRANCH}
%cd /content/repo_f0082/training
!git log --oneline -1"""),
    ("code", """# 4. Dependencies
!pip -q install -U "sentence-transformers>=4.1" datasets anthropic datasketch faiss-cpu
import sentence_transformers, anthropic; print('sentence-transformers', sentence_transformers.__version__, '| anthropic', anthropic.__version__)"""),
    ("code", """# 5-9. GPU: name, VRAM, CUDA, bf16 / fp16
import torch
assert torch.cuda.is_available(), 'switch the runtime to a GPU'
p = torch.cuda.get_device_properties(0)
print('GPU =', p.name); print('VRAM =', f'{p.total_memory/2**30:.1f} GiB'); print('CUDA =', torch.version.cuda)
print('PRECISION =', 'bf16' if torch.cuda.is_bf16_supported() else 'fp16')"""),
    ("code", """# 10-12. Drive paths, frozen references and historical F008 artefacts (read-only)
for k, v in {'F008 model lock (frozen ZS reference)': f'{T}/f008/manifests/F008_MODEL_LOCK.json', 'F008 datasets (distractors)': f'{T}/f008/datasets'}.items():
    print('OK ' if os.path.exists(v) else 'MISSING (non-blocking)', k)
M = f'{D}/datasets/manifests'
if os.path.exists(f'{M}/f008_2_final_external_holdout.json'):
    h = json.load(open(f'{M}/f008_2_final_external_holdout.json')); print('holdout LOCKED', h['LOCKED'], '| leakage', h['leakage']['result'])"""),
    ("code", """# 13-14. Hashes / split integrity (after the split step)
def sha(p):
    x = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(8 << 20), b''): x.update(c)
    return x.hexdigest()
for k in ['train', 'validation', 'calibration', 'final_external_holdout']:
    mf = f'{M}/f008_2_{k}.json'
    if os.path.exists(mf):
        print(k, json.load(open(mf))['pairs'], 'sha ok:', sha(f'{D}/datasets/splits/f008_2_{k}.parquet') == json.load(open(mf))['file_sha256'])"""),
    ("code", """# Anthropic key from the Colab secret ANTHROPIC_API_KEY (never printed or saved)
ENV = dict(os.environ)
try:
    from google.colab import userdata
    k = userdata.get('ANTHROPIC_API_KEY')
    if k: ENV['ANTHROPIC_API_KEY'] = k
    print('Anthropic key available:', bool(k))
except Exception as e:
    print('Anthropic key not available:', type(e).__name__)
!python scripts/f0082_claude.py plan"""),
    ("code", """# Launch the resumable F008.2 pipeline in the background
pid = '/content/f0082.pid'
if os.path.exists(pid) and os.path.exists(f"/proc/{open(pid).read().strip()}"):
    print('pipeline already running')
else:
    out = open('/content/f0082_pipeline.out', 'a')
    pr = subprocess.Popen(['bash', 'scripts/f0082_pipeline.sh'], stdout=out, stderr=subprocess.STDOUT, env=ENV, start_new_session=True)
    open(pid, 'w').write(str(pr.pid)); print('started pid', pr.pid)"""),
    ("code", "# Monitor\n!tail -n 30 /content/f0082_pipeline.out; ls {D}/logs\n!nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv"),
    ("code", """# Report bundle (download it and hand it to Claude; Colab cannot push)
!python -W ignore scripts/f0082_report.py
!tar czf {D}/f008_2_reports_bundle.tgz -C /content/repo_f0082/training reports/f008_2 reports/F008_2_FINAL_REPORT.md reports/F008_2_FINAL_REPORT.json 2>/dev/null; ls -la {D}/f008_2_reports_bundle.tgz
from google.colab import files
files.download(f'{D}/f008_2_reports_bundle.tgz')"""),
]


def main() -> None:
    cells = [{"cell_type": "markdown", "metadata": {}, "source": MD.splitlines(keepends=True)}]
    cells += [{"cell_type": k, "metadata": {}, "execution_count": None, "outputs": [], "source": s.splitlines(keepends=True)} for k, s in CELLS]
    nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"gpuType": "A100", "provenance": []}, "kernelspec": {"display_name": "Python 3", "name": "python3"},
                                       "language_info": {"name": "python"}}, "nbformat": 4, "nbformat_minor": 0}
    out = Path(__file__).resolve().parents[1] / "notebooks" / "colab_f008_2.ipynb"
    out.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
