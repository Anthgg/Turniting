"""F006.2: dedup, group-safe splits, leakage audit and the LOCKED F006_2_FINAL_EXTERNAL_HOLDOUT (frozen BEFORE any training).

    python scripts/f0062_splits.py

Split units (never random rows):
  tdx_thesis_es        whole thesis (tdx_side, shared with f0062_claude.py): TRAIN 60 / VAL 12 / CAL 8 / FINAL 20
  claude_es_academic   side fixed at generation (topic or parent thesis); never FINAL
  txd22                not used: already part of TURNITING_DATASET_V2 (historical replay through master_v2)
  spanish_synthetic    headline group: OOD 50 / FINAL 50; never TRAIN (unseen domain + unseen generators)
Historical: REGRESSION_HOLDOUT = F006.1.1 final holdout (observed; continuity only, never for decisions). VALIDATION / CALIBRATION
also carry disjoint group samples of the F006.1.1 VALIDATION (historical regression on the old distribution).
Gates (STOP_BEFORE_TRAINING if any is non-zero): exact / near / group / parent / source / lineage overlap between TRAIN and every
evaluation split, and between FINAL and every other split.
"""

from __future__ import annotations

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

from f0062_claude import tdx_side  # noqa: E402
from f0062_common import D611, MANI, MASTER, NORM, REPO, SEED, SPLITS, V3D, unit, write_json  # noqa: E402
from f0611_splits import near_dup_members  # noqa: E402
from f006_lib import log, sha256_file, sha256_ids  # noqa: E402
from f006_splits import attacks, cap  # noqa: E402
from turniting_train.textnorm import normalized_text_hash  # noqa: E402

HIST_VAL_DOCS, HIST_CAL_DOCS = 8000, 4000
TDX_HUMAN_CAP = {"TRAIN": 999999, "VAL": 3500, "CAL": 2500, "FINAL": 5000}
A3_CAP = {"OOD": 3000, "FINAL": 3000}
KEEP = ["id", "primary", "label", "fine_label", "dataset", "generator", "domain", "language", "n_words", "group_id", "parent_id",
        "source_id", "text_hash", "hard_human", "span_labels", "text_original", "text_normalized", "ai_fraction", "transformation_type", "origin"]


def a3_side(g: str) -> str:
    return "OOD" if unit("a3:" + g) < 0.5 else "FINAL"


def load_new() -> pd.DataFrame:
    tdx = pd.read_parquet(NORM / "tdx_thesis_es.parquet")
    tdx["side"] = tdx["group_id"].map(tdx_side)
    a3 = pd.read_parquet(NORM / "spanish_synthetic_2026.parquet")
    a3["side"] = a3["group_id"].map(a3_side)
    parts = [tdx, a3]
    cp = NORM / "claude_es_academic.parquet"
    if cp.exists():
        cl = pd.read_parquet(cp)
        cl = cl.assign(source_id=cl["custom_id"])
        assert not (cl["side"] == "FINAL").any(), "Claude rows can never be FINAL"
        parts.append(cl)
    else:
        log("WARNING: no Claude data yet (claude_es_academic.parquet missing); splitting without it")
    new = pd.concat(parts, ignore_index=True)
    for c in ("span_labels", "ai_fraction", "transformation_type", "source_id", "parent_id"):
        if c not in new:
            new[c] = None
    new["text_original"], new["text_normalized"], new["origin"] = new["text"], None, "f006_2_new"
    new["text_hash"] = new["text_original"].map(normalized_text_hash)
    return new


def primary_of(r) -> str:
    if r.dataset == "spanish_synthetic_2026":
        return "ood" if r.side == "OOD" else "unseen_generator"
    if r.fine_label == "MIXED":
        return "span" if r.span_labels is not None and unit("span:" + r.id) < 0.5 else "mixed"
    if r.fine_label == "AI_EDITED":
        return "ai_edited"
    return "academic"


