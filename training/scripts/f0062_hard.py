"""F006.2: baseline (frozen EXPERIMENTAL_F006_1_1_MODEL) on the new splits + hard-example mining + final TRAIN_EXTRA.

    python scripts/f0062_hard.py

* Baseline: F006.1.1 with its own locked calibration / threshold (fitted on F006.1.1 validation; NOT re-tuned) scored on
  F006_2 VALIDATION, CALIBRATION and OOD. FINAL_EXTERNAL_HOLDOUT is not read.
* Mining (TRAIN candidates only): HARD_HUMAN = human rows flagged MACHINE by F006.1.1 or in the top decile of its human scores;
  HARD_MACHINE = machine rows flagged HUMAN or in the bottom decile of its machine scores. The threshold is not changed.
* Hard groups are split by group hash: 70 % stay in TRAIN (hard pools for the sampler), 30 % leave TRAIN entirely and form
  F006_2_HARD_INDEPENDENT (diagnostic evaluation only; never trained on, never used for selection).
* TRAIN_EXTRA = F006.1.1 TRAIN_EXTRA (historical replay) + TRAIN_NEW minus the independent hard groups.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f0062_common import D, D611, F611_MODEL, MANI, REPO, SPLITS, unit, write_json  # noqa: E402
from f006_1_final_eval import Model, report  # noqa: E402
from f006_lib import log, sha256_file  # noqa: E402

META_COLS = ["id", "dataset", "fine_label", "language", "domain", "is_adversarial", "is_mixed", "n_words", "group_id", "generator_family",
             "text_original", "text_normalized", "span_labels"]


def main() -> int:
    done = MANI / "f006_2_train_extra.json"
    if done.exists():
        log("hard mining already done")
        return 0
    cfg = json.loads((D611 / "reports" / "validation.json").read_text())["F006_1_1_MODEL"]["config"]
    m = Model(F611_MODEL, cfg)
    base = {"model": "EXPERIMENTAL_F006_1_1_MODEL", "path": str(F611_MODEL), "calibration_option": cfg["option"],
            "threshold_global": cfg["threshold_global"], "threshold_spanish": cfg["threshold_spanish"], "note": "frozen; thresholds NOT changed", "sets": {}}
    for k in ("validation", "calibration", "ood"):
        f = pd.read_parquet(SPLITS / f"f006_2_{k}.parquet")
        p, pred = m.run(f)
        base["sets"][k] = report(f, p, pred)
        base["sets"][k]["by_dataset"] = {ds: {"n": int(mk.sum()), "fpr": float(pred[mk & (f["label"].values == 0)].mean()) if (mk & (f["label"].values == 0)).any() else None,
                                               "recall": float(pred[mk & (f["label"].values == 1)].mean()) if (mk & (f["label"].values == 1)).any() else None}
                                          for ds in sorted(f["dataset"].astype(str).unique()) for mk in [(f["dataset"].astype(str) == ds).values]}
        pd.DataFrame({"id": f["id"], "p": p, "pred": pred}).to_parquet(D / "reports" / f"baseline_f006_1_1_{k}_scores.parquet", index=False)
        log(f"baseline {k}: FPR all {base['sets'][k].get('all', {}).get('fpr')} academic {base['sets'][k].get('academic', {}).get('fpr')}")
    write_json(D / "reports" / "baseline_f006_1_1.json", base)
    write_json(REPO / "reports" / "f006_2" / "baseline_f006_1_1.json", base)

    tn = pd.read_parquet(SPLITS / "f006_2_train_new_candidates.parquet")
    p, pred = m.run(tn.assign(language=tn["language"]))
    tn["p_f0611"], tn["pred_f0611"] = p, pred
    h, mm = tn["label"] == 0, tn["label"] == 1
    hq = np.quantile(p[h.values], 0.90) if h.any() else 1.0
    mq = np.quantile(p[mm.values], 0.10) if mm.any() else 0.0
    tn["hard_human"] = h & ((tn["pred_f0611"] == 1) | (tn["p_f0611"] >= hq))
    tn["hard_machine"] = mm & ((tn["pred_f0611"] == 0) | (tn["p_f0611"] <= mq))
    hard_groups = set(tn.loc[tn["hard_human"] | tn["hard_machine"], "group_id"])
    indep = {g for g in hard_groups if unit("hard:" + g) >= 0.70}
    ind = tn[tn["group_id"].isin(indep)].copy()
    train = tn[~tn["group_id"].isin(indep)].copy()
    ind["primary"] = np.where(ind["hard_human"] | ind["hard_machine"], "hard_independent", "hard_independent_context")
    ind["label"] = (ind["fine_label"] != "HUMAN").astype(int)
    ind.to_parquet(SPLITS / "f006_2_hard_independent.parquet", index=False)
    audit = {"rule": "HARD_HUMAN = human & (F006.1.1 flags MACHINE or top-decile human score); HARD_MACHINE = machine & (flags HUMAN or bottom-decile "
                     "machine score); threshold unchanged; 70/30 group split train / independent",
             "human_top_decile_score": float(hq), "machine_bottom_decile_score": float(mq),
             "candidates": {"rows": int(len(tn)), "humans": int(h.sum()), "machines": int(mm.sum())},
             "hard_human": {"total": int(tn["hard_human"].sum()), "flagged_machine": int((h & (tn["pred_f0611"] == 1)).sum()),
                            "train_part": int(train["hard_human"].sum()), "independent_part": int(ind["hard_human"].sum()),
                            "by_dataset": tn.loc[tn["hard_human"], "dataset"].value_counts().to_dict()},
             "hard_machine": {"total": int(tn["hard_machine"].sum()), "flagged_human": int((mm & (tn["pred_f0611"] == 0)).sum()),
                              "train_part": int(train["hard_machine"].sum()), "independent_part": int(ind["hard_machine"].sum()),
                              "by_dataset": tn.loc[tn["hard_machine"], "dataset"].value_counts().to_dict(),
                              "by_class": tn.loc[tn["hard_machine"], "transformation_type"].astype(str).value_counts().to_dict()},
             "independent_groups": len(indep), "independent_rows": int(len(ind)),
             "fpr_f0611_on_new_train_humans_by_dataset": tn[h].groupby("dataset")["pred_f0611"].mean().round(4).to_dict(),
             "recall_f0611_on_new_train_machines_by_dataset": tn[mm].groupby("dataset")["pred_f0611"].mean().round(4).to_dict()}
    write_json(D / "reports" / "F006_2_HARD_EXAMPLE_AUDIT.json", audit)
    write_json(REPO / "reports" / "F006_2_HARD_EXAMPLE_AUDIT.json", audit)

    # hard pools for the sampler = historical F006.1.1 pools (train-only) + new train-part hard rows
    hp_old = pd.read_parquet(D611 / "datasets" / "hard_human_pool_v3.parquet", columns=["id"])
    es_old = pd.read_parquet(D611 / "datasets" / "spanish_hard_pool_v3.parquet", columns=["id"])
    pd.concat([hp_old, train.loc[train["hard_human"], ["id"]]]).drop_duplicates().to_parquet(SPLITS / "f006_2_hard_human_pool.parquet", index=False)
    pd.concat([es_old, train.loc[train["hard_human"] & (train["language"] == "es"), ["id"]]]).drop_duplicates().to_parquet(
        SPLITS / "f006_2_spanish_hard_pool.parquet", index=False)
    train.loc[train["hard_machine"], ["id"]].to_parquet(SPLITS / "f006_2_hard_machine_pool.parquet", index=False)

    extra611 = pd.read_parquet(D611 / "datasets" / "f006_1_1_train_extra.parquet")
    train["generator_family"] = train["generator"].astype(str)
    for c in META_COLS:
        if c not in train:
            train[c] = None
    extra = pd.concat([extra611[[c for c in META_COLS if c in extra611.columns]], train[META_COLS]], ignore_index=True)
    assert not extra["id"].duplicated().any(), "duplicated ids in TRAIN_EXTRA"
    extra.to_parquet(SPLITS / "f006_2_train_extra.parquet", index=False)
    write_json(done, {"rows": int(len(extra)), "historical_f006_1_1_extra": int(len(extra611)), "new_rows": int(len(train)),
                      "new_by_dataset_label": (train["dataset"] + "|" + train["fine_label"]).value_counts().to_dict(),
                      "new_span_rows": int(train["span_labels"].notna().sum()), "file_sha256": sha256_file(SPLITS / "f006_2_train_extra.parquet")})
    log(f"TRAIN_EXTRA {len(extra):,} rows ({len(train):,} new); hard humans {audit['hard_human']['total']:,}, hard machines {audit['hard_machine']['total']:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
