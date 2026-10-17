"""Generate notebooks/colab_v3.ipynb: TURNITING_DATASET_V2 + TURNITING_RESEARCH_V3 on Colab (A100) + Drive."""

from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "notebooks" / "colab_v3.ipynb"
BRANCH = "claude/project-thread-fm8si4"
cells: list[dict] = []


def md(src):
    cells.append({"cell_type": "markdown", "metadata": {}, "source": src})


def code(src):
    cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": src})


md(f"""# Turniting Research V3 — Dataset V2 + training (Colab A100)

Downloads the new public sources, builds `TURNITING_DATASET_V2` on top of V1 (V1 splits frozen),
trains `TURNITING_RESEARCH_V3` (global + Spanish/academic refinement), calibrates on validation V2,
evaluates once on the frozen tests against `CANDIDATE_MODEL_V2` and writes the report.

Everything runs here; Drive `MyDrive/turniting/v3/` keeps datasets, manifests, checkpoints, models, reports
and logs. Training reads only from `/content`. The pipeline runs in the background and is resumable
(re-run cells 1-6 after a disconnect). Research / non-commercial use only. Not a Turnitin model.""")

code("""# 1. Hardware audit
!nvidia-smi
import torch, shutil, psutil, os, platform
print('torch', torch.__version__, '| cuda', torch.version.cuda, '| bf16', torch.cuda.is_available() and torch.cuda.is_bf16_supported())
if torch.cuda.is_available():
    p = torch.cuda.get_device_properties(0); print('GPU', p.name, f'{p.total_memory/1e9:.1f} GB')
print('CPU cores', os.cpu_count(), platform.processor(), '| RAM', f'{psutil.virtual_memory().total/1e9:.1f} GB',
      '| /content free', f'{shutil.disk_usage("/content").free/1e9:.1f} GB')
assert torch.cuda.is_available(), 'switch the runtime to a GPU (A100)'""")

code("""# 2. Drive
from google.colab import drive
drive.mount('/content/drive')
D = '/content/drive/MyDrive/turniting/v3'
for s in ['datasets', 'manifests', 'checkpoints', 'models', 'reports/eval', 'logs']:
    os.makedirs(f'{D}/{s}', exist_ok=True)
u = shutil.disk_usage('/content/drive'); print(f'Drive total {u.total/1e9:.0f} GB, free {u.free/1e9:.0f} GB')
print(sorted(os.listdir('/content/drive/MyDrive/turniting')))""")

code(f"""# 3. Code + dependencies
if not os.path.exists('/content/Turniting/.git'):
    !git clone -q --branch {BRANCH} https://github.com/Anthgg/Turniting.git /content/Turniting
else:
    !git -C /content/Turniting fetch -q origin {BRANCH} && git -C /content/Turniting checkout -q {BRANCH} && git -C /content/Turniting reset -q --hard origin/{BRANCH}
%cd /content/Turniting/training
!pip -q install transformers==4.46.3 accelerate==1.1.1 sentencepiece==0.2.0 langid==1.1.6 datasketch==1.6.5 tiktoken protobuf openpyxl
!git log --oneline -1""")

code("""# 4. Optional HF token for gated sources (MGTPD, EditLens): Colab Secrets -> HF_TOKEN. Never printed.
ENV = dict(os.environ)
try:
    from google.colab import userdata
    tok = userdata.get('HF_TOKEN')
    if tok:
        ENV['HF_TOKEN'] = tok
    print('HF token available:', bool(tok))
except Exception as e:
    print('HF token not available (gated sources -> BLOCKED_ACCESS)')""")

code("""# 5. V1 check (reused, not downloaded again)
import json, glob, pyarrow.parquet as pq
V1 = '/content/drive/MyDrive/turniting/workdir'
man = json.load(open(f'{V1}/datasets/manifests/master_manifest.json'))
files = sorted(glob.glob(f'{V1}/datasets/normalized/master/*/*.parquet'))
rows = sum(pq.ParquetFile(f).metadata.num_rows for f in files)
print('V1 shards', len(files), '/', len(man['shards']), '| rows', f'{rows:,}')
print('CANDIDATE_MODEL_V2 present:', os.path.exists(f'{V1}/models/gpu/calibrated_spanish_academic/model.safetensors'))""")

code("""# 6. Launch the resumable pipeline in the background (downloads -> V2 -> weights -> V3 -> refine -> calibrate -> eval -> report)
import subprocess
if os.path.exists('/content/v3_pipeline.pid') and os.path.exists(f"/proc/{open('/content/v3_pipeline.pid').read().strip()}"):
    print('pipeline already running')
else:
    out = open('/content/v3_pipeline.out', 'a')
    p = subprocess.Popen(['bash', 'scripts/v3_pipeline.sh'], stdout=out, stderr=subprocess.STDOUT, env=ENV, start_new_session=True)
    open('/content/v3_pipeline.pid', 'w').write(str(p.pid)); print('started pid', p.pid)""")

code("""# 7. Monitor (re-run any time)
!tail -n 25 /content/v3_pipeline.out; echo; ls /content/drive/MyDrive/turniting/v3/logs/
!nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv; free -g | head -2; df -h /content | tail -1""")

code("""# 8. Final report
print(open('/content/drive/MyDrive/turniting/v3/reports/TRAINING_V3_REPORT.md').read()[:6000])""")

nb = {"cells": cells, "metadata": {"accelerator": "GPU", "colab": {"gpuType": "A100", "provenance": []},
                                   "kernelspec": {"display_name": "Python 3", "name": "python3"}},
      "nbformat": 4, "nbformat_minor": 0}
OUT.write_text(json.dumps(nb, indent=1), encoding="utf-8")
print("wrote", OUT)
