"""F006: HARD_HUMAN_POOL mined ONLY from TRAIN humans (never validation / test / holdout).

    python scripts/f006_hard_humans.py --master /content/f006work/master_v2 --model <v3 model dir> \
        --out /content/drive/MyDrive/turniting/f006 --tag hard_human_pool_v1 [--n 400000]

* a dataset/language/domain-stratified sample of TRAIN humans is scored by the model (canonical view);
* the cut-off is read from the score distribution (top 15 % of the sampled humans), not fixed blindly;
  the shares above raw P=0.40 / 0.50 and above the model's own BALANCED threshold are reported;
* diversity: no source dataset may exceed 12 % of the pool (its hardest rows are kept).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import categorical_to_str, log, write_json  # noqa: E402
from f006_splits import cap  # noqa: E402

TOP_FRAC = 0.15
DATASET_CAP = 0.12


def score(model_dir: Path, texts: list[str], max_windows: int = 4) -> np.ndarray:
    import torch
    from transformers import AutoTokenizer

    from turniting_train.v3model import V3Detector

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = V3Detector.load(model_dir, dev)
    tok = AutoTokenizer.from_pretrained(model_dir / "backbone")
    icfg = json.loads((model_dir / "inference_config.json").read_text())
    from f006_score import doc_logits

    t0 = time.time()
    out = doc_logits(model, tok, texts, "canonical", icfg.get("aggregation", "mean"), max_windows, device=dev)
    log(f"  scored {len(texts):,} docs in {time.time() - t0:.0f}s")
    del model
    torch.cuda.empty_cache()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", default="/content/f006work/master_v2")
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", default="/content/drive/MyDrive/turniting/f006")
    ap.add_argument("--tag", default="hard_human_pool_v1")
    ap.add_argument("--n", type=int, default=400000)
    ap.add_argument("--repo-reports", default=str(Path(__file__).resolve().parents[1] / "reports" / "f006"))
    a = ap.parse_args()
    out = Path(a.out)
    pool_path = out / "datasets" / f"{a.tag}.parquet"
    if pool_path.exists():
        log(f"{pool_path} exists; skipping")
        return 0
    master = Path(a.master)
    ds = pads.dataset(str(master / "train"), format="parquet")
    meta = categorical_to_str(ds.to_table(columns=["id", "dataset", "fine_label", "language", "domain", "n_words"],
                                          filter=pc.field("fine_label") == "HUMAN").to_pandas())
    meta["len_bin"] = pd.cut(meta["n_words"], [0, 50, 150, 400, 10**9], labels=["<50", "50-150", "150-400", "400+"]).astype(str)
    log(f"TRAIN humans: {len(meta):,}")
    sample = cap(meta, a.n, ["dataset", "language", "domain", "len_bin"], 606)
    texts = ds.to_table(columns=["id", "text_original"], filter=pc.field("id").isin(sample["id"].tolist())).to_pandas()
    sample = sample.merge(texts, on="id")
    log(f"scoring {len(sample):,} TRAIN humans with {a.model}")
    sample["logit"] = score(Path(a.model), sample["text_original"].tolist())
    sample = sample.drop(columns=["text_original"])
    p = 1 / (1 + np.exp(-sample["logit"].values))
    th_path = Path(a.model) / "thresholds.json"
    bal = json.loads(th_path.read_text()).get("BALANCED", {}).get("threshold") if th_path.exists() else None
    cut = float(np.percentile(sample["logit"], 100 * (1 - TOP_FRAC)))
    cand = sample[sample["logit"] >= cut].sort_values("logit", ascending=False)
    limit = int(DATASET_CAP * len(cand))
    pool = cand.groupby("dataset", group_keys=False).head(limit)
    q = [0.5, 0.75, 0.85, 0.9, 0.95, 0.99]
    analysis = {
        "tag": a.tag, "model": Path(a.model).name, "source_split": "train (TRAIN humans only)",
        "scored_humans": int(len(sample)), "train_humans_available": int(len(meta)),
        "raw_prob_quantiles": {str(k): float(np.quantile(p, k)) for k in q},
        "share_raw_prob_ge_0.40": float((p >= 0.40).mean()), "share_raw_prob_ge_0.50": float((p >= 0.50).mean()),
        "model_balanced_threshold": bal, "share_ge_model_balanced": float((p >= bal).mean()) if bal is not None else None,
        "cutoff_rule": f"top {TOP_FRAC:.0%} of sampled TRAIN humans by doc logit", "cutoff_logit": cut,
        "cutoff_raw_prob": float(1 / (1 + np.exp(-cut))),
        "dataset_cap": f"<= {DATASET_CAP:.0%} of the candidate set per source dataset ({limit:,} rows)",
        "pool_size": int(len(pool)), "candidates_before_cap": int(len(cand)),
        "pool_by_dataset": pool["dataset"].value_counts().to_dict(),
        "pool_by_language": pool["language"].value_counts().head(15).to_dict(),
        "pool_by_domain": pool["domain"].value_counts().to_dict(),
        "pool_by_length": pool["len_bin"].value_counts().to_dict(),
        "pool_spanish": int((pool["language"] == "es").sum()), "pool_academic": int((pool["domain"] == "academic").sum()),
        "fp_rate_by_dataset_at_cutoff": sample.assign(h=sample["logit"] >= cut).groupby("dataset")["h"].mean().round(4).to_dict(),
    }
    pool_path.parent.mkdir(parents=True, exist_ok=True)
    pool[["id", "dataset", "language", "domain", "len_bin", "logit"]].to_parquet(pool_path, index=False)
    sample[["id", "dataset", "language", "domain", "logit"]].to_parquet(out / "datasets" / f"{a.tag}_scored_sample.parquet", index=False)
    write_json(out / "reports" / f"{a.tag}_analysis.json", analysis)
    write_json(Path(a.repo_reports) / f"{a.tag}_analysis.json", analysis)
    log(f"{a.tag}: {len(pool):,} hard TRAIN humans (cut raw P>={analysis['cutoff_raw_prob']:.3f}); "
        f"share>=0.5: {analysis['share_raw_prob_ge_0.50']:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
