"""F006.1.1: HARD_HUMAN_POOL_V3 and SPANISH_HARD_POOL_V3 from TRAIN humans only, scored by V3, F006 and F006.1.

    python scripts/f0611_pools.py

Train humans = V2 TRAIN + F006_1_1 TRAIN_EXTRA (F006.1 extra + F006.1.1 new train groups). Each model's document
logit is turned into a percentile rank among the scored humans; combined = max over the three models (a human
any model finds machine-like). Global pool: top 15 % combined, <= 12 % of the pool per source dataset.
Spanish pool: top 20 % combined among Spanish train humans, <= 15 % per (dataset, domain).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_hard_humans import score  # noqa: E402
from f006_lib import categorical_to_str, log, write_json  # noqa: E402
from f006_splits import cap  # noqa: E402

D = Path("/content/drive/MyDrive/turniting/f006_1_1")
MODELS = {"V3": Path("/content/drive/MyDrive/turniting/v3/models/spanish_academic"),
          "F006": Path("/content/drive/MyDrive/turniting/f006/models/experimental_v4"),
          "F006_1": Path("/content/drive/MyDrive/turniting/f006_1/models/experimental_f006_1")}
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]


def select(f: pd.DataFrame, frac: float, by: list[str], cap_frac: float) -> pd.DataFrame:
    cut = f["combined"].quantile(1 - frac)
    cand = f[f["combined"] >= cut].sort_values("combined", ascending=False)
    lim = max(1, int(cap_frac * len(cand)))
    return cand.groupby(by, group_keys=False).head(lim)


def main() -> int:
    if (D / "datasets" / "hard_human_pool_v3.parquet").exists():
        log("pools exist; skipping")
        return 0
    v2 = categorical_to_str(pads.dataset(str(MASTER / "train"), format="parquet").to_table(
        columns=["id", "dataset", "language", "domain", "n_words"], filter=pc.field("fine_label") == "HUMAN").to_pandas())
    v2["len_bin"] = pd.cut(v2["n_words"], [0, 50, 150, 400, 10**9], labels=["<50", "50-150", "150-400", "400+"]).astype(str)
    g_sample = cap(v2[v2["language"] != "es"], 100000, ["dataset", "language", "domain", "len_bin"], 611)
    es_v2 = v2[v2["language"] == "es"]
    extra = pd.read_parquet(D / "datasets" / "f006_1_1_train_extra.parquet", columns=["id", "dataset", "language", "domain", "fine_label", "text_original"])
    ex_h = extra[extra["fine_label"] == "HUMAN"]
    ex_es = ex_h[ex_h["language"] == "es"]
    ex_es = cap(ex_es, 60000, ["dataset", "domain"], 611)
    ex_other = cap(ex_h[ex_h["language"] != "es"], 20000, ["dataset"], 611)
    ids_v2 = pd.concat([g_sample, es_v2])
    txt = pads.dataset(str(MASTER / "train"), format="parquet").to_table(columns=["id", "text_original"], filter=pc.field("id").isin(ids_v2["id"].tolist())).to_pandas()
    pool = pd.concat([ids_v2.merge(txt, on="id"), ex_es, ex_other], ignore_index=True).drop_duplicates("id").reset_index(drop=True)
    log(f"scoring {len(pool):,} TRAIN humans ({int((pool['language'] == 'es').sum()):,} Spanish) with {list(MODELS)}")
    for name, mdir in MODELS.items():
        pool[f"logit_{name}"] = score(mdir, pool["text_original"].tolist())
        pool[f"r_{name}"] = pool[f"logit_{name}"].rank(pct=True)
    pool["combined"] = pool[[f"r_{m}" for m in MODELS]].max(axis=1)
    g = select(pool, 0.15, ["dataset"], 0.12)
    es = select(pool[pool["language"] == "es"], 0.20, ["dataset", "domain"], 0.15)
    keep = ["id", "dataset", "language", "domain", "combined"] + [f"logit_{m}" for m in MODELS]
    g[keep].to_parquet(D / "datasets" / "hard_human_pool_v3.parquet", index=False)
    es[keep].to_parquet(D / "datasets" / "spanish_hard_pool_v3.parquet", index=False)
    rep = {"source": "TRAIN humans only (V2 TRAIN + F006_1_1 TRAIN_EXTRA)", "scored": int(len(pool)), "scored_spanish": int((pool["language"] == "es").sum()),
           "models": list(MODELS), "rule": __doc__.split("Each model")[1].strip(),
           "HARD_HUMAN_POOL_V3": {"size": int(len(g)), "by_dataset": g["dataset"].value_counts().head(30).to_dict(), "by_language": g["language"].value_counts().head(12).to_dict()},
           "SPANISH_HARD_POOL_V3": {"size": int(len(es)), "by_dataset": es["dataset"].value_counts().to_dict(), "by_domain": es["domain"].value_counts().head(20).to_dict()},
           "model_agreement_top15": {f"{a}_{b}": float(((pool[f"r_{a}"] >= 0.85) & (pool[f"r_{b}"] >= 0.85)).sum() / max((pool[f"r_{a}"] >= 0.85).sum(), 1))
                                     for a in MODELS for b in MODELS if a < b}}
    write_json(D / "reports" / "hard_human_pools.json", rep)
    write_json(REPO / "reports" / "f006_1_1" / "hard_human_pools.json", rep)
    log(json.dumps({k: rep[k]["size"] for k in ("HARD_HUMAN_POOL_V3", "SPANISH_HARD_POOL_V3")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
