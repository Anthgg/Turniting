"""Build TURNITING_DATASET_V2 = TURNITING_DATASET_V1 (reused, splits frozen) + the new sources.

    python scripts/v3_build_dataset.py --raw /content/raw_v2 --v1-master /content/v1/master \
        --work /content/v3work [--datasets ...] [--only-stage 1|2|3] [--workers 12]

Stage 1  per source: adapt -> validate -> dual view (text_original untouched, text_normalized =
         canonical view) -> hashes, language, MinHash (multiprocess) -> parquet shards.
         V1 rows are converted from the V1 master once (same ids, V1 group and split kept).
Stage 2  exact dedup (new vs V1, new vs new), label conflicts, near-dup MinHash/LSH over V1+new
         (no O(N^2)), group union (group_key, exact and near links, V1 groups), split inheritance:
         a new component linked to V1 rows takes their split; a component linked to both V1 train
         and V1 evaluation rows is excluded (BRIDGE_EXCLUDED); holdouts; leakage checks.
Stage 3  master shards per split, evaluation sets (validation V2 + all test families), version
         stability pairs, manifests and statistics.
"""

from __future__ import annotations

import argparse
import gc
import json
import multiprocessing as mp
import os
import random
import shutil
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train import adapters_v2 as A  # noqa: E402
from turniting_train.canon import attack_homoglyph, attack_whitespace, attack_zero_width, canonicalize  # noqa: E402
from turniting_train.common import CONFIG_DIR, git_commit, load_yaml, sha256_file, sha256_text, utc_now, write_json  # noqa: E402
from turniting_train.dedup import MinHasher, band_hashes, candidate_pairs, connected_components, estimated_jaccard  # noqa: E402
from turniting_train.splits import unit_hash  # noqa: E402
from turniting_train.textnorm import invalid_reason, normalized_text_hash  # noqa: E402

DATASET_VERSION = "TURNITING_DATASET_V2"
TRAIN, VALIDATION, TEST = "train", "validation", "test"
ADV_TEST, UGEN_TEST, UDOM_TEST, OOD_TEST = "adversarial_test", "unseen_generator_test", "unseen_domain_test", "ood_test"
ADV_VAL, MIXED_V1, DS_HOLDOUT = "adversarial_validation", "mixed", "dataset_holdout"
EVAL_SIDE = {VALIDATION, TEST, ADV_TEST, UGEN_TEST, UDOM_TEST, OOD_TEST, ADV_VAL, DS_HOLDOUT}

SCHEMA = pa.schema([
    ("id", pa.string()), ("text_original", pa.string()), ("text_normalized", pa.string()),
    ("binary_label", pa.int8()), ("fine_label", pa.string()), ("ai_fraction", pa.float32()),
    ("language", pa.string()), ("language_source", pa.string()), ("domain", pa.string()), ("raw_domain", pa.string()),
    ("generator", pa.string()), ("generator_family", pa.string()), ("dataset", pa.string()), ("subset", pa.string()),
    ("source_id", pa.string()), ("group_key", pa.string()), ("parent_id", pa.string()), ("attack", pa.string()),
    ("edit_type", pa.string()), ("is_mixed", pa.bool_()), ("is_adversarial", pa.bool_()),
    ("span_labels", pa.string()), ("sentence_labels", pa.string()), ("original_split", pa.string()),
    ("role", pa.string()), ("metadata", pa.string()), ("text_hash", pa.string()), ("n_chars", pa.int32()),
    ("n_words", pa.int32()), ("origin", pa.string()), ("v1_group_id", pa.string()), ("v1_split", pa.string()),
])
MASTER_SCHEMA = pa.schema([f for f in SCHEMA if f.name not in ("group_key", "text_hash")]
                          + [pa.field("text_hash", pa.string()), pa.field("group_id", pa.string()),
                             pa.field("split", pa.string())])
