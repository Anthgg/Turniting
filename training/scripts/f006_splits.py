"""F006: build and LOCK the F006_FINAL_HOLDOUT and the new F006 VALIDATION (before any F006 training).

    python scripts/f006_splits.py --v3 <drive>/turniting/v3 --master /content/f006work/master_v2 \
        --out /content/drive/MyDrive/turniting/f006 --v3-model <drive>/turniting/v3/models/spanish_academic

Rules
* Whole groups only. A group is VALIDATION-side when it has a row in the V2 validation / adversarial_validation
  split, TEST-side when it has a row in the V2 test / adversarial_test split, otherwise (rows only in the
  unseen-generator / unseen-domain / OOD splits) by a seeded group hash (40 % validation).
* F006_FINAL_HOLDOUT: TEST-side groups only, and never a group holding any id that was ever evaluated
  (every id of eval_sets_v2: V3 test sets, V1 historical sets, dataset holdout) -> nothing in it was observed.
* F006 VALIDATION: VALIDATION-side groups (V3 validation ids allowed: validation is for selection anyway).
* Unseen generators: whole families. validation proxy = deepseek; holdout = mistral + cohere (none of the
  three ever appears in training).
* Unseen domains: validation proxy = reports; holdout = reviews + recipes.
* HARD_HUMAN flag: humans whose score under the FIXED reference model CANDIDATE_MODEL_V3 is in the top 15 %
  of that set's humans (computed once here, before training; it biases the subset against V3 by design).
* Everything is written once; when the holdout manifest exists with LOCKED=true the script only verifies it.
"""

from __future__ import annotations

import argparse
import json
import random
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
from turniting_train.canon import attack_homoglyph, attack_zero_width  # noqa: E402
from turniting_train.splits import unit_hash  # noqa: E402

SEED = 6006
VAL_UGEN, HOLD_UGEN = {"deepseek"}, {"mistral", "cohere"}
VAL_UDOM, HOLD_UDOM = {"reports"}, {"reviews", "recipes"}
EDITED = ["AI_EDITED", "HUMAN_EDITED_AI"]
COLS = ["id", "dataset", "fine_label", "generator_family", "domain", "language", "parent_id", "text_hash", "n_words",
        "origin", "attack", "span_labels_present", "group_id", "split", "is_adversarial", "status"]
SIZES = {
    "validation": {"general": (6000, 6000), "spanish": (1500, 1500), "academic": (1500, 1500), "mixed": (750, 1500),
                   "ai_edited": (750, 1500), "adversarial": (None, 1500), "unseen_generator": (1500, 1500),
                   "unseen_domain": (1000, 1000), "ood": (1000, 1000)},
    "holdout": {"general": (6000, 6000), "spanish": (1500, 1500), "academic": (1500, 1500), "mixed": (1000, 2000),
                "ai_edited": (1000, 2000), "adversarial": (None, 2000), "unseen_generator": (2500, 2500),
                "unseen_domain": (1500, 1500), "ood": (1500, 1500), "span": (0, 1200)},
}