def main() -> int:
    man_path = MANI / "f006_2_final_external_holdout.json"
    if man_path.exists() and json.loads(man_path.read_text()).get("LOCKED"):
        man = json.loads(man_path.read_text())
        assert sha256_file(SPLITS / "f006_2_final_external_holdout.parquet") == man["holdout_file_sha256"], "locked holdout changed"
        log("F006_2_FINAL_EXTERNAL_HOLDOUT already LOCKED; verified")
        return 0
    SPLITS.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    new = load_new()
    n0 = len(new)
    # ------------------------------------------------ dedup: within new, then against everything historical
    new = new.drop_duplicates("text_hash")
    exact_within = n0 - len(new)
    idx = pd.read_parquet(V3D / "datasets" / "index_v2.parquet", columns=["id", "text_hash", "language", "domain", "split", "group_id"])
    extra611 = pd.read_parquet(D611 / "datasets" / "f006_1_1_train_extra.parquet", columns=["id", "text_original", "group_id", "dataset", "language", "domain"])
    extra611["text_hash"] = extra611["text_original"].map(normalized_text_hash)
    val611 = pd.read_parquet(D611 / "datasets" / "f006_1_1_validation.parquet")
    hold611 = pd.read_parquet(D611 / "datasets" / "f006_1_1_final_holdout.parquet", columns=["id", "text_hash", "group_id", "text_original"])
    hist_hash = set(idx["text_hash"].dropna()) | set(extra611["text_hash"]) | set(val611["text_hash"].dropna()) | set(hold611["text_hash"].dropna())
    ex_hist = new["text_hash"].isin(hist_hash)
    new = new[~ex_hist].reset_index(drop=True)
    ref = []
    for split in sorted(p.name for p in MASTER.iterdir() if p.is_dir()):
        ds_ = pads.dataset(str(MASTER / split), format="parquet")
        ref.append(ds_.to_table(columns=["text_original"], filter=(pc.field("language") == "es") | (pc.field("domain") == "academic")).to_pandas())
    ref.append(extra611.loc[(extra611["language"] == "es") | (extra611["domain"] == "academic"), ["text_original"]])
    ref = pd.concat(ref, ignore_index=True)
    es_new = new[(new["language"] == "es")].copy()
    near = near_dup_members(ref, es_new)
    near_ids = set(es_new.iloc[sorted(near)]["id"]) if near else set()
    new = new[~new["id"].isin(near_ids)].reset_index(drop=True)
    # near duplicates inside the new pool across splits are removed below (TRAIN vs every evaluation split, FINAL vs the rest)
    dedup = {"rows_before": int(n0), "exact_within_new_removed": int(exact_within), "exact_vs_historical_removed": int(ex_hist.sum()),
             "near_vs_historical_spanish_academic_removed": len(near_ids), "rows_after": int(len(new))}
    log("dedup: " + json.dumps(dedup))
    del ref

    new["primary"] = [primary_of(r) for r in new.itertuples(index=False)]
    new["hard_human"] = False
    sides = {}
    for s in ("TRAIN", "VAL", "CAL", "FINAL", "OOD"):
        sides[s] = new[new["side"] == s].copy()
    # caps on evaluation sides (whole groups kept together by sampling groups, not rows)
    def cap_groups(f: pd.DataFrame, n: int, seed: int) -> pd.DataFrame:
        if len(f) <= n:
            return f
        g = f["group_id"].drop_duplicates().sample(frac=1.0, random_state=seed)
        sizes = f.groupby("group_id").size()
        keep, tot = [], 0
        for x in g:
            if tot >= n:
                break
            keep.append(x)
            tot += int(sizes[x])
        return f[f["group_id"].isin(set(keep))]

    for s, capd in (("VAL", TDX_HUMAN_CAP), ("CAL", TDX_HUMAN_CAP), ("FINAL", TDX_HUMAN_CAP)):
        f = sides[s]
        t = cap_groups(f[f["dataset"] == "tdx_thesis_es"], capd[s], SEED)
        a = cap_groups(f[f["dataset"] == "spanish_synthetic_2026"], A3_CAP.get(s, 0), SEED + 2) if s == "FINAL" else f.iloc[:0]
        c = f[f["dataset"] == "claude_es_academic"]
        sides[s] = pd.concat([t, a, c], ignore_index=True)
    sides["OOD"] = cap_groups(sides["OOD"], A3_CAP["OOD"], SEED + 3)
    # held-out TDX theses whose derived Claude rows exist would be a lineage leak: Claude only used non-FINAL theses (asserted)
    assert not set(sides["FINAL"]["group_id"]) & set(new.loc[new["dataset"] == "claude_es_academic", "group_id"]), "Claude lineage in FINAL"

    # ------------------------------------------------ historical regression samples (F006.1.1 VALIDATION, disjoint groups)
    hg = val611["group_id"].drop_duplicates().sample(frac=1.0, random_state=SEED)
    half = set(hg.iloc[: len(hg) // 2])
    hv = cap(val611[val611["group_id"].isin(half)], HIST_VAL_DOCS, ["primary"], SEED).copy()
    hc = cap(val611[~val611["group_id"].isin(half)], HIST_CAL_DOCS, ["primary"], SEED).copy()
    for h_ in (hv, hc):
        h_["origin"], h_["generator"] = "f006_1_1_validation", h_.get("generator_family")
        for c in KEEP:
            if c not in h_:
                h_[c] = None

    frames = {"validation": pd.concat([sides["VAL"], hv], ignore_index=True), "calibration": pd.concat([sides["CAL"], hc], ignore_index=True),
              "ood": sides["OOD"], "final": sides["FINAL"]}
    train_new = sides["TRAIN"]

    # ------------------------------------------------ leakage: drop TRAIN rows near-dup to any evaluation row; eval vs FINAL
    ev_all = pd.concat([frames[k] for k in ("validation", "calibration", "ood", "final")], ignore_index=True)
    for _ in range(10):
        drop = near_dup_members(ev_all, train_new)
        if not drop:
            break
        log(f"dropping {len(drop)} TRAIN rows near-duplicate to evaluation rows")
        train_new = train_new.reset_index(drop=True).drop(index=sorted(drop)).reset_index(drop=True)
    for k in ("validation", "calibration", "ood"):
        for _ in range(4):
            d_ = near_dup_members(frames["final"], frames[k].reset_index(drop=True))
            if not d_:
                break
            log(f"dropping {len(d_)} {k} rows near-duplicate to FINAL")
            frames[k] = frames[k].reset_index(drop=True).drop(index=sorted(d_)).reset_index(drop=True)

    hist_train_groups = set(idx.loc[idx["split"] == "train", "group_id"]) | set(extra611["group_id"])
    tr_g = set(train_new["group_id"]) | hist_train_groups
    tr_h = set(train_new["text_hash"]) | set(idx.loc[idx["split"] == "train", "text_hash"].dropna()) | set(extra611["text_hash"])
    tr_p = set(train_new["parent_id"].dropna()) | set(train_new["id"])
    tr_s = set(train_new["source_id"].dropna())
    tr_lineage = set(train_new["topic_id"].dropna()) if "topic_id" in train_new else set()

    def L(f: pd.DataFrame, other_g, other_h, other_p, other_s) -> dict:
        return {"group": len(set(f["group_id"]) & other_g), "exact": len(set(f["text_hash"].dropna()) & other_h),
                "parent": len((set(f["parent_id"].dropna()) | set(f["id"])) & other_p), "source": len(set(f["source_id"].dropna()) & other_s)}

    leak = {}
    for k, f in frames.items():
        leak[f"TRAIN_vs_{k}"] = {**L(f, tr_g, tr_h, tr_p, tr_s), "near": len(near_dup_members(f.reset_index(drop=True), train_new)),
                                 "lineage": len(set(f.get("topic_id", pd.Series(dtype=str)).dropna()) & tr_lineage)}
    fin = frames["final"]
    fg, fh, fp, fs = set(fin["group_id"]), set(fin["text_hash"].dropna()), set(fin["parent_id"].dropna()) | set(fin["id"]), set(fin["source_id"].dropna())
    for k in ("validation", "calibration", "ood"):
        leak[f"FINAL_vs_{k}"] = {**L(frames[k], fg, fh, fp, fs), "near": len(near_dup_members(fin, frames[k].reset_index(drop=True)))}
    leak["FINAL_vs_historical_holdout_exact"] = len(fh & set(hold611["text_hash"].dropna()))
    leak["FINAL_claude_rows"] = int((fin["dataset"] == "claude_es_academic").sum())
    flat = [v for d_ in leak.values() for v in (d_.values() if isinstance(d_, dict) else [d_])]
    leak["result"] = "PASS" if all(v == 0 for v in flat) else "FAIL"
    gates = {"TRAIN_INTERSECT_VALIDATION": sum(leak["TRAIN_vs_validation"].values()), "TRAIN_INTERSECT_CALIBRATION": sum(leak["TRAIN_vs_calibration"].values()),
             "TRAIN_INTERSECT_FINAL_HOLDOUT": sum(leak["TRAIN_vs_final"].values()),
             "PARENT_OVERLAP": sum(leak[k]["parent"] for k in leak if isinstance(leak[k], dict)),
             "SOURCE_LEAKAGE": sum(leak[k]["source"] for k in leak if isinstance(leak[k], dict)),
             "LINEAGE_LEAKAGE": sum(leak[k].get("lineage", 0) for k in leak if isinstance(leak[k], dict))}
    log("leakage: " + json.dumps(leak))
    log("gates: " + json.dumps(gates))
    if leak["result"] != "PASS":
        write_json(MANI / "f006_2_leakage_FAIL.json", {"leak": leak, "gates": gates})
        write_json(REPO / "reports" / "f006_2" / "f006_2_leakage_FAIL.json", {"leak": leak, "gates": gates})
        raise SystemExit("STOP_BEFORE_TRAINING: leakage")

    # ------------------------------------------------ write frames (FINAL is locked and never read again until MODEL_LOCK)
    out = {}
    for k, f in frames.items():
        f = f.copy()
        f["label"] = (f["fine_label"] != "HUMAN").astype(int)
        for c in KEEP:
            if c not in f:
                f[c] = None
        f = f[KEEP].drop_duplicates("id").reset_index(drop=True)
        p = SPLITS / f"f006_2_{'final_external_holdout' if k == 'final' else k}.parquet"
        f.to_parquet(p, index=False)
        out[k] = f
    attacks(out["validation"], 800, SEED).to_parquet(SPLITS / "f006_2_validation_attacks.parquet", index=False)
    tn = train_new.copy()
    tn["text_original"] = tn["text"]
    tn["is_adversarial"], tn["is_mixed"] = False, tn["fine_label"] == "MIXED"
    tn["dataset"] = "f0062_" + tn["dataset"]  # new-source marker read by the f006_2 sampler mixture
    tn.to_parquet(SPLITS / "f006_2_train_new_candidates.parquet", index=False)

    def summary(f):
        es = f[f["language"] == "es"]
        return {"docs": int(len(f)), "humans": int((f["label"] == 0).sum()), "groups": int(f["group_id"].nunique()),
                "by_primary": {k: {"docs": int(len(g)), "humans": int((g["label"] == 0).sum())} for k, g in f.groupby("primary")},
                "datasets": f["dataset"].value_counts().to_dict(), "fine_labels": f["fine_label"].value_counts().to_dict(),
                "generators": f["generator"].astype(str).value_counts().head(30).to_dict(), "spanish_docs": int(len(es)),
                "spanish_humans": int((es["label"] == 0).sum()), "span_docs": int(f["span_labels"].notna().sum())}

    common = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "dedup": dedup, "leakage": leak, "gates": gates}
    hman = {"name": "F006_2_FINAL_EXTERNAL_HOLDOUT", **common, **summary(out["final"]), "ids_sha256": sha256_ids(out["final"]["id"]),
            "holdout_file_sha256": sha256_file(SPLITS / "f006_2_final_external_holdout.parquet"), "LOCKED": True,
            "contains": {"new_human_academic": "TDX theses never seen by any model or by Claude", "unseen_generators": ["ministral-3b", "qwen-2.5-0.5b", "llama-3.2-1b"], "unseen_domain": "news_description (spanish_synthetic_2026)"},
            "rule": "never used for training / mining / selection / calibration / thresholds; evaluated ONCE after F006_2_MODEL_LOCK"}
    write_json(man_path, hman)
    for k in ("validation", "calibration", "ood"):
        write_json(MANI / f"f006_2_{k}.json", {"name": f"F006_2_{k.upper()}", **common, **summary(out[k]), "ids_sha256": sha256_ids(out[k]["id"]),
                                              "file_sha256": sha256_file(SPLITS / f"f006_2_{k}.parquet")})
    write_json(MANI / "f006_2_train_new_candidates.json", {"rows": int(len(tn)), "by_dataset_label": (tn["dataset"] + "|" + tn["fine_label"]).value_counts().to_dict(),
                                                            "groups": int(tn["group_id"].nunique()), "span_rows": int(tn["span_labels"].notna().sum())})
    rep = {"manifest_sha256": {"final": sha256_file(man_path)}, "validation": summary(out["validation"]), "calibration": summary(out["calibration"]),
           "ood": summary(out["ood"]), "final_metadata_only": summary(out["final"]), "train_new_candidates": int(len(tn)), "dedup": dedup, "leakage": leak, "gates": gates}
    write_json(REPO / "reports" / "f006_2" / "split_report.json", rep)
    log(f"LOCKED F006_2_FINAL_EXTERNAL_HOLDOUT {len(out['final']):,} docs; validation {len(out['validation']):,}; calibration {len(out['calibration']):,}; "
        f"ood {len(out['ood']):,}; train new {len(tn):,} in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
