"""F006.1.1: dedup of the new sources, TRAIN_NEW, new validation and the LOCKED F006_1_1_FINAL_HOLDOUT.

    python scripts/f0611_splits.py

* EXCLUDED everywhere (historical only): ids ever evaluated (eval_sets_v2), F006 FINAL HOLDOUT groups,
  F006.1 FINAL HOLDOUT groups. F006 / F006.1 validation groups may only re-enter VALIDATION.
* TRAIN = V2 TRAIN + F006.1 TRAIN_EXTRA + F006.1.1 TRAIN_NEW (new-source groups assigned to train).
* New sources: exact dedup (normalised SHA-256) against all V2 rows, F006.1 additions and each other; MinHash LSH
  near-dup (J>=0.8) against the V2 rows of the same families (Heterogeneous AI Spans, GRADTEX, Beemo), all V2 Spanish
  rows and the F006.1 Spanish sources. Group assignment: official split when the source has one (HAS, GRADTEX,
  academic abstracts; a group goes to the most held-out split it touches), else a seeded group hash
  (COWSL2H / Beemo 40/30/30, SBW / SciELO 60/20/20). COWSL2H groups = student (participant); Beemo = prompt_id;
  GRADTEX = MAGE original; HAS = source/group id.
* Unseen generators: whole families mistral + cohere never train (holdout), deepseek is the validation proxy.
  GRADTEX groups holding any mistral generation are holdout-only.
* Mixed / span holdouts are representative: HAS exact-span mixed docs, GRADTEX completions (MIXED), Beemo human
  edits, V2 mixed rows from never-observed groups.
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

from f006_1_splits import near_dup_members, three_way  # noqa: E402
from f006_lib import categorical_to_str, log, sha256_file, sha256_ids, write_json  # noqa: E402
from f006_splits import COLS, attacks, cap, group_sides, hard_flags, near_dup_cross, select  # noqa: E402
from turniting_train.splits import unit_hash  # noqa: E402
from turniting_train.textnorm import normalized_text_hash  # noqa: E402

SEED = 61106
D6 = Path("/content/drive/MyDrive/turniting/f006")
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
D = Path("/content/drive/MyDrive/turniting/f006_1_1")
V3D = Path("/content/drive/MyDrive/turniting/v3")
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]
CAP_NEW = {"scielo_es": 60000, "spanish_billion_words": 60000}
SPLIT_RATIO = {"spanish_billion_words": (0.6, 0.8), "scielo_es": (0.6, 0.8)}
NEW_ES_HUMAN_SHARE = 0.15  # per new Spanish source inside the Spanish human evaluation subset
GLOBAL = {"validation": {"general": (3500, 3500), "spanish": (0, 0), "academic": (900, 900), "mixed": (300, 600), "ai_edited": (400, 800),
                         "adversarial": (None, 900), "unseen_generator": (1200, 1200), "unseen_domain": (500, 500), "ood": (500, 500)},
          "holdout": {"general": (4000, 4000), "spanish": (0, 0), "academic": (1000, 1000), "mixed": (300, 600), "ai_edited": (400, 800),
                      "adversarial": (None, 1000), "unseen_generator": (1500, 1500), "unseen_domain": (600, 600), "ood": (600, 600)}}


def side_of(key: str, ds: str) -> str:
    a, b = SPLIT_RATIO.get(ds, (0.4, 0.7))
    u = unit_hash(key, SEED)
    return "TRAIN" if u < a else "VAL" if u < b else "HOLD"


def main() -> int:
    man_path = D / "manifests" / "f006_1_1_final_holdout.json"
    if man_path.exists() and json.loads(man_path.read_text()).get("LOCKED"):
        man = json.loads(man_path.read_text())
        assert sha256_file(D / "datasets" / "f006_1_1_final_holdout.parquet") == man["holdout_file_sha256"], "locked holdout changed"
        log("F006_1_1_FINAL_HOLDOUT already LOCKED; verified")
        return 0
    t0 = time.time()
    # ------------------------------------------------ V2 side
    idx = categorical_to_str(pd.read_parquet(V3D / "datasets" / "index_v2.parquet", columns=COLS + ["v1_split"]))
    idx = idx[idx["status"] == "KEPT"].drop(columns=["status"])
    ev = pd.read_parquet(V3D / "datasets" / "eval_sets_v2.parquet")
    f6h = pd.read_parquet(D6 / "datasets" / "f006_final_holdout.parquet", columns=["id", "group_id"])
    f61h = pd.read_parquet(D61 / "datasets" / "f006_1_final_holdout.parquet", columns=["id", "group_id"])
    f6v = pd.read_parquet(D6 / "datasets" / "f006_validation.parquet", columns=["id", "group_id"])
    f61v = pd.read_parquet(D61 / "datasets" / "f006_1_validation.parquet", columns=["id", "group_id"])
    excl = set(idx.loc[idx["id"].isin(set(ev["id"])), "group_id"]) | set(f6h["group_id"]) | set(f61h["group_id"])
    val_only = set(f6v["group_id"]) | set(f61v["group_id"])
    gs = group_sides(idx)
    idx["side"] = idx["group_id"].map(gs).fillna("NONE")
    idx.loc[idx["group_id"].isin(excl) & idx["side"].isin(["VAL", "TEST"]), "side"] = "EXCLUDED"
    idx.loc[(idx["side"] == "VAL") & (idx["origin"] == "v1") & ~idx["split"].isin(["validation", "ood_test"]), "side"] = "NONE"
    idx.loc[(idx["side"] == "TEST") & idx["group_id"].isin(val_only), "side"] = "EXCLUDED"
    # Spanish groups: reproduce the F006.1 re-partition (TRAIN_EXTRA rows are training; VAL / HOLD sides re-usable)
    es_groups = set(idx.loc[idx["language"] == "es", "group_id"])
    is_es = idx["group_id"].isin(es_groups)
    extra61 = pd.read_parquet(D61 / "datasets" / "f006_1_train_extra.parquet")
    elig = is_es & (idx["split"] != "train") & ~idx["split"].isin(["mixed", "dataset_holdout"]) & ~idx["group_id"].isin(excl) & ~idx["id"].isin(set(extra61["id"]))
    g3 = pd.Series({g: ("VAL" if g in val_only else three_way(str(g))) for g in idx.loc[elig, "group_id"].unique()})
    idx["side3"] = None
    idx.loc[elig, "side3"] = idx.loc[elig, "group_id"].map(g3)
    idx.loc[elig & (idx["side3"] == "TRAIN_EXTRA"), "side3"] = None  # those are in extra61 already (or were dropped as near-dups)
    idx.loc[is_es, "side"] = np.where(idx.loc[is_es, "split"] == "train", "NONE", "EXCLUDED")
    for c, v in (("is_es", idx["language"] == "es"), ("is_aca", idx["domain"] == "academic")):
        idx[c] = v
    idx["len_bin"] = pd.cut(idx["n_words"], [0, 50, 150, 400, 10**9], labels=["<50", "50-150", "150-400", "400+"]).astype(str)
    log(f"V2 kept {len(idx):,}; excluded groups {len(excl):,}; sides " + json.dumps(idx.drop_duplicates("group_id")["side"].value_counts().to_dict()))

    # ------------------------------------------------ new sources: dedup
    new = pd.read_parquet(D / "datasets" / "new_sources_raw.parquet")
    for ds, n in CAP_NEW.items():
        part = new[new["dataset"] == ds]
        if len(part) > n:
            keepg = part.drop_duplicates("group_id").sample(frac=1.0, random_state=SEED)["group_id"]
            chosen, total = set(), 0
            sizes = part.groupby("group_id").size()
            for g in keepg:
                if total >= n:
                    break
                chosen.add(g)
                total += int(sizes[g])
            new = new[(new["dataset"] != ds) | new["group_id"].isin(chosen)]
    new["text_hash"] = new["text"].map(normalized_text_hash)
    n0 = len(new)
    new = new.drop_duplicates("text_hash")
    f61new = pd.read_parquet(D61 / "datasets" / "new_spanish_humans.parquet", columns=["id", "text", "text_hash", "group_id"])
    f61new["n_words"] = f61new["text"].str.split().str.len()
    ex_v2 = new["text_hash"].isin(set(idx["text_hash"]))
    ex_61 = new["text_hash"].isin(set(f61new["text_hash"]))
    new = new[~ex_v2 & ~ex_61].reset_index(drop=True)
    ref = []
    for split in sorted(p.name for p in MASTER.iterdir() if p.is_dir()):
        ds_ = pads.dataset(str(MASTER / split), format="parquet")
        flt = (pc.field("language") == "es") | pc.field("dataset").isin(["het_ai_spans", "gradtex", "beemo"])
        ref.append(ds_.to_table(columns=["text_original"], filter=flt).to_pandas())
    ref = pd.concat(ref + [f61new[["text"]].rename(columns={"text": "text_original"})], ignore_index=True)
    near = near_dup_members(ref.rename(columns={"text_original": "text_original"}), new.rename(columns={"text": "text_original"}))
    new = new.drop(index=sorted(near)).reset_index(drop=True)
    dedup = {"rows_before": int(n0), "exact_within_new_removed": int(n0 - len(new) - len(near) - int(ex_v2.sum()) - int(ex_61.sum())),
             "exact_vs_v2_removed": int(ex_v2.sum()), "exact_vs_f006_1_removed": int(ex_61.sum()), "near_vs_reference_removed": len(near),
             "rows_after": int(len(new))}
    log("dedup: " + json.dumps(dedup))

    # ------------------------------------------------ new sources: sides by group
    def gside(g: pd.DataFrame) -> str:
        ds = g["dataset"].iloc[0]
        if (g["generator_family"].isin(["mistral", "cohere"])).any():
            return "HOLD"
        hints = set(g["split_hint"].dropna())
        if hints:
            return "HOLD" if "test" in hints else "VAL" if "validation" in hints else "TRAIN"
        return side_of(str(g.name), ds)

    gmap = new.groupby("group_id").apply(gside)
    new["side_new"] = new["group_id"].map(gmap)
    new["split"], new["origin"], new["v1_split"], new["is_adversarial"], new["attack"] = "f0611_new", "f0611", None, False, "none"
    new["span_labels_present"] = new["span_labels"].notna()
    new["is_es"], new["is_aca"] = new["language"] == "es", new["domain"] == "academic"
    new["n_words"] = new["text"].str.split().str.len()
    new["len_bin"] = pd.cut(new["n_words"], [0, 50, 150, 400, 10**9], labels=["<50", "50-150", "150-400", "400+"]).astype(str)
    log("new sides: " + json.dumps((new["dataset"] + "|" + new["side_new"]).value_counts().to_dict()))

    # ------------------------------------------------ selection
    val_g = select(idx, "VAL", GLOBAL["validation"])
    hold_g = select(idx, "TEST", GLOBAL["holdout"])
    newm = new.drop(columns=["text"])

    def es_select(side: str, nh: int, nm: int) -> pd.DataFrame:
        es_v2 = idx[(idx["side3"] == side) & (idx["language"] == "es")]
        f61_new_side = f61new.assign(side3=f61new["group_id"].map(lambda g: three_way(str(g))))
        f61_pool = f61_new_side[f61_new_side["side3"] == side].drop(columns=["text"])
        f61_pool = f61_pool[~f61_pool["id"].isin(set(f61h["id"]) | set(f61v["id"]) if side == "HOLD" else set(f61h["id"]))]
        f61_pool = f61_pool.assign(dataset="f006_1_new_spanish", fine_label="HUMAN", language="es", domain="news", split="f0061_new", len_bin="150-400",
                                   generator_family="human", attack="none", parent_id=None, v1_split=None, is_adversarial=False)
        nw = newm[(newm["side_new"] == side) & (newm["language"] == "es")]
        H = []
        quota = int(nh * NEW_ES_HUMAN_SHARE)
        for ds in sorted(nw.loc[nw["fine_label"] == "HUMAN", "dataset"].unique()):
            H.append(cap(nw[(nw["dataset"] == ds) & (nw["fine_label"] == "HUMAN")], quota, ["len_bin"], SEED))
        H.append(cap(f61_pool, quota, ["group_id"], SEED).iloc[:quota])
        rest = nh - sum(len(x) for x in H)
        H.append(cap(es_v2[es_v2["fine_label"] == "HUMAN"], rest, ["dataset", "domain", "len_bin"], SEED))
        M = cap(es_v2[es_v2["fine_label"] != "HUMAN"], nm, ["dataset", "fine_label", "domain"], SEED)
        out = pd.concat(H + [M], ignore_index=True).assign(primary="spanish")
        log(f"  {side} spanish: {len(out):,} ({int((out['fine_label'] == 'HUMAN').sum()):,} human) " + json.dumps(out.loc[out["fine_label"] == "HUMAN", "dataset"].value_counts().to_dict()))
        return out

    def mixed_span(side: str, n_mixed: int, n_span: int, n_ctrl: int) -> pd.DataFrame:
        nw = newm[newm["side_new"] == side]
        v2side = "VAL" if side == "VAL" else "TEST"
        v2 = idx[(idx["side"] == v2side) & ~idx["id"].isin(set(val_g["id"]) | set(hold_g["id"]))]
        span_pool = pd.concat([nw[nw["span_labels_present"]], v2[(v2["fine_label"] != "HUMAN") & v2["span_labels_present"].fillna(False).astype(bool)]])
        span = cap(span_pool, n_span, ["dataset", "fine_label", "len_bin"], SEED).assign(primary="span")
        mixed_pool = pd.concat([nw[nw["fine_label"].isin(["MIXED", "HUMAN_EDITED_AI"])], v2[v2["fine_label"] == "MIXED"]])
        mixed_pool = mixed_pool[~mixed_pool["id"].isin(set(span["id"]))]
        mixed = cap(mixed_pool, n_mixed, ["dataset", "fine_label", "generator_family", "len_bin"], SEED).assign(primary="mixed")
        ctrl_pool = nw[(nw["fine_label"] == "HUMAN") & nw["dataset"].isin(["has_f0611", "beemo_f0611", "gradtex_f0611"])]
        ctrl = cap(ctrl_pool, n_ctrl, ["dataset"], SEED).assign(primary="mixed")
        edited = cap(nw[nw["fine_label"].isin(["AI_EDITED", "PARAPHRASED_AI"])], n_mixed // 2, ["dataset", "fine_label", "generator_family"], SEED).assign(primary="ai_edited")
        ug = cap(nw[nw["generator_family"].isin(["mistral", "cohere"]) & (nw["fine_label"] != "HUMAN")], 600 if side == "HOLD" else 0,
                 ["dataset", "fine_label"], SEED).assign(primary="unseen_generator")
        out = pd.concat([span, mixed, ctrl, edited, ug], ignore_index=True)
        log(f"  {side} mixed/span/edited: " + json.dumps(out.groupby("primary").size().to_dict()))
        return out

    val = pd.concat([val_g, es_select("VAL", 6000, 4500), mixed_span("VAL", 2000, 1000, 600)], ignore_index=True).drop_duplicates("id")
    hold = pd.concat([hold_g, es_select("HOLD", 6000, 4500), mixed_span("HOLD", 2500, 1500, 800)], ignore_index=True).drop_duplicates("id")
    for f in (val, hold):
        f["label"] = (f["fine_label"] != "HUMAN").astype(int)
    train_new = new[new["side_new"] == "TRAIN"].copy()

    # ------------------------------------------------ texts
    def texts(sel: pd.DataFrame) -> pd.DataFrame:
        parts = []
        v2 = sel[sel["split"].isin(set(idx["split"]))]
        for split, g in v2.groupby("split"):
            parts.append(pads.dataset(str(MASTER / split), format="parquet").to_table(columns=["id", "text_original", "text_normalized", "span_labels"],
                                                                                      filter=pc.field("id").isin(g["id"].tolist())).to_pandas())
        nn = sel[sel["split"] == "f0611_new"]
        if len(nn):
            t = new.set_index("id").loc[nn["id"], ["text", "span_labels"]].reset_index().rename(columns={"text": "text_original"})
            t["text_normalized"] = None
            parts.append(t)
        ff = sel[sel["split"] == "f0061_new"]
        if len(ff):
            t = f61new.set_index("id").loc[ff["id"], ["text"]].reset_index().rename(columns={"text": "text_original"})
            t["text_normalized"], t["span_labels"] = None, None
            parts.append(t)
        tt = pd.concat(parts, ignore_index=True).drop_duplicates("id")
        out = sel.drop(columns=[c for c in ("span_labels",) if c in sel.columns]).merge(tt, on="id", how="left")
        if out["text_original"].isna().any():
            raise SystemExit(f"ABORT: {int(out['text_original'].isna().sum())} ids without text")
        return out

    vtexts, htexts = texts(val), texts(hold)
    # ------------------------------------------------ leakage gates
    drop = near_dup_members(pd.concat([vtexts, htexts]), train_new.rename(columns={"text": "text_original"}))
    if drop:
        log(f"dropping {len(drop)} TRAIN_NEW rows near-duplicate to evaluation rows")
        train_new = train_new.reset_index(drop=True).drop(index=sorted(drop))
    train_rows = idx[idx["split"] == "train"]
    tr_g = set(train_rows["group_id"]) | set(extra61["group_id"]) | set(train_new["group_id"])
    tr_h = set(train_rows["text_hash"]) | set(train_new["text_hash"])
    tr_p = set(train_rows["parent_id"].dropna()) | set(train_rows["id"]) | set(extra61["id"]) | set(train_new["parent_id"].dropna()) | set(train_new["id"])
    vg, hg = set(val["group_id"]), set(hold["group_id"])

    def pcn(a):
        return len((set(a["parent_id"].dropna()) & tr_p) | (set(a["id"]) & tr_p))

    es_v, es_h = vtexts[vtexts["language"] == "es"], htexts[htexts["language"] == "es"]
    extra_txt = extra61[["id", "text_original"]]
    leak = {
        "group": {"validation_train": len(vg & tr_g), "holdout_train": len(hg & tr_g), "validation_holdout": len(vg & hg),
                  "holdout_prior_holdouts": len(hg & (set(f6h["group_id"]) | set(f61h["group_id"]))), "holdout_ever_evaluated": len(hg & excl)},
        "exact": {"validation_train": len(set(val["text_hash"].dropna()) & tr_h), "holdout_train": len(set(hold["text_hash"].dropna()) & tr_h),
                  "validation_holdout": len(set(val["text_hash"].dropna()) & set(hold["text_hash"].dropna()))},
        "parent_child": {"validation_train": pcn(val), "holdout_train": pcn(hold),
                         "validation_holdout": len((set(val["parent_id"].dropna()) | set(val["id"])) & (set(hold["parent_id"].dropna()) | set(hold["id"])))},
        "participant": {"cowsl2h_students_validation_train": len({g for g in vg if str(g).startswith("cowsl2h:")} & set(train_new["group_id"])),
                        "cowsl2h_students_holdout_train": len({g for g in hg if str(g).startswith("cowsl2h:")} & set(train_new["group_id"])),
                        "cowsl2h_students_validation_holdout": len({g for g in vg if str(g).startswith("cowsl2h:")} & hg)},
        "near_duplicate": {"validation_holdout": near_dup_cross(vtexts, htexts), "spanish_eval_f006_1_train_extra": near_dup_cross(pd.concat([es_v, es_h]), extra_txt),
                           "eval_train_new": len(near_dup_members(pd.concat([vtexts, htexts]), train_new.rename(columns={"text": "text_original"})))},
    }
    flat = [v for d_ in leak.values() for v in d_.values() if isinstance(v, int)]
    leak["result"] = "PASS" if all(v == 0 for v in flat) else "FAIL"
    log("leakage: " + json.dumps(leak))
    if leak["result"] != "PASS":
        write_json(D / "manifests" / "f006_1_1_leakage_FAIL.json", leak)
        raise SystemExit("ABORT: leakage")

    for f in (vtexts, htexts):
        f["v3_reference_logit"] = np.nan
        f["hard_human"] = hard_flags(f, V3D / "models" / "spanish_academic")
        for c in ("region", "provenance", "meta"):
            if c not in f:
                f[c] = None
    keep = ["id", "primary", "label", "fine_label", "dataset", "generator_family", "domain", "language", "attack", "n_words", "split", "group_id",
            "parent_id", "text_hash", "hard_human", "v3_reference_logit", "provenance", "meta", "text_original", "text_normalized", "span_labels"]
    dsd = D / "datasets"
    vtexts[keep].to_parquet(dsd / "f006_1_1_validation.parquet", index=False)
    htexts[keep].to_parquet(dsd / "f006_1_1_final_holdout.parquet", index=False)
    attacks(vtexts, 1000, SEED).to_parquet(dsd / "f006_1_1_validation_attacks.parquet", index=False)
    attacks(htexts, 1000, SEED + 1).to_parquet(dsd / "f006_1_1_final_holdout_attacks.parquet", index=False)
    tn = train_new.rename(columns={"text": "text_original"})
    tn["text_normalized"], tn["is_mixed"] = None, tn["fine_label"] == "MIXED"
    cols = ["id", "dataset", "fine_label", "language", "domain", "is_adversarial", "is_mixed", "n_words", "group_id", "generator_family",
            "text_original", "text_normalized", "span_labels"]
    extra_all = pd.concat([extra61.assign(generator_family=None)[[c for c in cols if c in extra61.columns or c == "generator_family"]], tn[cols]], ignore_index=True)
    extra_all.to_parquet(dsd / "f006_1_1_train_extra.parquet", index=False)

    def summary(f):
        es = f[f["language"] == "es"]
        return {"docs": int(len(f)), "humans": int((f["label"] == 0).sum()), "groups": int(f["group_id"].nunique()),
                "by_primary": {k: {"docs": int(len(g)), "humans": int((g["label"] == 0).sum())} for k, g in f.groupby("primary")},
                "spanish_docs": int(len(es)), "spanish_humans": int((es["label"] == 0).sum()),
                "spanish_humans_by_dataset": es.loc[es["label"] == 0, "dataset"].value_counts().to_dict(),
                "datasets": f["dataset"].value_counts().to_dict(), "fine_labels": f["fine_label"].value_counts().to_dict(),
                "span_docs": int(f["span_labels"].notna().sum()), "mixed_docs": int((f["fine_label"] == "MIXED").sum()),
                "unseen_generator_families": f.loc[f["primary"] == "unseen_generator", "generator_family"].value_counts().to_dict(),
                "hard_humans": int(f["hard_human"].sum())}

    common = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "dedup": dedup, "leakage": leak,
              "unseen_generator_families": {"validation_proxy": ["deepseek"], "holdout": ["mistral", "cohere"]}}
    vman = {"name": "F006_1_1_VALIDATION", **common, **summary(vtexts), "ids_sha256": sha256_ids(vtexts["id"]), "file_sha256": sha256_file(dsd / "f006_1_1_validation.parquet")}
    hman = {"name": "F006_1_1_FINAL_HOLDOUT", **common, **summary(htexts), "ids_sha256": sha256_ids(htexts["id"]),
            "holdout_file_sha256": sha256_file(dsd / "f006_1_1_final_holdout.parquet"), "attacks_file_sha256": sha256_file(dsd / "f006_1_1_final_holdout_attacks.parquet"),
            "LOCKED": True, "rule": "never used for training / mining / selection / calibration / thresholds; evaluated ONCE after F006_1_1_MODEL_LOCK"}
    eman = {"name": "F006_1_1_TRAIN_EXTRA", "rows": int(len(extra_all)), "f006_1_extra": int(len(extra61)), "f006_1_1_new": int(len(tn)),
            "new_by_dataset_label": (tn["dataset"] + "|" + tn["fine_label"]).value_counts().to_dict(), "span_rows": int(tn["span_labels"].notna().sum())}
    dl = json.loads((D / "manifests" / "new_sources_download.json").read_text())
    dsman = {"name": "F006_1_1_DATASET_MANIFEST", "created_at": common["created_at"], "datasets": {}}
    for name, info in dl["datasets"].items():
        nd = {"cowsl2h": "cowsl2h", "academic_abstracts_es": "academic_abstracts_es", "scielo_es": "scielo_es", "spanish_billion_words": "spanish_billion_words",
              "beemo": "beemo_f0611", "gradtex": "gradtex_f0611", "heterogeneous_ai_spans": "has_f0611"}.get(name)
        rows = new[new["dataset"] == nd] if nd else new.iloc[:0]
        dsman["datasets"][name] = {**info, "rows_after_dedup": int(len(rows)), "groups_after_dedup": int(rows["group_id"].nunique()) if len(rows) else 0,
                                   "trainEligible": bool(len(rows) and (rows["side_new"] == "TRAIN").any()), "validationEligible": bool(len(rows) and (rows["side_new"] == "VAL").any()),
                                   "holdoutEligible": bool(len(rows) and (rows["side_new"] == "HOLD").any()),
                                   "spanLabels": int(rows["span_labels"].notna().sum()) if len(rows) else 0, "mixedLabels": int((rows["fine_label"] == "MIXED").sum()) if len(rows) else 0}
    for p_, obj in ((D / "manifests" / "f006_1_1_validation.json", vman), (man_path, hman), (D / "manifests" / "f006_1_1_train_extra.json", eman),
                    (D / "manifests" / "F006_1_1_DATASET_MANIFEST.json", dsman)):
        write_json(p_, obj)
        write_json(REPO / "datasets" / "manifests" / p_.name, obj)
    write_json(REPO / "reports" / "f006_1_1" / "split_distribution.json", {"manifest_sha256": {"holdout": sha256_file(man_path)}, "validation": summary(vtexts),
                                                                        "holdout_metadata_only": summary(htexts), "train_extra": eman, "leakage": leak, "dedup": dedup})
    log(f"LOCKED F006_1_1 holdout {len(htexts):,} ({hman['humans']:,} humans, {hman['spanish_humans']:,} Spanish humans, {hman['span_docs']:,} span, "
        f"{hman['mixed_docs']:,} mixed); validation {len(vtexts):,}; train new {len(tn):,} in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