def cap(frame: pd.DataFrame, n: int, by: list[str], seed: int) -> pd.DataFrame:
    if n <= 0 or len(frame) == 0:
        return frame.iloc[:0]
    if len(frame) <= n:
        return frame
    g = frame.groupby(by, observed=True)
    k = max(1, n // max(g.ngroups, 1))
    while g.size().clip(upper=k).sum() < n and k < len(frame):
        k = int(k * 1.3) + 1
    out = pd.concat([x.sample(min(len(x), k), random_state=seed) for _, x in g])
    return out.sample(n, random_state=seed) if len(out) > n else out


def group_sides(idx: pd.DataFrame) -> pd.Series:
    f = pd.DataFrame({"g": idx["group_id"].values,
                      "tr": idx["split"].isin(["train", "mixed", "dataset_holdout"]).values,
                      "va": idx["split"].isin(["validation", "adversarial_validation"]).values,
                      "te": idx["split"].isin(["test", "adversarial_test"]).values})
    agg = f.groupby("g").agg(tr=("tr", "any"), va=("va", "any"), te=("te", "any"))
    side = np.where(agg["tr"], "NONE", np.where(agg["va"], "VAL", np.where(agg["te"], "TEST", "HASH"))).astype(object)
    rest = side == "HASH"
    side[rest] = ["VAL" if unit_hash(str(g), SEED) < 0.4 else "TEST" for g in agg.index[rest]]
    return pd.Series(side, index=agg.index)


def pools(idx: pd.DataFrame, side: str) -> dict[str, pd.DataFrame]:
    d = idx[idx["side"] == side]
    ugen, udom = (VAL_UGEN, VAL_UDOM) if side == "VAL" else (HOLD_UGEN, HOLD_UDOM)
    core_split = "validation" if side == "VAL" else "test"
    adv_split = "adversarial_validation" if side == "VAL" else "adversarial_test"
    core = d[d["split"] == core_split]
    return {
        "core": core,
        "adv": d[d["split"] == adv_split],
        "ugen": d[(d["split"] == "unseen_generator_test") & d["generator_family"].isin(ugen)],
        "udom": d[(d["split"] == "unseen_domain_test") & d["domain"].isin(udom)],
        "ood": d[d["split"] == "ood_test"],
    }


def select(idx: pd.DataFrame, side: str, sizes: dict) -> pd.DataFrame:
    P = pools(idx, side)
    taken: set = set()
    parts = []
    strata_h = ["dataset", "is_es", "is_aca", "len_bin"]
    strata_m = ["dataset", "fine_label", "is_es", "is_aca", "len_bin", "is_adversarial"]

    def free(f):
        return f[~f["id"].isin(taken)]

    def add(name, frame):
        frame = frame.drop_duplicates("id")
        taken.update(frame["id"])
        parts.append(frame.assign(primary=name))
        log(f"  {side} {name}: {len(frame):,} docs ({int((frame['fine_label'] == 'HUMAN').sum()):,} human)")

    core = P["core"]
    H, M = core[core["fine_label"] == "HUMAN"], core[core["fine_label"] != "HUMAN"]
    nh, nm = sizes["general"]
    add("general", pd.concat([cap(free(H), nh, strata_h, SEED), cap(free(M), nm, strata_m, SEED)]))
    for name, mask_col in (("spanish", "is_es"), ("academic", "is_aca")):
        nh, nm = sizes[name]
        add(name, pd.concat([cap(free(H[H[mask_col]]), nh, ["dataset", "len_bin"], SEED),
                             cap(free(M[M[mask_col]]), nm, ["dataset", "fine_label"], SEED)]))
    for name, labels in (("mixed", ["MIXED"]), ("ai_edited", EDITED)):
        nh, nm = sizes[name]
        mm = cap(free(core[core["fine_label"].isin(labels)]), nm, ["dataset", "fine_label"], SEED)
        hh = cap(free(H[H["dataset"].isin(mm["dataset"].unique())]), nh, ["dataset"], SEED)
        add(name, pd.concat([mm, hh]))
    nh, nm = sizes["adversarial"]
    adv = free(P["adv"])
    add("adversarial", pd.concat([adv[adv["fine_label"] == "HUMAN"],
                                  cap(adv[adv["fine_label"] != "HUMAN"], nm, ["dataset", "attack", "generator_family"], SEED)]))
    nh, nm = sizes["unseen_generator"]
    ug = cap(free(P["ugen"]), nm, ["dataset", "generator_family", "fine_label"], SEED)
    ugh = cap(free(H[H["dataset"].isin(ug["dataset"].unique())]), nh, ["dataset"], SEED)
    add("unseen_generator", pd.concat([ug, ugh]))
    for name, key in (("unseen_domain", "udom"), ("ood", "ood")):
        nh, nm = sizes[name]
        f = free(P[key])
        add(name, pd.concat([cap(f[f["fine_label"] == "HUMAN"], nh, ["dataset", "domain"], SEED),
                             cap(f[f["fine_label"] != "HUMAN"], nm, ["dataset", "fine_label", "domain"], SEED)]))
    if "span" in sizes:
        f = free(core[(core["fine_label"] != "HUMAN") & core["span_labels_present"].fillna(False).astype(bool)])
        add("span", cap(f, sizes["span"][1], ["dataset", "fine_label"], SEED))
    return pd.concat(parts, ignore_index=True)


def read_texts(master: Path, sel: pd.DataFrame) -> pd.DataFrame:
    cols = ["id", "text_original", "text_normalized", "span_labels"]
    frames = []
    for split, g in sel.groupby("split"):
        ds = pads.dataset(str(master / split), format="parquet")
        frames.append(ds.to_table(columns=cols, filter=pc.field("id").isin(g["id"].tolist())).to_pandas())
    t = pd.concat(frames, ignore_index=True).drop_duplicates("id")
    out = sel.merge(t, on="id", how="left")
    missing = int(out["text_original"].isna().sum())
    if missing:
        raise SystemExit(f"ABORT: {missing} selected ids without text in master_v2")
    return out


def near_dup_cross(a: pd.DataFrame, b: pd.DataFrame) -> int:
    from turniting_train.dedup import MinHasher, band_hashes, candidate_pairs, estimated_jaccard

    mh = MinHasher(num_perm=64, seed=42, max_chars=3000)
    texts = a["text_original"].tolist() + b["text_original"].tolist()
    sig = np.stack([mh.signature(t) for t in texts])
    pairs = candidate_pairs(band_hashes(sig, 8), np.ones(len(texts), bool))
    if len(pairs) == 0:
        return 0
    j = estimated_jaccard(sig, pairs)
    p = pairs[j >= 0.8]
    na = len(a)
    return int((((p[:, 0] < na) & (p[:, 1] >= na)) | ((p[:, 0] >= na) & (p[:, 1] < na))).sum())


def hard_flags(frame: pd.DataFrame, model_dir: Path) -> np.ndarray:
    import torch
    from transformers import AutoTokenizer

    from turniting_train.canon import canonicalize
    from turniting_train.v3model import V3Detector, aggregate, score_texts

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = V3Detector.load(model_dir, dev)
    tok = AutoTokenizer.from_pretrained(model_dir / "backbone")
    icfg = json.loads((model_dir / "inference_config.json").read_text())
    h = frame[frame["label"] == 0]
    texts = [canonicalize(t) for t in h["text_original"]]
    sc = score_texts(model, tok, texts, 512, 128, icfg.get("max_windows_per_doc", 8), batch_size=256, device=dev)
    lg = np.array([aggregate(s["a"], icfg.get("aggregation", "mean")) for s in sc])
    cut = np.percentile(lg, 85)
    flag = pd.Series(False, index=frame.index)
    flag.loc[h.index] = lg >= cut
    frame.loc[h.index, "v3_reference_logit"] = lg
    del model
    torch.cuda.empty_cache()
    return flag.values


def attacks(frame: pd.DataFrame, n: int, seed: int) -> pd.DataFrame:
    base = frame[frame["primary"] == "general"].sample(min(n, int((frame["primary"] == "general").sum())), random_state=seed)
    rng = random.Random(seed)
    rows = []
    for name, fn in (("zero_width", attack_zero_width), ("homoglyph", attack_homoglyph)):
        for r in base.itertuples(index=False):
            rows.append({"id": f"{r.id}#{name}", "source_id": r.id, "attack_set": name, "text_original": fn(r.text_original, rng),
                         "label": int(r.label), "fine_label": r.fine_label, "language": r.language, "domain": r.domain,
                         "dataset": r.dataset})
    return pd.DataFrame(rows)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--v3", default="/content/drive/MyDrive/turniting/v3")
    ap.add_argument("--master", default="/content/f006work/master_v2")
    ap.add_argument("--out", default="/content/drive/MyDrive/turniting/f006")
    ap.add_argument("--v3-model", default="/content/drive/MyDrive/turniting/v3/models/spanish_academic")
    ap.add_argument("--repo-reports", default=str(Path(__file__).resolve().parents[1] / "reports" / "f006"))
    a = ap.parse_args()
    out = Path(a.out)
    man_path = out / "manifests" / "f006_final_holdout_manifest.json"
    if man_path.exists() and json.loads(man_path.read_text()).get("LOCKED"):
        man = json.loads(man_path.read_text())
        got = sha256_file(out / "datasets" / "f006_final_holdout.parquet")
        if got != man["holdout_file_sha256"]:
            raise SystemExit("ABORT: locked F006_FINAL_HOLDOUT file hash changed")
        log("F006_FINAL_HOLDOUT already LOCKED; hash verified, nothing rebuilt")
        return 0
    t0 = time.time()
    idx = categorical_to_str(pd.read_parquet(Path(a.v3) / "datasets" / "index_v2.parquet", columns=COLS))
    idx = idx[idx["status"] == "KEPT"].drop(columns=["status"])
    idx["is_es"] = idx["language"] == "es"
    idx["is_aca"] = idx["domain"] == "academic"
    idx["len_bin"] = pd.cut(idx["n_words"], [0, 50, 150, 400, 10**9], labels=["<50", "50-150", "150-400", "400+"]).astype(str)
    ev = pd.read_parquet(Path(a.v3) / "datasets" / "eval_sets_v2.parquet")
    observed = set(ev["id"])
    obs_groups = set(idx.loc[idx["id"].isin(observed), "group_id"])
    log(f"index {len(idx):,} kept rows; {len(observed):,} ids ever evaluated in {len(obs_groups):,} groups")
    sides = group_sides(idx)
    idx["side"] = idx["group_id"].map(sides).fillna("NONE")
    # holdout: never-observed TEST-side groups
    idx.loc[(idx["side"] == "TEST") & idx["group_id"].isin(obs_groups), "side"] = "TEST_OBSERVED"
    # V1 rows of historical V1 evaluation splits never enter VALIDATION
    idx.loc[(idx["side"] == "VAL") & (idx["origin"] == "v1") & ~idx["split"].isin(["validation", "ood_test"]), "side"] = "NONE"
    log("group sides: " + json.dumps(idx.drop_duplicates("group_id")["side"].value_counts().to_dict()))

    val = select(idx, "VAL", SIZES["validation"])
    hold = select(idx, "TEST", SIZES["holdout"])
    for f in (val, hold):
        f["label"] = (f["fine_label"] != "HUMAN").astype(int)

    # ---------------------------------------------------------------- leakage
    train_groups = set(idx.loc[idx["split"] == "train", "group_id"])
    train_hash = set(idx.loc[idx["split"] == "train", "text_hash"])
    train_parents = set(idx.loc[(idx["split"] == "train") & idx["parent_id"].notna(), "parent_id"]) | set(idx.loc[idx["split"] == "train", "id"])
    vg, hg = set(val["group_id"]), set(hold["group_id"])
    vh, hh = set(val["text_hash"]), set(hold["text_hash"])
    vp = set(val["parent_id"].dropna()) | set(val["id"])
    hp = set(hold["parent_id"].dropna()) | set(hold["id"])
    vtexts, htexts = read_texts(Path(a.master), val), read_texts(Path(a.master), hold)
    leak = {
        "group": {"validation_train": len(vg & train_groups), "holdout_train": len(hg & train_groups), "validation_holdout": len(vg & hg)},
        "exact": {"validation_train": len(vh & train_hash), "holdout_train": len(hh & train_hash), "validation_holdout": len(vh & hh)},
        "parent_child": {"validation_train": len((set(val["parent_id"].dropna()) & train_parents) | (set(val["id"]) & set(idx.loc[idx["split"] == "train", "parent_id"].dropna()))),
                         "holdout_train": len((set(hold["parent_id"].dropna()) & train_parents) | (set(hold["id"]) & set(idx.loc[idx["split"] == "train", "parent_id"].dropna()))),
                         "validation_holdout": len(vp & hp - (set(val["id"]) & set(hold["id"])))},
        "near_duplicate": {"validation_holdout": near_dup_cross(vtexts, htexts),
                           "train_eval": json.loads((Path(a.v3) / "datasets" / "stage2_summary.json").read_text())["leakage"]["near_duplicate_pairs_spanning_train_and_eval"],
                           "train_eval_source": "TURNITING_DATASET_V2 build (MinHash LSH over all kept rows)"},
        "observed_ids_in_holdout": len(set(hold["id"]) & observed),
    }
    flat = [v for k, d in leak.items() if isinstance(d, dict) for kk, v in d.items() if isinstance(v, int)] + [leak["observed_ids_in_holdout"]]
    leak["result"] = "PASS" if all(v == 0 for v in flat) else "FAIL"
    log(f"leakage: {json.dumps(leak)}")
    if leak["result"] != "PASS":
        write_json(out / "manifests" / "f006_split_leakage_FAIL.json", leak)
        raise SystemExit("ABORT: leakage check failed")

    # ---------------------------------------------------------------- hard-human flags (fixed reference V3)
    for f in (vtexts, htexts):
        f["v3_reference_logit"] = np.nan
        f["hard_human"] = hard_flags(f, Path(a.v3_model))
    keep = ["id", "primary", "label", "fine_label", "dataset", "generator_family", "domain", "language", "attack", "n_words",
            "split", "group_id", "parent_id", "text_hash", "hard_human", "v3_reference_logit", "text_original", "text_normalized", "span_labels"]
    ds_dir = out / "datasets"
    ds_dir.mkdir(parents=True, exist_ok=True)
    vtexts[keep].to_parquet(ds_dir / "f006_validation.parquet", index=False)
    htexts[keep].to_parquet(ds_dir / "f006_final_holdout.parquet", index=False)
    attacks(vtexts, 1000, SEED).to_parquet(ds_dir / "f006_validation_attacks.parquet", index=False)
    attacks(htexts, 1000, SEED + 1).to_parquet(ds_dir / "f006_final_holdout_attacks.parquet", index=False)

    def summary(f):
        return {"docs": int(len(f)), "humans": int((f["label"] == 0).sum()), "machine": int((f["label"] == 1).sum()),
                "groups": int(f["group_id"].nunique()),
                "by_primary": {k: {"docs": int(len(g)), "humans": int((g["label"] == 0).sum())} for k, g in f.groupby("primary")},
                "spanish_humans": int(((f["language"] == "es") & (f["label"] == 0)).sum()),
                "academic_humans": int(((f["domain"] == "academic") & (f["label"] == 0)).sum()),
                "hard_humans": int(f["hard_human"].sum()), "datasets": int(f["dataset"].nunique()),
                "fine_labels": f["fine_label"].value_counts().to_dict()}

    common = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "dataset_version": "TURNITING_DATASET_V2",
              "unseen_generator_families": {"validation_proxy": sorted(VAL_UGEN), "holdout": sorted(HOLD_UGEN)},
              "unseen_domains": {"validation_proxy": sorted(VAL_UDOM), "holdout": sorted(HOLD_UDOM)},
              "hard_human_rule": "top 15% of the set's humans by CANDIDATE_MODEL_V3 doc logit (fixed reference, computed before F006 training)",
              "leakage": leak}
    vman = {"name": "F006_VALIDATION", **common, **summary(vtexts), "ids_sha256": sha256_ids(vtexts["id"]),
            "file_sha256": sha256_file(ds_dir / "f006_validation.parquet")}
    hman = {"name": "F006_FINAL_HOLDOUT", **common, **summary(htexts), "ids_sha256": sha256_ids(htexts["id"]),
            "holdout_file_sha256": sha256_file(ds_dir / "f006_final_holdout.parquet"),
            "attacks_file_sha256": sha256_file(ds_dir / "f006_final_holdout_attacks.parquet"),
            "rule": "TEST-side groups never observed in any earlier evaluation; used ONCE after F006_MODEL_LOCK",
            "LOCKED": True}
    write_json(out / "manifests" / "f006_validation_manifest.json", vman)
    write_json(man_path, hman)
    rep = Path(a.repo_reports)
    write_json(rep / "f006_validation_manifest.json", vman)
    write_json(rep / "f006_final_holdout_manifest.json", hman)
    pd.DataFrame({"id": htexts["id"], "primary": htexts["primary"]}).to_csv(rep / "f006_final_holdout_ids.csv.gz", index=False, compression="gzip")
    log(f"LOCKED: holdout {len(htexts):,} docs ({hman['humans']:,} humans), validation {len(vtexts):,} docs "
        f"({vman['humans']:,} humans) in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
