"""F006.1: SPANISH_TRAIN_POOL, SPANISH_HARD_HUMAN_POOL (TRAIN only) and the V3-vs-F006 disagreement report.

    python scripts/f006_1_pools.py

* Spanish TRAIN pool = V2 TRAIN Spanish rows + F006_1 TRAIN_EXTRA Spanish rows (re-partitioned test-domain groups
  and new public human sources). Never validation / holdout.
* Hard Spanish humans: both CANDIDATE_MODEL_V3 and EXPERIMENTAL_F006_MODEL score every Spanish TRAIN human
  (calibrated, locked BALANCED thresholds). Candidates = humans flagged by either model OR in the top 20 % of the
  combined percentile rank; then stratified selection with a cap of 15 % of the pool per (dataset, domain) cell
  (only five Spanish human sources exist, so the cap is applied per source-domain cell, not per source).
* Disagreement (TRAIN and F006_1 VALIDATION Spanish humans): BOTH_CORRECT_HUMAN, V3_FALSE_POSITIVE_ONLY,
  F006_FALSE_POSITIVE_ONLY, BOTH_FALSE_POSITIVE, with their sources / domains / style medians.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_1_audit import model_probs, style  # noqa: E402
from f006_lib import categorical_to_str, log, write_json  # noqa: E402

D6 = Path("/content/drive/MyDrive/turniting/f006")
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
V3D = Path("/content/drive/MyDrive/turniting/v3")
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]
CELL_CAP = 0.15
POOL_FRAC = 0.20


def groups(f: pd.DataFrame, th: dict) -> pd.Series:
    a, b = f["p_V3"] >= th["V3"], f["p_F006"] >= th["F006"]
    return pd.Series(np.select([~a & ~b, a & ~b, ~a & b], ["BOTH_CORRECT_HUMAN", "V3_FALSE_POSITIVE_ONLY", "F006_FALSE_POSITIVE_ONLY"],
                               "BOTH_FALSE_POSITIVE"), index=f.index)


def disagreement(f: pd.DataFrame, th: dict, with_style: bool) -> dict:
    f = f.assign(g=groups(f, th))
    out = {"n": int(len(f)), "counts": f["g"].value_counts().to_dict()}
    for gname, g in f.groupby("g"):
        r = {"n": int(len(g)), "by_dataset": g["dataset"].value_counts().to_dict(), "by_domain": g["domain"].value_counts().head(12).to_dict(),
             "median_words": float(g["n_words"].median())}
        if with_style and "text_original" in g:
            r["style_medians"] = pd.DataFrame([style(t) for t in g["text_original"].head(1500)]).median().round(4).to_dict()
        out[gname] = r
    return out


def main() -> int:
    lock = json.loads((D6 / "manifests" / "F006_MODEL_LOCK.json").read_text())
    v4dir = Path(lock["modelPath"])
    v4cal = json.loads((v4dir / "calibration.json").read_text())["selected"]
    v3cal = lock["references"]["CANDIDATE_MODEL_V3"]["calibration"]
    th = {"V3": lock["references"]["CANDIDATE_MODEL_V3"]["thresholds"]["BALANCED"]["threshold"], "F006": lock["thresholds"]["BALANCED"]}
    idx = categorical_to_str(pd.read_parquet(V3D / "datasets" / "index_v2.parquet",
                                             columns=["id", "dataset", "fine_label", "domain", "language", "n_words", "group_id", "parent_id",
                                                      "generator_family", "split", "status", "is_adversarial"]))
    v2es = idx[(idx["status"] == "KEPT") & (idx["split"] == "train") & (idx["language"] == "es")].copy()
    v2es["source_part"], v2es["region"] = "V2_TRAIN", "UNKNOWN"
    extra = pd.read_parquet(D61 / "datasets" / "f006_1_train_extra.parquet")
    exs = extra[extra["language"] == "es"].copy()
    exs["source_part"] = "F006_1_TRAIN_EXTRA"
    pool = pd.concat([v2es.drop(columns=["status"]), exs.drop(columns=["text_original", "text_normalized", "span_labels"])], ignore_index=True)
    pool["region"] = pool["region"].fillna("UNKNOWN")
    pool["provenance_label"] = np.where(pool["fine_label"] == "HUMAN", "HUMAN_STRONG (dataset documentation)", "MACHINE (dataset label)")
    pool_man = {"name": "SPANISH_TRAIN_POOL_F006_1", "rows": int(len(pool)),
                "by_part_label": (pool["source_part"] + "|" + pool["fine_label"]).value_counts().to_dict(),
                "by_dataset_label": (pool["dataset"] + "|" + pool["fine_label"]).value_counts().to_dict(),
                "humans_by_domain": pool.loc[pool["fine_label"] == "HUMAN", "domain"].value_counts().to_dict(),
                "humans_by_region": pool.loc[pool["fine_label"] == "HUMAN", "region"].value_counts().to_dict(),
                "machine_by_generator": pool.loc[pool["fine_label"] != "HUMAN", "generator_family"].fillna("unknown").value_counts().head(25).to_dict(),
                "mixed_rows": int((pool["fine_label"] == "MIXED").sum()), "ai_edited_rows": int(pool["fine_label"].isin(["AI_EDITED", "HUMAN_EDITED_AI"]).sum()),
                "paraphrased_rows": int((pool["fine_label"] == "PARAPHRASED_AI").sum()), "adversarial_rows": int(pool["is_adversarial"].fillna(False).astype(bool).sum()),
                "note": "TURNITING_DATASET_V2 has no Spanish MIXED or AI_EDITED rows; Spanish machine = AI_GENERATED + PARAPHRASED_AI"}
    # ---------- score every Spanish TRAIN human with both models
    prev = pd.read_parquet(D61 / "datasets" / "train_spanish_human_scores.parquet")[["id", "p_V3", "p_F006"]]
    hum = pool[pool["fine_label"] == "HUMAN"].merge(prev, on="id", how="left")
    need = hum["p_V3"].isna()
    if need.any():
        ids = hum.loc[need, "id"]
        txt_v2 = pads.dataset(str(MASTER / "train"), format="parquet").to_table(columns=["id", "text_original"], filter=pc.field("id").isin(ids.tolist())).to_pandas()
        txt = pd.concat([txt_v2, extra.loc[extra["id"].isin(set(ids)), ["id", "text_original"]]]).drop_duplicates("id").set_index("id").loc[ids]
        for name, mdir, cal in (("F006", v4dir, v4cal), ("V3", V3D / "models" / "spanish_academic", v3cal)):
            hum.loc[need, f"p_{name}"] = model_probs(mdir, cal, txt["text_original"].tolist())
        log(f"scored {int(need.sum()):,} extra Spanish TRAIN humans")
    hum["r_V3"], hum["r_F006"] = hum["p_V3"].rank(pct=True), hum["p_F006"].rank(pct=True)
    hum["combined"] = hum[["r_V3", "r_F006"]].max(axis=1)
    flagged = (hum["p_V3"] >= th["V3"]) | (hum["p_F006"] >= th["F006"])
    cand = hum[flagged | (hum["combined"] >= 1 - POOL_FRAC)].sort_values("combined", ascending=False)
    target = int(POOL_FRAC * len(hum)) if len(cand) > POOL_FRAC * len(hum) else len(cand)
    limit = max(1, int(CELL_CAP * target))
    hard = cand.groupby(["dataset", "domain"], group_keys=False).head(limit).head(target)
    hard_rep = {"name": "SPANISH_HARD_HUMAN_POOL", "source": "Spanish TRAIN humans only (V2 TRAIN + F006_1 TRAIN_EXTRA)", "scored_humans": int(len(hum)),
                "thresholds_balanced_calibrated": th, "flagged_by_v3": int((hum["p_V3"] >= th["V3"]).sum()), "flagged_by_f006": int((hum["p_F006"] >= th["F006"]).sum()),
                "candidates": int(len(cand)), "pool_size": int(len(hard)), "cell_cap": f"<= {CELL_CAP:.0%} of the pool per (dataset, domain)",
                "pool_by_dataset": hard["dataset"].value_counts().to_dict(), "pool_by_domain": hard["domain"].value_counts().to_dict(),
                "pool_by_region": hard["region"].value_counts().to_dict(), "pool_by_part": hard["source_part"].value_counts().to_dict(),
                "pool_length_quantiles": {str(q): float(hard["n_words"].quantile(q)) for q in (0.1, 0.5, 0.9)},
                "train_fpr_by_dataset_domain": {f"{d}|{m}": {"n": int(len(g)), "V3": float((g["p_V3"] >= th["V3"]).mean()), "F006": float((g["p_F006"] >= th["F006"]).mean())}
                                                for (d, m), g in hum.groupby(["dataset", "domain"]) if len(g) >= 30}}
    hard[["id", "dataset", "domain", "region", "n_words", "source_part", "p_V3", "p_F006", "combined"]].to_parquet(D61 / "datasets" / "spanish_hard_human_pool.parquet", index=False)
    # ---------- disagreement (TRAIN + new VALIDATION Spanish humans)
    val = pd.read_parquet(D61 / "datasets" / "f006_1_validation.parquet")
    vh = val[(val["language"] == "es") & (val["label"] == 0)].reset_index(drop=True)
    for name, mdir, cal in (("F006", v4dir, v4cal), ("V3", V3D / "models" / "spanish_academic", v3cal)):
        vh[f"p_{name}"] = model_probs(mdir, cal, vh["text_original"].tolist())
    dis = {"thresholds": th, "train_spanish_humans": disagreement(hum, th, False), "validation_spanish_humans": disagreement(vh, th, True),
           "validation_fpr_by_dataset_domain": {f"{d}|{m}": {"n": int(len(g)), "V3": float((g["p_V3"] >= th["V3"]).mean()), "F006": float((g["p_F006"] >= th["F006"]).mean())}
                                                for (d, m), g in vh.groupby(["dataset", "domain"]) if len(g) >= 20}}
    for path, obj in (("spanish_train_pool.json", pool_man), ("spanish_hard_human_pool.json", hard_rep), ("v3_f006_disagreement.json", dis)):
        write_json(D61 / "reports" / path, obj)
        write_json(REPO / "reports" / "f006_1" / path, obj)
    log(f"Spanish train pool {len(pool):,} rows; hard pool {len(hard):,}; disagreement train {dis['train_spanish_humans']['counts']} "
        f"validation {dis['validation_spanish_humans']['counts']}")
    print(json.dumps(dis["validation_fpr_by_dataset_domain"], indent=0)[:3000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
