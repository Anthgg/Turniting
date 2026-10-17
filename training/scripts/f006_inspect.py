"""F006 step 0: verify artifacts and describe TURNITING_DATASET_V2 splits (ids/metadata only, no text).

    python scripts/f006_inspect.py --v3 /content/drive/MyDrive/turniting/v3 --out /content/drive/MyDrive/turniting/f006/manifests/inspect.json
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import pandas as pd


def tree(p: Path, depth=2):
    out = {}
    if not p.exists():
        return "MISSING"
    for c in sorted(p.iterdir()):
        if c.is_dir():
            out[c.name + "/"] = tree(c, depth - 1) if depth > 1 else len(list(c.iterdir()))
        else:
            out[c.name] = round(c.stat().st_size / 1e6, 2)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--v3", default="/content/drive/MyDrive/turniting/v3")
    ap.add_argument("--v1w", default="/content/drive/MyDrive/turniting/workdir")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    v3 = Path(a.v3)
    rep = {
        "v3_models": tree(v3 / "models", 1),
        "v3_best_ckpt": tree(v3 / "checkpoints" / "20261017_0604_v3_es_acad" / "best", 1),
        "v2_model": tree(Path(a.v1w) / "models" / "gpu" / "calibrated_spanish_academic", 1),
        "v3_datasets": tree(v3 / "datasets", 1),
        "v3_manifests": tree(v3 / "manifests", 1),
    }
    idx = pd.read_parquet(v3 / "datasets" / "index_v2.parquet")
    k = idx[idx["status"] == "KEPT"]
    rep["index_columns"] = list(idx.columns)
    rep["kept_rows"] = int(len(k))
    rep["split_x_label"] = {str(s): g["fine_label"].value_counts().to_dict() for s, g in k.groupby("split")}
    rep["split_groups"] = k.groupby("split")["group_id"].nunique().to_dict()
    for s in ("unseen_generator_test", "unseen_domain_test", "ood_test", "adversarial_test", "adversarial_validation"):
        g = k[k["split"] == s]
        rep[f"{s}_by_family"] = g["generator_family"].value_counts().to_dict()
        rep[f"{s}_by_dataset"] = g.groupby(["dataset", "fine_label"]).size().astype(int).rename(lambda x: "|".join(x)).to_dict()
        rep[f"{s}_by_domain"] = g["domain"].value_counts().to_dict()
    for s in ("train", "validation", "test"):
        g = k[k["split"] == s]
        h = g[g["fine_label"] == "HUMAN"]
        rep[f"{s}_human_by_dataset"] = h["dataset"].value_counts().to_dict()
        rep[f"{s}_family"] = g["generator_family"].value_counts().to_dict()
        rep[f"{s}_es_human"] = int((h["language"] == "es").sum())
        rep[f"{s}_aca_human"] = int((h["domain"] == "academic").sum())
    ev = pd.read_parquet(v3 / "datasets" / "eval_sets_v2.parquet")
    rep["eval_sets"] = ev["eval_set"].value_counts().to_dict()
    rep["hf_token_present"] = bool(os.environ.get("HF_TOKEN"))
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(rep, indent=1, default=str))
    print(json.dumps({k_: v for k_, v in rep.items() if not k_.endswith("_by_dataset")}, indent=1, default=str)[:20000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
