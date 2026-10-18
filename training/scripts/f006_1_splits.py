"""F006.1: TRAIN_EXTRA, new validation (large Spanish part) and the LOCKED F006_1_FINAL_HOLDOUT.

    python scripts/f006_1_splits.py

Diagnosis that drives this (spanish_distribution_audit.json): every Spanish human of the F006 holdout came from
the official TEST splits of AuTexTification 2023 / IberAuTexTification (domains chat, how-to, news) or DetectRL;
the F006 validation only held their train-like VALIDATION splits (legal, tweets, wiki, literary). Those test
domains exist nowhere in TRAIN, so validation could not see the shift.

Rules (fixed before any F006.1 training)
* EXCLUDED everywhere except the historical benchmarks: every group holding an id that was ever evaluated
  (eval_sets_v2: V1 frozen sets, V3 test sets, dataset holdout) and every group of the F006 FINAL HOLDOUT.
* Spanish groups outside V2 TRAIN that are not excluded (any V2 split: validation / test / unseen-domain /
  unseen-generator / adversarial) are re-partitioned by a seeded group hash: 40 % TRAIN_EXTRA (usable for
  training and hard mining), 30 % VALIDATION, 30 % HOLDOUT. F006 VALIDATION groups can only go to VALIDATION.
  The new public Spanish human sources (f006_1_new_sources.py) are partitioned the same way, one group per article.
* Non-Spanish evaluation keeps the F006 construction (VALIDATION-side groups -> validation, never-observed
  TEST-side groups -> holdout; unseen generator: deepseek validation / mistral+cohere holdout; unseen domain:
  reports validation / reviews+recipes holdout).
* HUMAN provenance per dataset (documentation-based): new sources and the V2 Spanish human corpora are
  HUMAN_STRONG (published / collected before 2022-2023); nothing modern-web-unverified is used for evaluation.
* Leakage gates (exact, near-duplicate, group, parent/child, lineage) must all be 0 or nothing is written.
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

from f006_lib import categorical_to_str, log, sha256_file, sha256_ids, write_json  # noqa: E402
from f006_splits import COLS, attacks, cap, hard_flags, near_dup_cross, select  # noqa: E402
from turniting_train.splits import unit_hash  # noqa: E402

SEED = 6106
D6 = Path("/content/drive/MyDrive/turniting/f006")
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
V3D = Path("/content/drive/MyDrive/turniting/v3")
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]
PROVENANCE = {"autextification2023": ("HUMAN_STRONG", "AuTexTification 2023 human texts come from pre-2022 public corpora (task paper)"),
              "iberautextification": ("HUMAN_STRONG", "IberAuTexTification human texts collected from existing pre-LLM public corpora (task paper)"),
              "detectrl_x": ("HUMAN_STRONG", "DetectRL human side built from pre-2023 public datasets"),
              "xlsum_es_bbcmundo": ("HUMAN_STRONG", "BBC Mundo articles published before 2021"),
              "cc_news_es_2019": ("HUMAN_STRONG", "news crawled in 2019, before public LLM assistants")}
GLOBAL = {"validation": {"general": (2500, 2500), "spanish": (0, 0), "academic": (800, 800), "mixed": (400, 800),
                         "ai_edited": (400, 800), "adversarial": (None, 800), "unseen_generator": (800, 800),
                         "unseen_domain": (500, 500), "ood": (500, 500)},
          "holdout": {"general": (2500, 2500), "spanish": (0, 0), "academic": (800, 800), "mixed": (400, 800),
                      "ai_edited": (400, 800), "adversarial": (None, 800), "unseen_generator": (800, 800),
                      "unseen_domain": (500, 500), "ood": (500, 500), "span": (0, 600)}}
SPANISH = {"VAL": {"humans": 6000, "machine": 5000}, "HOLD": {"humans": 5500, "machine": 5000}}
NEW_SOURCE_HUMAN_CAP = 0.35


def three_way(key: str) -> str:
    u = unit_hash(key, SEED)
    return "TRAIN_EXTRA" if u < 0.4 else "VAL" if u < 0.7 else "HOLD"


def read_text(sel: pd.DataFrame, new: pd.DataFrame) -> pd.DataFrame:
    frames = []
    v2 = sel[~sel["id"].str.startswith("f0061:")]
    for split, g in v2.groupby("split"):
        ds = pads.dataset(str(MASTER / split), format="parquet")
        frames.append(ds.to_table(columns=["id", "text_original", "text_normalized", "span_labels"],
                                  filter=pc.field("id").isin(g["id"].tolist())).to_pandas())
    nn = sel[sel["id"].str.startswith("f0061:")]
    if len(nn):
        t = new.set_index("id").loc[nn["id"], ["text"]].reset_index().rename(columns={"text": "text_original"})
        t["text_normalized"], t["span_labels"] = None, None
        frames.append(t)
    t = pd.concat(frames, ignore_index=True).drop_duplicates("id")
    out = sel.merge(t, on="id", how="left")
    if out["text_original"].isna().any():
        raise SystemExit(f"ABORT: {int(out['text_original'].isna().sum())} ids without text")
    return out


def spanish_select(es: pd.DataFrame, side: str) -> pd.DataFrame:
    pool = es[es["side3"] == side]
    H, M = pool[pool["fine_label"] == "HUMAN"], pool[pool["fine_label"] != "HUMAN"]
    nh = SPANISH[side]["humans"]
    newh = H[H["dataset"].isin(["xlsum_es_bbcmundo", "cc_news_es_2019"])]
    oldh = H[~H.index.isin(newh.index)]
    n_new = min(int(nh * NEW_SOURCE_HUMAN_CAP), len(newh))
    hh = pd.concat([cap(oldh, nh - n_new, ["dataset", "domain", "len_bin"], SEED), cap(newh, n_new, ["dataset", "region", "len_bin"], SEED)])
    mm = cap(M, SPANISH[side]["machine"], ["dataset", "fine_label", "domain"], SEED)
    out = pd.concat([hh, mm]).assign(primary="spanish")
    log(f"  {side} spanish: {len(out):,} docs ({len(hh):,} human: {hh['dataset'].value_counts().to_dict()})")
    return out


def main() -> int:
    man_path = D61 / "manifests" / "f006_1_final_holdout.json"
    if man_path.exists() and json.loads(man_path.read_text()).get("LOCKED"):
        man = json.loads(man_path.read_text())
        if sha256_file(D61 / "datasets" / "f006_1_final_holdout.parquet") != man["holdout_file_sha256"]:
            raise SystemExit("ABORT: locked F006_1_FINAL_HOLDOUT changed")
        log("F006_1_FINAL_HOLDOUT already LOCKED; verified")
        return 0
    t0 = time.time()
    idx = categorical_to_str(pd.read_parquet(V3D / "datasets" / "index_v2.parquet", columns=COLS + ["v1_split"]))
    idx = idx[idx["status"] == "KEPT"].drop(columns=["status"])
    ev = pd.read_parquet(V3D / "datasets" / "eval_sets_v2.parquet")
    f6h = pd.read_parquet(D6 / "datasets" / "f006_final_holdout.parquet", columns=["id", "group_id"])
    f6v = pd.read_parquet(D6 / "datasets" / "f006_validation.parquet", columns=["id", "group_id"])
    excl = set(idx.loc[idx["id"].isin(set(ev["id"])), "group_id"]) | set(f6h["group_id"])
    f6v_groups = set(f6v["group_id"])
    new = pd.read_parquet(D61 / "datasets" / "new_spanish_humans.parquet")
    log(f"index {len(idx):,}; excluded groups {len(excl):,}; F006 validation groups {len(f6v_groups):,}; new Spanish humans {len(new):,}")

    # ---------------- sides
    from f006_splits import group_sides
    gs = group_sides(idx)
    idx["side"] = idx["group_id"].map(gs).fillna("NONE")
    idx.loc[(idx["side"] == "TEST") & idx["group_id"].isin(excl), "side"] = "EXCLUDED"
    idx.loc[(idx["side"] == "VAL") & idx["group_id"].isin(excl), "side"] = "EXCLUDED"
    idx.loc[(idx["side"] == "VAL") & (idx["origin"] == "v1") & ~idx["split"].isin(["validation", "ood_test"]), "side"] = "NONE"
    es_groups = set(idx.loc[idx["language"] == "es", "group_id"])
    is_es_group = idx["group_id"].isin(es_groups)
    elig = is_es_group & ~idx["group_id"].isin(excl) & (idx["split"] != "train") & ~idx["split"].isin(["mixed", "dataset_holdout"])
    g3 = pd.Series({g: ("VAL" if g in f6v_groups else three_way(str(g))) for g in idx.loc[elig, "group_id"].unique()})
    idx["side3"] = None
    idx.loc[elig, "side3"] = idx.loc[elig, "group_id"].map(g3)
    idx.loc[is_es_group, "side"] = "EXCLUDED"  # Spanish groups leave the global pools entirely
    idx.loc[is_es_group & (idx["split"] == "train"), "side"] = "NONE"
    idx.loc[elig, "side"] = "SPANISH_REPARTITIONED"
    idx["is_es"] = idx["language"] == "es"
    idx["is_aca"] = idx["domain"] == "academic"
    idx["len_bin"] = pd.cut(idx["n_words"], [0, 50, 150, 400, 10**9], labels=["<50", "50-150", "150-400", "400+"]).astype(str)
    new["side3"] = new["group_id"].map(lambda g: three_way(str(g)))
    new["len_bin"] = pd.cut(new["n_words"], [0, 50, 150, 400, 10**9], labels=["<50", "50-150", "150-400", "400+"]).astype(str)
    new["split"], new["origin"], new["generator_family"], new["parent_id"], new["attack"] = "f0061_new", "f0061", "human", None, "none"
    new["span_labels_present"], new["is_adversarial"], new["is_es"], new["is_aca"], new["v1_split"] = False, False, True, False, None
    new["text_hash"] = new["text_hash"].astype(str)
    log("sides: " + json.dumps(idx.drop_duplicates("group_id")["side"].value_counts().to_dict()) + " spanish3: "
        + json.dumps(idx.loc[elig].drop_duplicates("group_id")["side3"].value_counts().to_dict()))

    # ---------------- selection
    val_g = select(idx, "VAL", GLOBAL["validation"])
    hold_g = select(idx, "TEST", GLOBAL["holdout"])
    newm = new.drop(columns=["text", "title", "url", "src_id", "original_split", "year", "license", "provenance", "label"], errors="ignore")
    es_all = pd.concat([idx[elig & (idx["language"] == "es")], newm], ignore_index=True)
    es_all["region"] = es_all["region"].fillna("UNKNOWN") if "region" in es_all else "UNKNOWN"
    val_es, hold_es = spanish_select(es_all, "VAL"), spanish_select(es_all, "HOLD")
    val = pd.concat([val_g, val_es], ignore_index=True)
    hold = pd.concat([hold_g, hold_es], ignore_index=True)
    for f in (val, hold):
        f["label"] = (f["fine_label"] != "HUMAN").astype(int)
        f["provenance"] = np.where(f["label"] == 0, f["dataset"].map(lambda d: PROVENANCE.get(d, ("HUMAN_STRONG_V2", ""))[0]), None)
    extra = es_all[es_all["side3"] == "TRAIN_EXTRA"].copy()

    # ---------------- leakage gates
    train_rows = idx[idx["split"] == "train"]
    tr_groups = set(train_rows["group_id"]) | set(extra["group_id"])
    tr_hash = set(train_rows["text_hash"]) | set(extra["text_hash"])
    tr_parent = set(train_rows["parent_id"].dropna()) | set(train_rows["id"]) | set(extra["id"])
    vtexts, htexts = read_text(val, new), read_text(hold, new)
    etexts = read_text(extra, new)
    vg, hg = set(val["group_id"]), set(hold["group_id"])

    def pc_(a, b_ids, b_par):
        return len((set(a["parent_id"].dropna()) & b_par) | (set(a["id"]) & b_par))

    es_v, es_h = vtexts[vtexts["primary"] == "spanish"], htexts[htexts["primary"] == "spanish"]
    leak = {
        "group": {"validation_train": len(vg & tr_groups), "holdout_train": len(hg & tr_groups), "validation_holdout": len(vg & hg),
                  "holdout_f006_holdout": len(hg & set(f6h["group_id"])), "holdout_ever_evaluated": len(hg & excl)},
        "exact": {"validation_train": len(set(val["text_hash"]) & tr_hash), "holdout_train": len(set(hold["text_hash"]) & tr_hash),
                  "validation_holdout": len(set(val["text_hash"]) & set(hold["text_hash"]))},
        "parent_child": {"validation_train": pc_(val, None, tr_parent), "holdout_train": pc_(hold, None, tr_parent),
                         "validation_holdout": len((set(val["parent_id"].dropna()) | set(val["id"])) & (set(hold["parent_id"].dropna()) | set(hold["id"])))},
        "near_duplicate": {"validation_holdout": near_dup_cross(vtexts, htexts),
                           "spanish_validation_train_extra": near_dup_cross(es_v, etexts),
                           "spanish_holdout_train_extra": near_dup_cross(es_h, etexts),
                           "v2_train_eval": json.loads((V3D / "datasets" / "stage2_summary.json").read_text())["leakage"]["near_duplicate_pairs_spanning_train_and_eval"]},
        "lineage": {"note": "V2 group_id already joins prompt/source/parent lineage; new sources: one group per article URL/id",
                    "validation_holdout_same_source_url": len(set(new.loc[new["id"].isin(val["id"]), "url"].dropna()) & set(new.loc[new["id"].isin(hold["id"]), "url"].dropna())),
                    "eval_train_extra_same_source_url": len(set(new.loc[new["id"].isin(set(val["id"]) | set(hold["id"])), "url"].dropna()) & set(new.loc[new["id"].isin(extra["id"]), "url"].dropna()))},
    }
    flat = [v for d in leak.values() for k, v in d.items() if isinstance(v, int)]
    leak["result"] = "PASS" if all(v == 0 for v in flat) else "FAIL"
    log("leakage: " + json.dumps(leak))
    if leak["result"] != "PASS":
        write_json(D61 / "manifests" / "f006_1_leakage_FAIL.json", leak)
        raise SystemExit("ABORT: leakage")

    for f in (vtexts, htexts):
        f["v3_reference_logit"] = np.nan
        f["hard_human"] = hard_flags(f, V3D / "models" / "spanish_academic")
    keep = ["id", "primary", "label", "fine_label", "dataset", "generator_family", "domain", "language", "attack", "n_words", "split",
            "group_id", "parent_id", "text_hash", "hard_human", "v3_reference_logit", "provenance", "region", "v1_split",
            "text_original", "text_normalized", "span_labels"]
    for f in (vtexts, htexts):
        for c in ("region", "provenance", "v1_split"):
            if c not in f:
                f[c] = None
    dsd = D61 / "datasets"
    vtexts[keep].to_parquet(dsd / "f006_1_validation.parquet", index=False)
    htexts[keep].to_parquet(dsd / "f006_1_final_holdout.parquet", index=False)
    attacks(vtexts, 1000, SEED).to_parquet(dsd / "f006_1_validation_attacks.parquet", index=False)
    attacks(htexts, 1000, SEED + 1).to_parquet(dsd / "f006_1_final_holdout_attacks.parquet", index=False)
    ecols = ["id", "dataset", "fine_label", "language", "domain", "is_adversarial", "n_words", "group_id", "region", "split", "v1_split",
             "text_original", "text_normalized", "span_labels"]
    for c in ecols:
        if c not in etexts:
            etexts[c] = None
    etexts["is_mixed"] = etexts["fine_label"] == "MIXED"
    etexts[ecols + ["is_mixed"]].to_parquet(dsd / "f006_1_train_extra.parquet", index=False)

    def summary(f):
        es = f[f["language"] == "es"]
        return {"docs": int(len(f)), "humans": int((f["label"] == 0).sum()), "machine": int((f["label"] == 1).sum()), "groups": int(f["group_id"].nunique()),
                "by_primary": {k: {"docs": int(len(g)), "humans": int((g["label"] == 0).sum())} for k, g in f.groupby("primary")},
                "spanish_docs": int(len(es)), "spanish_humans": int((es["label"] == 0).sum()),
                "spanish_by_dataset_label": (es["dataset"] + "|" + es["fine_label"]).value_counts().to_dict(),
                "spanish_by_domain": es["domain"].value_counts().to_dict(),
                "spanish_by_region": es["region"].fillna("UNKNOWN").value_counts().to_dict(),
                "spanish_by_v1_split": es["v1_split"].fillna("none").value_counts().to_dict(),
                "spanish_human_provenance": es.loc[es["label"] == 0, "provenance"].value_counts().to_dict(),
                "languages": f["language"].value_counts().head(20).to_dict(), "domains": f["domain"].value_counts().head(25).to_dict(),
                "datasets": f["dataset"].value_counts().to_dict(), "mixed": int((f["fine_label"] == "MIXED").sum()),
                "ai_edited": int(f["fine_label"].isin(["AI_EDITED", "HUMAN_EDITED_AI"]).sum()), "hard_humans": int(f["hard_human"].sum())}

    common = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "provenance_rules": PROVENANCE,
              "spanish_repartition": "groups outside V2 TRAIN, never evaluated, not in the F006 holdout: 40% TRAIN_EXTRA / 30% VALIDATION / 30% HOLDOUT",
              "leakage": leak}
    vman = {"name": "F006_1_VALIDATION", **common, **summary(vtexts), "ids_sha256": sha256_ids(vtexts["id"]), "file_sha256": sha256_file(dsd / "f006_1_validation.parquet")}
    hman = {"name": "F006_1_FINAL_HOLDOUT", **common, **summary(htexts), "ids_sha256": sha256_ids(htexts["id"]),
            "holdout_file_sha256": sha256_file(dsd / "f006_1_final_holdout.parquet"),
            "attacks_file_sha256": sha256_file(dsd / "f006_1_final_holdout_attacks.parquet"), "LOCKED": True,
            "rule": "never used for training / mining / selection / calibration / thresholds; evaluated ONCE after F006_1_MODEL_LOCK"}
    eman = {"name": "F006_1_TRAIN_EXTRA", "rows": int(len(etexts)), "humans": int((etexts["fine_label"] == "HUMAN").sum()),
            "by_dataset_label": (etexts["dataset"] + "|" + etexts["fine_label"]).value_counts().to_dict(),
            "by_domain": etexts["domain"].value_counts().to_dict(), "ids_sha256": sha256_ids(etexts["id"])}
    write_json(D61 / "manifests" / "f006_1_validation.json", vman)
    write_json(man_path, hman)
    write_json(D61 / "manifests" / "f006_1_train_extra.json", eman)
    hman["manifest_sha256_note"] = "sha256 of the Drive manifest file is recorded in split_distribution.json"
    write_json(REPO / "datasets" / "manifests" / "f006_1_final_holdout.json", hman)
    write_json(REPO / "datasets" / "manifests" / "f006_1_validation.json", vman)
    write_json(REPO / "datasets" / "manifests" / "f006_1_train_extra.json", eman)
    split_rep = {"manifest_sha256": {"holdout": sha256_file(man_path), "validation": sha256_file(D61 / "manifests" / "f006_1_validation.json")},
                 "validation": summary(vtexts), "holdout_metadata_only": summary(htexts), "train_extra": eman, "leakage": leak}
    write_json(D61 / "reports" / "split_distribution.json", split_rep)
    write_json(REPO / "reports" / "f006_1" / "split_distribution.json", split_rep)
    log(f"LOCKED F006_1 holdout {len(htexts):,} docs ({hman['spanish_docs']:,} Spanish, {hman['spanish_humans']:,} Spanish humans); "
        f"validation {len(vtexts):,} ({vman['spanish_docs']:,} Spanish, {vman['spanish_humans']:,} humans); train extra {len(etexts):,} in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