INDEX_COLS = ["id", "dataset", "fine_label", "binary_label", "is_mixed", "is_adversarial", "generator_family",
              "domain", "language", "role", "group_key", "parent_id", "text_hash", "n_words", "origin",
              "v1_group_id", "v1_split", "span_labels_present", "attack"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------ stage 1 workers

_HASHER: MinHasher | None = None
_VAL: dict = {}


def _init_worker(hasher_args, val):
    global _HASHER, _VAL
    _HASHER = MinHasher(**hasher_args)
    _VAL = val


def _process(batch: list[dict]) -> tuple[list[dict], np.ndarray, Counter]:
    import langid

    rows, sigs, stats = [], [], Counter()
    for r in batch:
        text = r["text"]
        why = invalid_reason(text, min_chars=_VAL["min_chars"], min_words=_VAL["min_words"])
        if why:
            stats[f"invalid_{why}"] += 1
            continue
        if r["fine_label"] == A.UNKNOWN:
            stats["invalid_unknown_label"] += 1
            continue
        canon = canonicalize(text)
        adv = bool(r["is_adversarial"])
        text_hash = sha256_text(text) if adv else normalized_text_hash(canon)
        lang, lang_src = r.get("language"), "dataset"
        if not lang:
            lang, lang_src = langid.classify(canon[:1000])[0], "detected"
        gen, fam = A.generator_family(r.get("generator_raw")) if r["fine_label"] != A.HUMAN else ("human", "human")
        spans = r.get("span_labels")
        sents = r.get("sentence_labels")
        rows.append({
            "text_original": text, "text_normalized": canon if canon != text else None,
            "binary_label": r["binary_label"], "fine_label": r["fine_label"],
            "ai_fraction": None if r.get("ai_fraction") is None else float(r["ai_fraction"]),
            "language": str(lang).lower(), "language_source": lang_src, "domain": A.v2_domain(r.get("raw_domain")),
            "raw_domain": None if r.get("raw_domain") is None else str(r["raw_domain"]),
            "generator": gen, "generator_family": fam, "dataset": r["dataset"],
            "subset": None if r.get("subset") is None else str(r["subset"]), "source_id": A._s(r.get("source_id")),
            "group_key": r.get("group_key"), "parent_id": r.get("parent_id"), "attack": r.get("attack") or "none",
            "edit_type": r.get("edit_type"), "is_mixed": bool(r.get("is_mixed")), "is_adversarial": adv,
            "span_labels": None if spans is None else json.dumps(spans),
            "sentence_labels": None if sents is None else json.dumps(sents, ensure_ascii=False),
            "original_split": A._s(r.get("original_split")), "role": r.get("role"),
            "metadata": json.dumps(r.get("metadata") or {}, ensure_ascii=False, default=str),
            "text_hash": text_hash, "n_chars": len(text), "n_words": len(text.split()), "origin": "new",
            "v1_group_id": None, "v1_split": None,
        })
        sigs.append(_HASHER.signature(canon))
    arr = np.stack(sigs).astype(np.uint32) if sigs else np.zeros((0, _HASHER.num_perm), np.uint32)
    return rows, arr, stats


def _batched(it, n):
    buf = []
    for x in it:
        buf.append(x)
        if len(buf) >= n:
            yield buf
            buf = []
    if buf:
        yield buf


class Shards:
    def __init__(self, root: Path, rows: int, schema: pa.Schema, prefix: str = "part"):
        self.root, self.rows, self.schema, self.prefix = root, rows, schema, prefix
        self.buf, self.n, self.files = [], 0, []
        root.mkdir(parents=True, exist_ok=True)

    def add_many(self, rows):
        self.buf.extend(rows)
        while len(self.buf) >= self.rows:
            self._write(self.buf[: self.rows])
            self.buf = self.buf[self.rows:]

    def _write(self, rows):
        path = self.root / f"{self.prefix}-{self.n:05d}.parquet"
        pq.write_table(pa.Table.from_pylist(rows, schema=self.schema), path, compression="zstd")
        self.files.append(path)
        self.n += 1

    def close(self):
        if self.buf:
            self._write(self.buf)
            self.buf = []


def stage1_new(name: str, raw: Path, work: Path, cfg: dict, workers: int) -> dict:
    out = work / "stage1" / name
    done = out / "_DONE.json"
    if done.exists():
        return json.loads(done.read_text())
    if out.exists():
        shutil.rmtree(out)
    src = raw / name
    if not src.exists():
        return {"dataset": name, "status": "NOT_DOWNLOADED"}
    t0 = time.time()
    writer = Shards(out, cfg["shard_rows"], SCHEMA)
    sigs, stats, n = [], Counter(), 0
    hasher_args = dict(num_perm=cfg["dedup"]["num_perm"], seed=cfg["seed"], max_chars=cfg["dedup"]["max_chars"])
    adapter = A.ADAPTERS_V2[name]
    try:
        with mp.get_context("fork" if "fork" in mp.get_all_start_methods() else "spawn").Pool(workers, initializer=_init_worker, initargs=(hasher_args, cfg["validation"])) as pool:
            for rows, arr, st in pool.imap(_process, _batched(adapter(src), 2000)):
                stats.update(st)
                for r in rows:
                    r["id"] = f"{name}-v2-{n:08d}"
                    n += 1
                writer.add_many(rows)
                sigs.append(arr)
                if n and n % 200_000 < 2000:
                    log(f"  {name}: {n:,} rows ({time.time() - t0:.0f}s)")
    except Exception as exc:
        log(f"  {name}: ADAPTER FAILED {type(exc).__name__}: {exc}")
        shutil.rmtree(out, ignore_errors=True)
        return {"dataset": name, "status": "FAILED_ADAPTER", "error": f"{type(exc).__name__}: {str(exc)[:400]}"}
    writer.close()
    np.save(out / "minhash.npy", np.concatenate(sigs) if sigs else np.zeros((0, cfg["dedup"]["num_perm"]), np.uint32))
    res = {"dataset": name, "status": "OK", "rows_valid": n, "stats": dict(stats), "seconds": round(time.time() - t0, 1),
           "shards": [p.name for p in writer.files]}
    write_json(done, res)
    log(f"stage1 {name}: {n:,} valid rows {dict(stats)} ({res['seconds']}s)")
    return res


def _v1_convert(batch: list[dict]):
    rows, sigs = [], []
    for r in batch:
        text = r["text"]
        canon = canonicalize(text)
        adv = bool(r["is_adversarial"])
        if r["label"] is None or (isinstance(r["label"], float) and r["label"] != r["label"]):
            fine, binary = A.MIXED, None
        else:
            binary = int(r["label"])
            fine = A.HUMAN if binary == 0 else (A.PARAPHRASED_AI if adv else A.AI_GENERATED)
        gen, fam = ("human", "human") if fine == A.HUMAN else A.generator_family(r["generator"])
        rows.append({
            "id": r["id"], "text_original": text, "text_normalized": canon if canon != text else None,
            "binary_label": binary, "fine_label": fine, "ai_fraction": None if fine == A.MIXED else float(binary),
            "language": r["language"], "language_source": r["language_source"], "domain": r["domain"],
            "raw_domain": r["raw_domain"], "generator": gen, "generator_family": fam, "dataset": r["dataset"],
            "subset": r["subset"], "source_id": r["source_id"], "group_key": None, "parent_id": None,
            "attack": r["attack"], "edit_type": None, "is_mixed": bool(r["is_mixed"]), "is_adversarial": adv,
            "span_labels": None, "sentence_labels": None, "original_split": r["original_split"], "role": r["role"],
            "metadata": r["metadata"], "text_hash": sha256_text(text) if adv else normalized_text_hash(canon),
            "n_chars": len(text), "n_words": len(text.split()), "origin": "v1", "v1_group_id": r["group_id"],
            "v1_split": r["split"],
        })
        sigs.append(_HASHER.signature(canon))
    return rows, np.stack(sigs).astype(np.uint32)


def stage1_v1(v1_master: Path, work: Path, cfg: dict, workers: int) -> dict:
    out = work / "stage1" / "_v1"
    done = out / "_DONE.json"
    if done.exists():
        return json.loads(done.read_text())
    if out.exists():
        shutil.rmtree(out)
    t0 = time.time()
    writer = Shards(out, cfg["shard_rows"], SCHEMA)
    sigs, n = [], 0
    hasher_args = dict(num_perm=cfg["dedup"]["num_perm"], seed=cfg["seed"], max_chars=cfg["dedup"]["max_chars"])

    def batches():
        for shard in sorted(v1_master.rglob("*.parquet")):
            df = pd.read_parquet(shard)
            yield from _batched(df.to_dict("records"), 2000)

    with mp.get_context("fork" if "fork" in mp.get_all_start_methods() else "spawn").Pool(workers, initializer=_init_worker, initargs=(hasher_args, cfg["validation"])) as pool:
        for rows, arr in pool.imap(_v1_convert, batches()):
            writer.add_many(rows)
            sigs.append(arr)
            n += len(rows)
            if n % 200_000 < 2000:
                log(f"  v1: {n:,} rows ({time.time() - t0:.0f}s)")
    writer.close()
    np.save(out / "minhash.npy", np.concatenate(sigs))
    res = {"dataset": "_v1", "status": "OK", "rows_valid": n, "seconds": round(time.time() - t0, 1)}
    write_json(done, res)
    log(f"stage1 V1 converted: {n:,} rows ({res['seconds']}s)")
    return res


# ------------------------------------------------------------------ stage 2

def load_index(work: Path, names: list[str]) -> tuple[pd.DataFrame, np.ndarray]:
    frames, sigs = [], []
    for name in ["_v1", *names]:
        d = work / "stage1" / name
        if not (d / "_DONE.json").exists():
            continue
        for shard in sorted(d.glob("part-*.parquet")):
            t = pq.read_table(shard, columns=[c for c in INDEX_COLS if c != "span_labels_present"] + ["span_labels"])
            df = t.to_pandas()
            df["span_labels_present"] = df["span_labels"].notna()
            frames.append(df.drop(columns=["span_labels"]))
        sigs.append(np.load(d / "minhash.npy"))
    df = pd.concat(frames, ignore_index=True)
    for col in ("dataset", "fine_label", "generator_family", "domain", "language", "role", "origin", "v1_split", "attack"):
        df[col] = df[col].astype("category")
    return df, np.concatenate(sigs)


def stage2(work: Path, names: list[str], cfg: dict) -> pd.DataFrame:
    log("stage2: loading index")
    df, sigs = load_index(work, names)
    assert len(df) == len(sigs), (len(df), len(sigs))
    n = len(df)
    is_v1 = (df["origin"] == "v1").values
    log(f"  rows: V1={int(is_v1.sum()):,} new={int((~is_v1).sum()):,}")
    prio = {d: i for i, d in enumerate(cfg["dataset_priority"])}
    df["_prio"] = df["dataset"].astype(str).map(prio).fillna(50).astype(int)
    df.loc[is_v1, "_prio"] = -1  # V1 copy always survives
    status = np.array(["KEPT"] * n, dtype=object)
    human = (df["fine_label"] == A.HUMAN).values

    # --- label conflicts among new rows (+ against V1): same text, human and non-human
    hum_per_hash = pd.Series(human).groupby(df["text_hash"].values).agg(["min", "max"])
    conflict_hashes = set(hum_per_hash.index[hum_per_hash["min"] != hum_per_hash["max"]])
    conflict = df["text_hash"].isin(conflict_hashes).values & ~is_v1
    status[conflict] = "LABEL_CONFLICT"

    # --- exact duplicates: first copy by (_prio, id) survives; V1 rows are never removed
    order = df.sort_values(["_prio", "id"]).index.values
    first_idx = pd.Series(order, index=df["text_hash"].values[order]).groupby(level=0).first()
    rep = first_idx.reindex(df["text_hash"].values).values  # representative row per hash
    dup = (rep != np.arange(n)) & (status == "KEPT") & ~is_v1
    status[dup & is_v1[rep]] = "EXACT_DUPLICATE_V1"
    status[dup & ~is_v1[rep]] = "EXACT_DUPLICATE"
    log(f"  exact dup vs V1={int((status == 'EXACT_DUPLICATE_V1').sum()):,} new-new={int((status == 'EXACT_DUPLICATE').sum()):,} "
        f"label-conflict rows={int(conflict.sum()):,}")

    edges = []
    # exact-hash edges (row -> representative), never V1<->V1
    m = (rep != np.arange(n)) & ~(is_v1 & is_v1[rep])
    edges.append(np.stack([np.flatnonzero(m), rep[m]], axis=1))
    # group_key edges among new rows; V1 group edges among V1 rows
    for key in (df["group_key"].where(~is_v1), ("v1:" + df["v1_group_id"].astype(str)).where(is_v1)):
        codes, _ = pd.factorize(key)
        valid = np.flatnonzero(codes >= 0)
        o = valid[np.argsort(codes[valid], kind="stable")]
        sc = codes[o]
        same = sc[1:] == sc[:-1]
        edges.append(np.stack([o[:-1][same], o[1:][same]], axis=1))

    # --- near duplicates (MinHash LSH) over V1 + new; V1-V1 pairs ignored (V1 already deduped)
    nd = cfg["dedup"]
    bands = band_hashes(sigs, nd["bands"])
    pairs = candidate_pairs(bands, np.ones(n, dtype=bool))
    del bands
    gc.collect()
    pairs = pairs[~(is_v1[pairs[:, 0]] & is_v1[pairs[:, 1]])]
    jac = estimated_jaccard(sigs, pairs) if len(pairs) else np.array([])
    near = pairs[jac >= nd["jaccard_threshold"]] if len(pairs) else pairs
    log(f"  near-dup candidate pairs={len(pairs):,} confirmed={len(near):,}")
    adv = df["is_adversarial"].values
    prio_v = df["_prio"].values
    near_removed = Counter()
    mismatch = 0
    for a, b in near:
        if adv[a] or adv[b]:
            continue
        if human[a] != human[b]:
            mismatch += 1
            continue
        keep, drop = (a, b) if (prio_v[a], a) <= (prio_v[b], b) else (b, a)
        if is_v1[drop]:
            keep, drop = drop, keep
            if is_v1[drop]:
                continue
        if status[drop] == "KEPT" and status[keep] == "KEPT":
            status[drop] = "NEAR_DUPLICATE_V1" if is_v1[keep] else "NEAR_DUPLICATE"
            near_removed[status[drop]] += 1
    edges.append(near)
    log(f"  near-dup removed={dict(near_removed)} human/AI near pairs kept+grouped={mismatch:,}")

    # --- components
    comp = connected_components(n, np.concatenate([e for e in edges if len(e)]))
    df["group_id"] = "g" + pd.Series(comp).astype(str).values
    df["_comp"] = comp

    # --- split per component
    sp = cfg["splits"]
    v1_split = df["v1_split"].astype(object).values
    v1_side = np.where(~is_v1, None, np.where(v1_split == TRAIN, "train", np.where(v1_split == MIXED_V1, "mixed", "eval")))
    comp_df = pd.DataFrame({"comp": comp, "v1_side": v1_side, "v1_split": v1_split, "id": df["id"].values,
                            "role": df["role"].astype(object).values, "dataset": df["dataset"].astype(str).values})
    sides = comp_df[is_v1].groupby("comp")["v1_side"].agg(lambda s: frozenset(x for x in s if x != "mixed"))
    v1_base = comp_df[is_v1 & (v1_split != MIXED_V1)].groupby("comp")["v1_split"].agg(
        lambda s: s.iloc[0] if s.nunique() == 1 else TEST)
    forced = comp_df.groupby("comp")["role"].agg(lambda r: bool((r == "official_test").any()))
    holdout_ds = comp_df.groupby("comp")["dataset"].agg(lambda d: bool(d.isin(list(A.DATASET_HOLDOUT)).any()))
    keys = comp_df.groupby("comp")["id"].min()
    u = np.array([unit_hash(k, cfg["seed"]) for k in keys.values])
    base = pd.Series(np.where(u < sp["train"], TRAIN, np.where(u < sp["train"] + sp["validation"], VALIDATION, TEST)),
                     index=keys.index)
    base[forced.reindex(base.index).values] = TEST
    base[holdout_ds.reindex(base.index).values] = DS_HOLDOUT
    bridge = set()
    for c, s in sides.items():
        if "train" in s and "eval" in s:
            bridge.add(c)
        elif s == frozenset({"train"}):
            base[c] = TRAIN if not holdout_ds.get(c, False) else "BRIDGE"
        elif s:
            base[c] = v1_base.get(c, TEST) if v1_base.get(c, TEST) != TRAIN else TEST
    row_base = base.reindex(comp).values
    split = np.array(row_base, dtype=object)

    # new rows only: specialised splits / exclusions (V1 rows keep their V1 split untouched)
    new = ~is_v1
    fam = df["generator_family"].astype(str).values
    dom = df["domain"].astype(str).values
    role = df["role"].astype(object).values
    train_side = row_base == TRAIN
    reason = np.array([None] * n, dtype=object)
    in_bridge = np.isin(comp, list(bridge)) & new
    reason[in_bridge] = "BRIDGE_EXCLUDED"
    reason[(row_base == "BRIDGE") & new] = "BRIDGE_EXCLUDED"
    gen_hold = new & ~human & np.isin(fam, sp["holdout_generator_families"])
    dom_hold = new & np.isin(dom, sp["holdout_domains"]) & ~gen_hold
    advo = new & (role == "adversarial_only")
    for mask, target, why in ((gen_hold, UGEN_TEST, "HOLDOUT_GENERATOR_IN_TRAIN_GROUP"),
                              (dom_hold, UDOM_TEST, "HOLDOUT_DOMAIN_IN_TRAIN_GROUP"),
                              (advo, ADV_TEST, "HOLDOUT_ADVERSARIAL_IN_TRAIN_GROUP")):
        sel = mask & (reason == None)  # noqa: E711
        split[sel & ~train_side & (row_base != DS_HOLDOUT)] = target
        reason[sel & train_side] = why
    adv_eval = new & adv & ~advo & ~gen_hold & ~dom_hold & (reason == None)  # noqa: E711
    split[adv_eval & (row_base == VALIDATION)] = ADV_VAL
    split[adv_eval & (row_base == TEST)] = ADV_TEST
    split[is_v1] = v1_split[is_v1]
    # bridge components are joined only through new rows, which are excluded: their V1 rows keep
    # their own (frozen, disjoint) V1 groups so group bookkeeping matches what is actually used
    v1_in_bridge = is_v1 & np.isin(comp, list(bridge))
    gid = df["group_id"].values.astype(object)
    gid[v1_in_bridge] = "v1:" + df["v1_group_id"].astype(str).values[v1_in_bridge]
    df["group_id"] = gid
    st_kept = status == "KEPT"
    status[st_kept & (reason != None)] = reason[st_kept & (reason != None)]  # noqa: E711
    split[status != "KEPT"] = None
    df["status"] = status
    df["split"] = split

    leak = leakage_report(df, near)
    log(f"  leakage: {leak}")
    sizes = df.groupby("group_id").size()
    summary = {
        "rows_total": int(n), "rows_v1": int(is_v1.sum()), "rows_new": int(new.sum()),
        "status_counts": {k: int(v) for k, v in Counter(status).items()},
        "exact_duplicates_removed": int(sum(v for k, v in Counter(status).items() if k.startswith("EXACT_DUPLICATE"))),
        "near_duplicates_removed": int(sum(near_removed.values())), "near_dup_removed_by_kind": dict(near_removed),
        "label_conflict_rows": int(conflict.sum()), "label_conflict_hashes": len(conflict_hashes),
        "near_dup_candidate_pairs": int(len(pairs)), "near_dup_confirmed_pairs": int(len(near)),
        "near_dup_human_ai_pairs": int(mismatch), "groups": int(len(sizes)), "largest_group": int(sizes.max()),
        "bridge_components": len(bridge), "leakage": leak,
    }
    write_json(work / "stage2_summary.json", summary)
    df.drop(columns=["_prio", "_comp"]).to_parquet(work / "index_v2.parquet", index=False)
    return df


def leakage_report(df: pd.DataFrame, near: np.ndarray) -> dict:
    s = df["split"].astype(object).values
    side = np.where(s == TRAIN, 1, np.where(pd.Series(s).isin(EVAL_SIDE).values, 2, 0))
    kept = side > 0
    tmp = pd.DataFrame({"g": df["group_id"].values[kept], "h": df["text_hash"].values[kept], "side": side[kept],
                        "p": df["parent_id"].values[kept]})
    g = tmp.groupby("g")["side"].nunique()
    hh = tmp.groupby("h")["side"].nunique()
    pp = tmp[tmp["p"].notna()].groupby("p")["side"].nunique()
    cross = int(((side[near[:, 0]] * side[near[:, 1]]) == 2).sum()) if len(near) else 0
    rep = {"exact_hashes_spanning_train_and_eval": int((hh > 1).sum()),
           "near_duplicate_pairs_spanning_train_and_eval": cross,
           "groups_spanning_train_and_eval": int((g > 1).sum()),
           "parent_child_spanning_train_and_eval": int((pp > 1).sum())}
    rep["result"] = "PASS" if all(v == 0 for v in rep.values()) else "FAIL"
    return rep


# ------------------------------------------------------------------ stage 3

def stage3(work: Path, names: list[str], cfg: dict) -> None:
    idx = pd.read_parquet(work / "index_v2.parquet", columns=["id", "status", "split", "group_id"]).set_index("id")
    master = work / "master_v2"
    if master.exists():
        shutil.rmtree(master)
    writers: dict[str, Shards] = {}
    for name in ["_v1", *names]:
        d = work / "stage1" / name
        if not (d / "_DONE.json").exists():
            continue
        for shard in sorted(d.glob("part-*.parquet")):
            tab = pd.read_parquet(shard)
            info = idx.loc[tab["id"]]
            tab["split"] = info["split"].values
            tab["group_id"] = info["group_id"].values
            tab = tab[tab["split"].notna()].drop(columns=["group_key"])
            for split, part in tab.groupby("split"):
                w = writers.setdefault(split, Shards(master / split, cfg["shard_rows"], MASTER_SCHEMA, prefix=split))
                recs = part.to_dict("records")
                for r in recs:
                    for k in ("binary_label",):
                        r[k] = None if r[k] is None or (isinstance(r[k], float) and r[k] != r[k]) else int(r[k])
                    for k in ("ai_fraction",):
                        r[k] = None if r[k] is None or (isinstance(r[k], float) and r[k] != r[k]) else float(r[k])
                    for k in ("text_normalized", "span_labels", "sentence_labels", "parent_id", "edit_type",
                              "source_id", "subset", "raw_domain", "original_split", "role", "v1_group_id", "v1_split"):
                        if isinstance(r.get(k), float):
                            r[k] = None
                w.add_many(recs)
        log(f"  stage3 wrote {name}")
    for w in writers.values():
        w.close()


def build_eval_sets(work: Path, cfg: dict, v1_eval_sets: Path | None, ext_raw: Path | None) -> dict:
    """Frozen evaluation sets (ids + where the text lives). Never used for training."""
    rng_seed = cfg["seed"]
    ev = cfg["eval_sets"]
    idx = pd.read_parquet(work / "index_v2.parquet")
    idx = idx[idx["status"] == "KEPT"].copy()
    idx["is_spanish"] = idx["language"] == "es"
    idx["is_academic"] = idx["domain"] == "academic"
    idx["len_bin"] = pd.cut(idx["n_words"], [0, 50, 150, 400, 10**9], labels=["<50", "50-150", "150-400", "400+"])

    def cap(frame, n, by):
        if len(frame) <= n:
            return frame
        g = frame.groupby(by, observed=True)
        k = max(1, n // max(g.ngroups, 1))
        while g.size().clip(upper=k).sum() < n and k < len(frame):
            k = int(k * 1.3) + 1
        out = pd.concat([x.sample(min(len(x), k), random_state=rng_seed) for _, x in g])
        return out.sample(n, random_state=rng_seed) if len(out) > n else out

    strata = ["dataset", "fine_label", "is_spanish", "is_academic", "len_bin", "is_adversarial"]
    S = {}
    val = idx[idx["split"] == VALIDATION]
    test = idx[idx["split"] == TEST]
    S["validation_v2"] = cap(val, ev["validation_docs"], strata)
    S["validation_v2_spanish"] = cap(val[val["is_spanish"]], ev["validation_docs"] // 4, ["dataset", "fine_label"])
    S["validation_v2_academic"] = cap(val[val["is_academic"]], ev["validation_docs"] // 4, ["dataset", "fine_label"])
    S["test_v2"] = cap(test, ev["test_docs"], strata)
    S["test_v2_spanish"] = cap(test[test["is_spanish"]], ev["subset_docs"], ["dataset", "fine_label", "domain"])
    S["test_v2_academic"] = cap(test[test["is_academic"]], ev["subset_docs"], ["dataset", "fine_label"])
    S["test_v2_mixed"] = cap(test[test["fine_label"] == A.MIXED], ev["subset_docs"], ["dataset"])
    edited = test["fine_label"].isin([A.AI_EDITED, A.HUMAN_EDITED_AI])
    S["test_v2_ai_edited"] = pd.concat([cap(test[edited], ev["subset_docs"] // 2, ["dataset", "fine_label"]),
                                        cap(test[(test["fine_label"] == A.HUMAN) & test["dataset"].isin(test[edited]["dataset"].unique())],
                                            ev["subset_docs"] // 2, ["dataset"])])
    S["test_v2_spans"] = cap(test[test["span_labels_present"] & (test["fine_label"] != A.HUMAN)], ev["subset_docs"] // 2, ["dataset"])
    adv = idx[idx["split"] == ADV_TEST]
    S["test_v2_adversarial"] = cap(adv, ev["subset_docs"], ["dataset", "attack"])
    ug = idx[idx["split"] == UGEN_TEST]
    ugh = test[(test["fine_label"] == A.HUMAN) & test["dataset"].isin(ug["dataset"].unique())]
    ugc = cap(ug, ev["subset_docs"] // 2, ["dataset", "generator_family"])
    S["test_v2_unseen_generator"] = pd.concat([ugc, cap(ugh, len(ugc), ["dataset"])])
    S["test_v2_unseen_domain"] = cap(idx[idx["split"] == UDOM_TEST], ev["subset_docs"], ["dataset", "domain", "fine_label"])
    S["test_v2_ood"] = cap(idx[idx["split"] == OOD_TEST], ev["subset_docs"] // 2, ["dataset", "fine_label"])
    S["dataset_holdout_aigtxt"] = idx[idx["split"] == DS_HOLDOUT]
    rows = [pd.DataFrame({"eval_set": k, "id": v["id"].values, "split": v["split"].values}) for k, v in S.items()]
    if v1_eval_sets is not None and v1_eval_sets.exists():
        v1 = pd.read_parquet(v1_eval_sets)
        keep = {"test": "v1_test", "test_spanish": "v1_test_spanish", "test_academic": "v1_test_academic", "ood": "v1_ood",
                "adversarial": "v1_adversarial", "unseen_generator": "v1_unseen_generator", "unseen_domain": "v1_unseen_domain",
                "validation": "v1_validation"}
        v1 = v1[v1["eval_set"].isin(keep)].copy()
        v1["eval_set"] = v1["eval_set"].map(keep)
        present = set(idx["id"])
        v1 = v1[v1["id"].isin(present)]
        rows.append(v1[["eval_set", "id", "split"]])
    out = pd.concat(rows, ignore_index=True)
    out.to_parquet(work / "eval_sets_v2.parquet", index=False)
    counts = out["eval_set"].value_counts().to_dict()
    log(f"  eval sets: {counts}")
    return {k: int(v) for k, v in counts.items()}


def build_synthetic_and_stability(work: Path, cfg: dict) -> dict:
    """Attack sets (zero-width / homoglyph / whitespace) and version-stability pairs, with text."""
    seed = cfg["seed"]
    rng = random.Random(seed)
    master = work / "master_v2"
    ev = pd.read_parquet(work / "eval_sets_v2.parquet")
    test_ids = ev.loc[ev["eval_set"] == "test_v2", "id"]
    cols = ["id", "text_original", "binary_label", "fine_label", "language", "domain", "dataset", "generator_family",
            "is_adversarial", "metadata", "span_labels", "parent_id", "n_words"]
    import pyarrow.compute as pc
    import pyarrow.dataset as pads

    tds = pads.dataset(str(master / TEST), format="parquet")
    base = tds.to_table(columns=cols, filter=pc.field("id").isin(test_ids.tolist())).to_pandas()
    base = base[base["binary_label"].notna() & ~base["is_adversarial"]]
    base = base.sample(min(len(base), cfg["eval_sets"]["attack_docs"]), random_state=seed)
    attacks = []
    for name, fn in (("zero_width", attack_zero_width), ("homoglyph", attack_homoglyph), ("whitespace", attack_whitespace)):
        for r in base.itertuples(index=False):
            attacks.append({"eval_set": f"synthetic_{name}", "id": f"{r.id}#{name}", "source_row": r.id,
                            "text": fn(r.text_original, rng), "binary_label": int(r.binary_label),
                            "fine_label": r.fine_label, "language": r.language, "domain": r.domain,
                            "dataset": r.dataset, "attack": name})
    pd.DataFrame(attacks).to_parquet(work / "synthetic_attacks.parquet", index=False)

    # version stability: OpAI consecutive versions (test), het-spans control->mixed (test), synthetic minor edits
    pairs = []
    opai = tds.to_table(columns=cols, filter=pc.field("dataset") == "opai_bench").to_pandas()
    if len(opai):
        opai["meta"] = opai["metadata"].map(json.loads)
        opai["ver"] = opai["meta"].map(lambda m: int(m.get("version_index") or 0))
        opai["doc"] = opai["meta"].map(lambda m: f"{m.get('doc_id')}|{m.get('generator')}|{m.get('file')}")
        for doc, g in opai.groupby("doc"):
            g = g.sort_values("ver")
            recs = g.to_dict("records")
            for a, b in zip(recs, recs[1:]):
                if b["ver"] == a["ver"] + 1:
                    pairs.append({"kind": "opai_next_version", "a_id": a["id"], "b_id": b["id"], "a_text": a["text_original"],
                                  "b_text": b["text_original"], "b_spans": b["span_labels"], "a_spans": a["span_labels"]})
        rng.shuffle(pairs)
        pairs = pairs[: cfg["eval_sets"]["stability_pairs"]]
    het = tds.to_table(columns=cols, filter=pc.field("dataset") == "het_ai_spans").to_pandas()
    if len(het):
        het["src"] = het["parent_id"]
        for src, g in het.groupby("src"):
            h_ = g[g["fine_label"] == A.HUMAN]
            m_ = g[g["fine_label"] == A.MIXED]
            if len(h_) and len(m_):
                a, b = h_.iloc[0], m_.iloc[0]
                pairs.append({"kind": "het_control_to_mixed", "a_id": a["id"], "b_id": b["id"], "a_text": a["text_original"],
                              "b_text": b["text_original"], "b_spans": b["span_labels"], "a_spans": None})
    humans = base[(base["fine_label"] == A.HUMAN) & (base["n_words"] > 200)]
    for r in humans.head(cfg["eval_sets"]["stability_pairs"] // 2).itertuples(index=False):
        paras = r.text_original.split("\n\n")
        if len(paras) < 3:
            continue
        k = rng.randrange(len(paras))
        words = paras[k].split(" ")
        for _ in range(max(1, len(words) // 25)):  # light human edit: swap adjacent words / drop one
            i = rng.randrange(max(1, len(words) - 1))
            words[i:i + 2] = words[i:i + 2][::-1]
        edited = "\n\n".join(paras[:k] + [" ".join(words)] + paras[k + 1:])
        pairs.append({"kind": "human_minor_edit", "a_id": r.id, "b_id": f"{r.id}#edit", "a_text": r.text_original,
                      "b_text": edited, "b_spans": None, "a_spans": None, "changed_paragraph": k})
    pd.DataFrame(pairs).to_parquet(work / "version_stability_pairs.parquet", index=False)
    kinds = Counter(p["kind"] for p in pairs)
    log(f"  synthetic attacks={len(attacks):,} stability pairs={dict(kinds)}")
    return {"synthetic_attacks": len(attacks), "stability_pairs": dict(kinds)}


def build_external(raw: Path, work: Path) -> int:
    src = raw / "ai_text_detection_benchmark_2026"
    if not src.exists():
        return 0
    rows = []
    for r in A.ai_text_detection_benchmark_2026(src):
        rows.append({"id": f"ext2026-{len(rows):05d}", "text": r["text"], "binary_label": r["binary_label"],
                     "fine_label": r["fine_label"], "generator": r["generator_raw"], "domain": A.v2_domain(r["raw_domain"]),
                     "subset": r["subset"], "negative_control": bool(r["metadata"].get("negative_control"))})
    pd.DataFrame(rows).to_parquet(work / "external_holdout_2026.parquet", index=False)
    return len(rows)


def statistics(work: Path, stage1: dict, eval_counts: dict, extra: dict) -> dict:
    idx = pd.read_parquet(work / "index_v2.parquet")
    summary = json.loads((work / "stage2_summary.json").read_text())
    kept = idx[idx["status"] == "KEPT"]
    fl = kept["fine_label"].astype(str)
    per_ds = {}
    for ds, g in idx.groupby("dataset", observed=True):
        k = g[g["status"] == "KEPT"]
        per_ds[str(ds)] = {
            "rows_valid": int(len(g)), "kept": int(len(k)),
            "status": {s: int(c) for s, c in g["status"].value_counts().items()},
            "fine_labels": {s: int(c) for s, c in k["fine_label"].astype(str).value_counts().items()},
            "by_split": {s: int(c) for s, c in k["split"].astype(str).value_counts().items()},
            "languages": {s: int(c) for s, c in k["language"].astype(str).value_counts().head(30).items()},
            "generator_families": {s: int(c) for s, c in k["generator_family"].astype(str).value_counts().head(40).items()},
        }
    return {
        "datasetVersion": DATASET_VERSION, "builtAt": utc_now(), "gitCommit": git_commit(),
        "rows_kept": int(len(kept)), "rows_v1_kept": int((kept["origin"] == "v1").sum()),
        "rows_new_kept": int((kept["origin"] == "new").sum()),
        "human": int((fl == A.HUMAN).sum()), "machine": int(fl.isin([A.AI_GENERATED, A.PARAPHRASED_AI]).sum()),
        "mixed": int((fl == A.MIXED).sum()), "ai_edited": int(fl.isin([A.AI_EDITED, A.HUMAN_EDITED_AI]).sum()),
        "fine_labels": {k: int(v) for k, v in fl.value_counts().items()},
        "span_labeled": int(kept["span_labels_present"].sum()),
        "spanish": int((kept["language"] == "es").sum()), "academic": int((kept["domain"] == "academic").sum()),
        "languages": int(kept["language"].nunique()), "domains": int(kept["domain"].nunique()),
        "generators": int(kept.loc[fl != A.HUMAN, "generator_family"].nunique()),
        "generator_list": sorted(kept.loc[fl != A.HUMAN, "generator_family"].astype(str).unique().tolist()),
        "splits": {k: int(v) for k, v in kept["split"].astype(str).value_counts().items()},
        "splits_by_fine_label": {s: {k: int(v) for k, v in g["fine_label"].astype(str).value_counts().items()}
                                 for s, g in kept.groupby(kept["split"].astype(str))},
        "stage1": stage1, "stage2": summary, "by_dataset": per_ds, "eval_sets": eval_counts, **extra,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(CONFIG_DIR / "v3.yaml"))
    ap.add_argument("--raw", default="/content/raw_v2")
    ap.add_argument("--v1-master", default="/content/v1/master")
    ap.add_argument("--v1-eval-sets", default=str(Path(__file__).resolve().parents[1] / "datasets/manifests/eval_sets.parquet"))
    ap.add_argument("--work", default="/content/v3work")
    ap.add_argument("--datasets", nargs="*")
    ap.add_argument("--only-stage", type=int)
    ap.add_argument("--workers", type=int, default=max(1, min((os.cpu_count() or 2) - 1, 12)))
    args = ap.parse_args()
    cfg = load_yaml(Path(args.config))["build"]
    work, raw = Path(args.work), Path(args.raw)
    work.mkdir(parents=True, exist_ok=True)
    names = args.datasets or [n for n in A.ADAPTERS_V2 if n not in A.EVAL_ONLY_DATASETS]
    t0 = time.time()
    s1 = {}
    if args.only_stage in (None, 1):
        s1["_v1"] = stage1_v1(Path(args.v1_master), work, cfg, args.workers)
        for name in names:
            s1[name] = stage1_new(name, raw, work, cfg, args.workers)
            gc.collect()
        write_json(work / "stage1_summary.json", s1)
    else:
        s1 = json.loads((work / "stage1_summary.json").read_text())
    ok = [n for n in names if s1.get(n, {}).get("status") == "OK"]
    if args.only_stage in (None, 2):
        stage2(work, ok, cfg)
    if args.only_stage in (None, 3):
        stage3(work, ok, cfg)
        counts = build_eval_sets(work, cfg, Path(args.v1_eval_sets), raw)
        extra = build_synthetic_and_stability(work, cfg)
        extra["external_holdout_2026_rows"] = build_external(raw, work)
        stats = statistics(work, s1, counts, extra)
        stats["buildSeconds"] = round(time.time() - t0, 1)
        write_json(work / "dataset_v2_statistics.json", stats)
        shards = {str(p.relative_to(work)): {"sha256": sha256_file(p), "bytes": p.stat().st_size,
                                             "rows": pq.ParquetFile(p).metadata.num_rows}
                  for p in sorted((work / "master_v2").rglob("*.parquet"))}
        write_json(work / "master_v2_manifest.json", {
            "datasetVersion": DATASET_VERSION, "builtAt": utc_now(), "gitCommit": git_commit(),
            "schema": [f.name for f in MASTER_SCHEMA], "fineLabels": A.FINE_LABELS,
            "binaryLabel": {"0": "HUMAN", "1": "MACHINE (AI_GENERATED / PARAPHRASED_AI)",
                            "null": "MIXED / AI_EDITED / HUMAN_EDITED_AI (kept with fine labels, not binarized)"},
            "views": {"text_original": "exactly as published (span offsets refer to it)",
                      "text_normalized": "canonical view (canon.canonicalize); null when identical to text_original"},
            "splitRule": "V1 rows keep V1 split; new components inherit the split of linked V1 rows, are excluded when "
                         "linked to both V1 train and V1 evaluation rows, else sha256(seed:min id) 0.8/0.1/0.1; "
                         "official test rows force their component to test",
            "configSha256": sha256_text(json.dumps(cfg, sort_keys=True)), "shards": shards,
        })
        log(f"done in {(time.time() - t0) / 60:.1f} min: kept={stats['rows_kept']:,} leakage={stats['stage2']['leakage']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
