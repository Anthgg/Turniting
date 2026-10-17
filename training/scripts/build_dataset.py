"""Build TURNITING_DATASET_V1 from the raw layer.

Stages (each resumable; outputs under datasets/normalized, manifests, reports):
  1. adapt + validate + conservative normalization + language fill + MinHash signatures,
     written as per-dataset parquet shards (stage1/). RAID is streamed twice: one pass to
     count strata, one to materialise a deterministic stratified sample.
  2. global exact dedup (+ LABEL_CONFLICT), near-dup MinHash/LSH, group union
     (group_key + exact + near links), group-wise splits and holdouts, leakage check.
  3. master parquet shards per split (master/<split>/part-*.parquet), manifests, stats.

    python scripts/build_dataset.py [--only-stage 1|2|3] [--datasets mage hc3 ...]
"""

from __future__ import annotations

import argparse
import gc
import json
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train import adapters  # noqa: E402
from turniting_train.common import (  # noqa: E402
    CONFIG_DIR, DATASET_VERSION, MANIFEST_DIR, NORMALIZED_DIR, RAW_DIR, REPORTS_DIR,
    ensure_disk, git_commit, load_yaml, read_json, sha256_file, sha256_text, utc_now, write_json,
)
from turniting_train.dedup import (  # noqa: E402
    MinHasher, band_hashes, candidate_pairs, connected_components, estimated_jaccard,
)
from turniting_train.splits import (  # noqa: E402
    EVAL_SIDE, MIXED, TRAIN, component_splits, leakage_report, row_split,
)
from turniting_train.textnorm import (  # noqa: E402
    ACADEMIC_DOMAINS, invalid_reason, normalize_text, normalized_text_hash,
)

STAGE1 = NORMALIZED_DIR / "stage1"
MASTER = NORMALIZED_DIR / "master"
INDEX_COLS = ["id", "dataset", "subset", "label", "language", "language_source", "domain",
              "raw_domain", "generator", "generator_family", "attack", "is_adversarial", "is_mixed",
              "original_split", "role", "group_key", "source_id", "normalized_text_hash", "n_chars",
              "n_words"]


STAGE1_SCHEMA = pa.schema([
    ("id", pa.string()), ("text", pa.string()), ("text_normalized", pa.string()), ("label", pa.int8()),
    ("language", pa.string()), ("language_source", pa.string()), ("domain", pa.string()),
    ("raw_domain", pa.string()), ("generator", pa.string()), ("generator_family", pa.string()),
    ("dataset", pa.string()), ("subset", pa.string()), ("source_id", pa.string()), ("group_key", pa.string()),
    ("attack", pa.string()), ("is_adversarial", pa.bool_()), ("is_mixed", pa.bool_()),
    ("original_split", pa.string()), ("role", pa.string()), ("metadata", pa.string()),
    ("normalized_text_hash", pa.string()), ("n_chars", pa.int32()), ("n_words", pa.int32()),
])
MASTER_SCHEMA = pa.schema([f for f in STAGE1_SCHEMA if f.name != "group_key"]
                          + [pa.field("group_id", pa.string()), pa.field("split", pa.string())])


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------ stage 1

def raid_selection(cfg: dict) -> set[str]:
    """Deterministic stratified bottom-k sample of RAID ids."""
    cache = NORMALIZED_DIR / "raid_selection.parquet"
    if cache.exists():
        return set(pd.read_parquet(cache)["id"])
    path = RAW_DIR / "raid" / "train.csv"
    log("RAID pass 1: strata + hash keys")
    parts = []
    for i, chunk in enumerate(adapters.raid_rows(path, chunksize=200_000,
                                                 columns=["id", "model", "domain", "attack", "decoding",
                                                          "repetition_penalty"])):
        chunk["attack"] = chunk["attack"].replace("", "none")
        stratum = (chunk["model"] + "|" + chunk["domain"] + "|" + chunk["attack"] + "|" +
                   chunk["decoding"] + "|" + chunk["repetition_penalty"])
        key = chunk["id"].map(lambda s: int(sha256_text(s)[:15], 16))
        parts.append(pd.DataFrame({"id": chunk["id"].values, "stratum": stratum.astype("category").values,
                                   "key": key.values}))
        if i % 5 == 0:
            log(f"  pass1 rows={sum(len(p) for p in parts):,}")
    allrows = pd.concat(parts, ignore_index=True)
    allrows["stratum"] = allrows["stratum"].astype(str)
    counts = allrows["stratum"].value_counts()
    target = cfg["raid"]["target_rows"]
    lo, hi = 1, int(counts.max())
    while lo < hi:  # smallest per-stratum cap k with sum(min(count, k)) >= target
        mid = (lo + hi) // 2
        if np.minimum(counts.values, mid).sum() >= target:
            hi = mid
        else:
            lo = mid + 1
    k = lo
    allrows = allrows.sort_values(["stratum", "key"])
    allrows["rank"] = allrows.groupby("stratum").cumcount()
    sel = allrows[allrows["rank"] < k]
    stats = {
        "available_rows": int(len(allrows)),
        "strata": int(len(counts)),
        "per_stratum_cap": int(k),
        "selected_rows": int(len(sel)),
        "coverage": float(len(sel) / len(allrows)),
        "available_by_attack": allrows["stratum"].str.split("|").str[2].value_counts().to_dict(),
        "selected_by_attack": sel["stratum"].str.split("|").str[2].value_counts().to_dict(),
        "available_by_model": allrows["stratum"].str.split("|").str[0].value_counts().to_dict(),
        "selected_by_model": sel["stratum"].str.split("|").str[0].value_counts().to_dict(),
        "available_by_domain": allrows["stratum"].str.split("|").str[1].value_counts().to_dict(),
        "selected_by_domain": sel["stratum"].str.split("|").str[1].value_counts().to_dict(),
    }
    write_json(MANIFEST_DIR / "raid_sampling.json", stats)
    sel[["id", "stratum"]].to_parquet(cache, index=False)
    log(f"RAID: {len(allrows):,} available, cap {k}/stratum -> {len(sel):,} selected")
    return set(sel["id"])


class ShardWriter:
    def __init__(self, root: Path, shard_rows: int, prefix: str = "part", schema: pa.Schema = STAGE1_SCHEMA):
        self.root, self.shard_rows, self.prefix, self.schema = root, shard_rows, prefix, schema
        self.buffer: list[dict] = []
        self.n = 0
        self.files: list[Path] = []
        root.mkdir(parents=True, exist_ok=True)

    def add(self, row: dict):
        self.buffer.append(row)
        if len(self.buffer) >= self.shard_rows:
            self.flush()

    def flush(self):
        if not self.buffer:
            return
        ensure_disk(0.3, f"write shard {self.root.name}")
        path = self.root / f"{self.prefix}-{self.n:05d}.parquet"
        table = pa.Table.from_pylist(self.buffer, schema=self.schema)
        pq.write_table(table, path, compression="zstd")
        self.files.append(path)
        self.n += 1
        self.buffer = []


def stage1_dataset(name: str, cfg: dict, hasher: MinHasher) -> dict:
    out = STAGE1 / name
    done = out / "_DONE.json"
    if done.exists():
        return read_json(done)
    if out.exists():
        shutil.rmtree(out)
    import langid

    val = cfg["validation"]
    if name == "raid":
        rows = adapters.raid(selected_ids=raid_selection(cfg))
    else:
        rows = adapters.ADAPTERS[name]()
    writer = ShardWriter(out, cfg["shard_rows"])
    sigs, stats = [], Counter()
    by_subdataset = Counter()
    n = 0
    t0 = time.time()
    for rec in rows:
        stats["rows_original"] += 1
        ds = rec["dataset"]
        by_subdataset[ds] += 1
        why = invalid_reason(rec["text"], min_chars=val["min_chars"], min_words=val["min_words"])
        if why:
            stats[f"invalid_{why}"] += 1
            continue
        adv = bool(rec["is_adversarial"])
        text = normalize_text(rec["text"], adversarial=adv)
        if adv:
            clean = normalize_text(rec["text"], adversarial=False)
            text_hash = sha256_text(text)  # attacks must not collapse onto their clean source
        else:
            clean = None
            text_hash = normalized_text_hash(text)
        lang = rec["language"]
        lang_src = rec.get("language_source") or "dataset"
        if not lang:
            lang = langid.classify(text[:1000])[0]
            lang_src = "detected"
        sigs.append(hasher.signature(clean if adv else text))
        writer.add({
            "id": f"{ds}-{n:08d}",
            "text": text,
            "text_normalized": clean,
            "label": rec["label"],
            "language": lang,
            "language_source": lang_src,
            "domain": rec["domain"],
            "raw_domain": None if rec.get("raw_domain") is None else str(rec["raw_domain"]),
            "generator": rec["generator"],
            "generator_family": rec["generator_family"],
            "dataset": ds,
            "subset": rec["subset"],
            "source_id": rec["source_id"],
            "group_key": rec["group_key"],
            "attack": rec["attack"],
            "is_adversarial": adv,
            "is_mixed": bool(rec["is_mixed"]),
            "original_split": rec["original_split"],
            "role": rec["role"],
            "metadata": json.dumps(rec["metadata"], ensure_ascii=False, default=str),
            "normalized_text_hash": text_hash,
            "n_chars": len(text),
            "n_words": len(text.split()),
        })
        n += 1
        if n % 100_000 == 0:
            log(f"  {name}: {n:,} valid rows ({time.time() - t0:.0f}s)")
    writer.flush()
    np.save(out / "minhash.npy", np.stack(sigs).astype(np.uint32) if sigs else np.zeros((0, hasher.num_perm), np.uint32))
    stats["rows_valid"] = n
    result = {"dataset": name, "stats": dict(stats), "by_subdataset": dict(by_subdataset),
              "shards": [p.name for p in writer.files], "seconds": round(time.time() - t0, 1)}
    write_json(done, result)
    log(f"stage1 {name}: {dict(stats)}")
    return result


# ------------------------------------------------------------------ stage 2

def load_index(names: list[str]) -> tuple[pd.DataFrame, np.ndarray]:
    frames, sigs = [], []
    for name in names:
        out = STAGE1 / name
        for shard in sorted(out.glob("part-*.parquet")):
            frames.append(pd.read_parquet(shard, columns=INDEX_COLS))
        sigs.append(np.load(out / "minhash.npy"))
    df = pd.concat(frames, ignore_index=True)
    for col in ("dataset", "subset", "language", "language_source", "domain", "raw_domain", "generator",
                "generator_family", "attack", "original_split", "role"):
        df[col] = df[col].astype("category")
    return df, np.concatenate(sigs)


def stage2(names: list[str], cfg: dict) -> pd.DataFrame:
    log("stage2: loading index")
    df, sigs = load_index(names)
    assert len(df) == len(sigs), (len(df), len(sigs))
    n = len(df)
    log(f"  {n:,} rows")
    df["status"] = "KEPT"
    priority = {d: i for i, d in enumerate(cfg["dataset_priority"])}
    df["_prio"] = df["dataset"].astype(str).map(priority).fillna(99).astype(int)

    # --- exact dedup + label conflicts (mixed rows dedup only among themselves)
    binary = ~df["is_mixed"]
    labels_per_hash = df[binary].groupby("normalized_text_hash", observed=True)["label"].nunique()
    conflict_hashes = set(labels_per_hash[labels_per_hash > 1].index)
    conflict = df["normalized_text_hash"].isin(conflict_hashes) & binary
    df.loc[conflict, "status"] = "LABEL_CONFLICT"
    order = df.sort_values(["_prio", "id"]).index
    first = df.loc[order].drop_duplicates(["normalized_text_hash", "is_mixed"]).index
    dup = ~df.index.isin(first) & (df["status"] == "KEPT")
    df.loc[dup, "status"] = "EXACT_DUPLICATE"
    log(f"  exact duplicates={int(dup.sum()):,} label_conflict_rows={int(conflict.sum()):,} "
        f"conflict_hashes={len(conflict_hashes):,}")

    # --- edges: same group_key, same exact hash
    edges = []
    gk_codes, _ = pd.factorize(df["group_key"])
    hash_codes, _ = pd.factorize(df["normalized_text_hash"])
    for codes in (gk_codes, hash_codes):
        order_idx = np.argsort(codes, kind="stable")
        sc = codes[order_idx]
        same = sc[1:] == sc[:-1]
        edges.append(np.stack([order_idx[:-1][same], order_idx[1:][same]], axis=1))

    # --- near duplicates over surviving rows
    nd = cfg["dedup"]["near"]
    bands = band_hashes(sigs, nd["bands"])
    eligible = (df["status"] == "KEPT").values
    pairs = candidate_pairs(bands, eligible)
    jac = estimated_jaccard(sigs, pairs) if len(pairs) else np.array([])
    near = pairs[jac >= nd["jaccard_threshold"]] if len(pairs) else pairs
    log(f"  near-dup candidate pairs={len(pairs):,} confirmed={len(near):,}")
    edges.append(near)
    del bands
    gc.collect()

    lab = df["label"].values
    adv = df["is_adversarial"].values
    prio = df["_prio"].values
    near_removed = 0
    label_mismatch = 0
    status = df["status"].values.copy()
    for a, b in near:
        if adv[a] or adv[b]:
            continue  # attacks are near copies by design; keep, they are only grouped
        if lab[a] != lab[b]:
            label_mismatch += 1
            continue
        drop = b if (prio[a], a) <= (prio[b], b) else a
        if status[drop] == "KEPT" and status[a if drop == b else b] == "KEPT":
            status[drop] = "NEAR_DUPLICATE"
            near_removed += 1
    df["status"] = status
    log(f"  near duplicates removed={near_removed:,} near-dup label mismatches kept+grouped={label_mismatch:,}")

    # --- groups
    comp = connected_components(n, np.concatenate([e for e in edges if len(e)]))
    df["group_id"] = "g" + pd.Series(comp).astype(str).values
    sizes = df.groupby("group_id").size()
    log(f"  groups={len(sizes):,} largest={int(sizes.max()):,}")

    # --- splits
    sp = cfg["splits"]
    base_by_group = component_splits(df, cfg["seed"], sp)
    row_base = df["group_id"].map(base_by_group)
    split, reason = row_split(row_base, df, set(sp["holdout_generator_families"]), set(sp["holdout_domains"]))
    kept = df["status"] == "KEPT"
    df["split"] = np.where(kept, split, None)
    df.loc[kept & reason.notna(), "status"] = reason[kept & reason.notna()]
    df.loc[df["status"] != "KEPT", "split"] = None

    leak = leakage_report(df)
    # near-dup pairs that cross train/eval after split (must be 0: they share a group)
    s = df["split"].values
    side = np.where(s == TRAIN, 1, np.where(pd.Series(s).isin(EVAL_SIDE).values, 2, 0))
    cross = int(((side[near[:, 0]] * side[near[:, 1]]) == 2).sum()) if len(near) else 0
    leak["near_duplicate_pairs_spanning_train_and_eval"] = cross
    leak["result"] = "PASS" if all(v == 0 for k, v in leak.items() if k != "result") else "FAIL"
    log(f"  leakage: {leak}")

    extra = {
        "exact_duplicates_removed": int((df["status"] == "EXACT_DUPLICATE").sum()),
        "near_duplicates_removed": int((df["status"] == "NEAR_DUPLICATE").sum()),
        "label_conflict_rows": int((df["status"] == "LABEL_CONFLICT").sum()),
        "label_conflict_hashes": len(conflict_hashes),
        "near_dup_candidate_pairs": int(len(pairs)),
        "near_dup_confirmed_pairs": int(len(near)),
        "near_dup_label_mismatch_pairs": int(label_mismatch),
        "groups": int(len(sizes)),
        "largest_group": int(sizes.max()),
        "leakage": leak,
    }
    write_json(NORMALIZED_DIR / "stage2_summary.json", extra)
    df.drop(columns=["_prio"]).to_parquet(NORMALIZED_DIR / "index.parquet", index=False)
    return df


# ------------------------------------------------------------------ stage 3

def stage3(names: list[str], cfg: dict) -> None:
    idx = pd.read_parquet(NORMALIZED_DIR / "index.parquet", columns=["id", "status", "split", "group_id"])
    idx = idx.set_index("id")
    if MASTER.exists():
        shutil.rmtree(MASTER)
    writers: dict[str, ShardWriter] = {}
    for name in names:
        for shard in sorted((STAGE1 / name).glob("part-*.parquet")):
            tab = pd.read_parquet(shard)
            info = idx.loc[tab["id"]]
            tab["split"] = info["split"].values
            tab["group_id"] = info["group_id"].values
            tab = tab[tab["split"].notna()]
            tab = tab.drop(columns=["group_key"])
            tab["label"] = tab["label"].astype(object).where(tab["label"].notna(), None)
            for split, part in tab.groupby("split"):
                w = writers.setdefault(split, ShardWriter(MASTER / split, cfg["shard_rows"], prefix=split,
                                                          schema=MASTER_SCHEMA))
                for rec in part.to_dict("records"):
                    if rec["label"] is not None:
                        rec["label"] = int(rec["label"])
                    if isinstance(rec["text_normalized"], float):
                        rec["text_normalized"] = None
                    w.add(rec)
        log(f"  stage3 wrote {name}")
    for w in writers.values():
        w.flush()


def statistics(cfg: dict, stage1_results: dict) -> dict:
    df = pd.read_parquet(NORMALIZED_DIR / "index.parquet")
    summary = read_json(NORMALIZED_DIR / "stage2_summary.json")
    kept = df[df["status"] == "KEPT"]
    binary = kept[~kept["is_mixed"]]

    def dist(frame, col):
        t = frame.groupby([col, "label"], observed=True).size().unstack(fill_value=0)
        return {str(k): {"human": int(v.get(0, 0)), "machine": int(v.get(1, 0))} for k, v in t.iterrows()}

    per_dataset = {}
    for ds, g in df.groupby("dataset", observed=True):
        k = g[g["status"] == "KEPT"]
        res = stage1_results.get(ds) or stage1_results.get("hc3" if ds.startswith("hc3") else ds, {})
        per_dataset[str(ds)] = {
            "rows_original": int(res.get("by_subdataset", {}).get(ds, res.get("stats", {}).get("rows_original", 0))),
            "rows_valid": int(len(g)),
            "exact_duplicates": int((g["status"] == "EXACT_DUPLICATE").sum()),
            "near_duplicates": int((g["status"] == "NEAR_DUPLICATE").sum()),
            "label_conflicts": int((g["status"] == "LABEL_CONFLICT").sum()),
            "holdout_exclusions": int(g["status"].str.startswith("HOLDOUT").sum()),
            "kept": int(len(k)),
            "human": int((k["label"] == 0).sum()),
            "machine": int((k["label"] == 1).sum()),
            "mixed": int(k["is_mixed"].sum()),
            "by_split": {str(s): int(c) for s, c in k["split"].value_counts().items()},
            "languages": {str(a): int(b) for a, b in k["language"].value_counts().items()},
            "domains": {str(a): int(b) for a, b in k["domain"].value_counts().items()},
            "generators": {str(a): int(b) for a, b in k["generator"].value_counts().head(60).items()},
        }
    invalid = Counter()
    rows_original = 0
    for res in stage1_results.values():
        rows_original += res["stats"].get("rows_original", 0)
        for k_, v in res["stats"].items():
            if k_.startswith("invalid_"):
                invalid[k_[8:]] += v
    stats = {
        "datasetVersion": DATASET_VERSION,
        "builtAt": utc_now(),
        "gitCommit": git_commit(),
        "rows_original": rows_original,
        "rows_invalid": dict(invalid),
        "rows_valid": int(len(df)),
        "exact_duplicates_removed": summary["exact_duplicates_removed"],
        "near_duplicates_removed": summary["near_duplicates_removed"],
        "label_conflicts": summary["label_conflict_rows"],
        "holdout_exclusions": int(df["status"].str.startswith("HOLDOUT").sum()),
        "kept_rows": int(len(kept)),
        "human": int((binary["label"] == 0).sum()),
        "machine": int((binary["label"] == 1).sum()),
        "mixed": int(kept["is_mixed"].sum()),
        "spanish": int((binary["language"] == "es").sum()),
        "academic": int(binary["domain"].isin(ACADEMIC_DOMAINS).sum()),
        "splits": {str(k): int(v) for k, v in kept["split"].value_counts().items()},
        "splits_by_label": {str(s): {"human": int((g["label"] == 0).sum()), "machine": int((g["label"] == 1).sum())}
                            for s, g in binary.groupby("split")},
        "by_language": dist(binary, "language"),
        "by_domain": dist(binary, "domain"),
        "by_generator_family": dist(binary, "generator_family"),
        "by_generator": {k: v for k, v in list(dist(binary, "generator").items())[:200]},
        "by_attack": dist(binary, "attack"),
        "by_dataset": per_dataset,
        "groups": summary["groups"],
        "largest_group": summary["largest_group"],
        "near_dup": {k: summary[k] for k in ("near_dup_candidate_pairs", "near_dup_confirmed_pairs",
                                             "near_dup_label_mismatch_pairs")},
        "leakage": summary["leakage"],
        "config": cfg,
    }
    return stats


def write_stats_md(stats: dict) -> None:
    L = [f"# Dataset statistics — {stats['datasetVersion']}", "",
         f"Built {stats['builtAt']} from commit `{stats['gitCommit'][:10]}`.", "",
         "| metric | value |", "|---|---:|"]
    for k in ("rows_original", "rows_valid", "exact_duplicates_removed", "near_duplicates_removed",
              "label_conflicts", "holdout_exclusions", "kept_rows", "human", "machine", "mixed", "spanish", "academic",
              "groups", "largest_group"):
        L.append(f"| {k} | {stats[k]:,} |")
    L += ["", f"Invalid rows removed: `{stats['rows_invalid']}`", "", "## Splits", "", "| split | rows | human | machine |", "|---|---:|---:|---:|"]
    for s, c in sorted(stats["splits"].items()):
        hm = stats["splits_by_label"].get(s, {"human": 0, "machine": 0})
        L.append(f"| {s} | {c:,} | {hm['human']:,} | {hm['machine']:,} |")
    L += ["", "## Per dataset", "", "| dataset | valid | exact dup | near dup | conflicts | holdout excl. | kept | human | machine | mixed |",
          "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for ds, d in stats["by_dataset"].items():
        L.append(f"| {ds} | {d['rows_valid']:,} | {d['exact_duplicates']:,} | {d['near_duplicates']:,} | "
                 f"{d['label_conflicts']:,} | {d['holdout_exclusions']:,} | {d['kept']:,} | {d['human']:,} | {d['machine']:,} | {d['mixed']:,} |")
    for title, key in (("Languages", "by_language"), ("Domains", "by_domain"),
                       ("Generator families", "by_generator_family"), ("Attacks", "by_attack")):
        L += ["", f"## {title}", "", "| value | human | machine |", "|---|---:|---:|"]
        items = sorted(stats[key].items(), key=lambda kv: -(kv[1]["human"] + kv[1]["machine"]))
        for k, v in items:
            L.append(f"| {k} | {v['human']:,} | {v['machine']:,} |")
    L += ["", "## Leakage checks", "", "```json", json.dumps(stats["leakage"], indent=2), "```", ""]
    (REPORTS_DIR / "dataset_statistics.md").write_text("\n".join(L), encoding="utf-8")


def write_manifests(stats: dict, cfg: dict) -> None:
    shards = {}
    for p in sorted(MASTER.rglob("*.parquet")):
        shards[p.relative_to(NORMALIZED_DIR).as_posix()] = {"sha256": sha256_file(p), "bytes": p.stat().st_size,
                                                            "rows": pq.ParquetFile(p).metadata.num_rows}
    registry = read_json(MANIFEST_DIR / "datasets.json", {"datasets": {}})
    master = {
        "datasetVersion": DATASET_VERSION,
        "builtAt": stats["builtAt"],
        "gitCommit": stats["gitCommit"],
        "configSha256": sha256_text(json.dumps(cfg, sort_keys=True)),
        "schema": ["id", "text", "text_normalized", "label", "language", "language_source", "domain", "raw_domain",
                   "generator", "generator_family", "dataset", "subset", "source_id", "group_id", "attack",
                   "is_adversarial", "is_mixed", "original_split", "split", "role", "metadata",
                   "normalized_text_hash", "n_chars", "n_words"],
        "label": {"0": "HUMAN", "1": "MACHINE", "null": "MIXED (SemEval Subtask C, not binarized)"},
        "rawSha256": {k: v.get("sha256") for k, v in registry["datasets"].items()},
        "shards": shards,
    }
    write_json(MANIFEST_DIR / "master_manifest.json", master)
    idx = pd.read_parquet(NORMALIZED_DIR / "index.parquet", columns=["id", "group_id", "split", "status",
                                                                     "normalized_text_hash"])
    idx.to_parquet(NORMALIZED_DIR / "split_manifest.parquet", index=False)
    write_json(MANIFEST_DIR / "split_manifest.json", {
        "datasetVersion": DATASET_VERSION,
        "rule": "group_id = connected component over (group_key, exact hash, MinHash near-dup) links; "
                "base split = sha256(f'{seed}:{min row id}') < 0.8 train, < 0.9 validation, else test; "
                "groups with official_test/ood rows forced to test; holdouts per configs/build.yaml",
        "seed": cfg["seed"],
        "file": "datasets/normalized/split_manifest.parquet (row id -> group_id, split, status)",
        "sha256": sha256_file(NORMALIZED_DIR / "split_manifest.parquet"),
        "rows": int(len(idx)),
        "split_counts": {str(k): int(v) for k, v in idx["split"].value_counts().items()},
        "status_counts": {str(k): int(v) for k, v in idx["status"].value_counts().items()},
    })
    # back-fill the registry with counts
    for ds, d in stats["by_dataset"].items():
        key = "hc3" if ds == "hc3" else ds
        if key in registry["datasets"]:
            e = registry["datasets"][key]
            e["rows"] = d["rows_valid"] if ds != "hc3_chinese" else e.get("rows")
            e["languages"] = sorted(d["languages"])
            e["domains"] = sorted(d["domains"])
            e["generators"] = sorted(d["generators"])
        if ds == "hc3_chinese" and "hc3_chinese" in registry["datasets"]:
            e = registry["datasets"]["hc3_chinese"]
            e.update(rows=d["rows_valid"], languages=sorted(d["languages"]), domains=sorted(d["domains"]),
                     generators=sorted(d["generators"]))
    write_json(MANIFEST_DIR / "datasets.json", registry)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(CONFIG_DIR / "build.yaml"))
    parser.add_argument("--datasets", nargs="*")
    parser.add_argument("--only-stage", type=int)
    parser.add_argument("--keep-stage1", action="store_true")
    args = parser.parse_args()
    cfg = load_yaml(Path(args.config))
    names = args.datasets or [d for d in adapters.ADAPTERS]
    licenses = {d["dataset"]: d for d in read_json(MANIFEST_DIR / "licenses.json")["datasets"]}
    names = [n for n in names if licenses.get(n, {}).get("status") == "INCLUDED"]
    log(f"datasets: {names}")
    hasher = MinHasher(num_perm=cfg["dedup"]["near"]["num_perm"], seed=cfg["seed"],
                       max_chars=cfg["dedup"]["near"]["max_chars"])
    results = {}
    sources = load_yaml(CONFIG_DIR / "datasets.yaml")["datasets"]
    if args.only_stage in (None, 1):
        for name in names:
            results[name] = stage1_dataset(name, cfg, hasher)
            if sources.get(name, {}).get("delete_raw_after_build"):
                # Disk budget: the sampled rows now live in stage1; raw is re-downloadable and
                # its sha256 stays in datasets.json.
                registry = read_json(MANIFEST_DIR / "datasets.json")
                for rel in sources[name]["files"]:
                    path = RAW_DIR / name / rel
                    if path.exists() and path.stat().st_size > 1e9:
                        path.unlink()
                        registry["datasets"][name].setdefault("raw_deleted_after_build", []).append(rel)
                        log(f"deleted raw {path} after build (sha256 kept in manifest)")
                write_json(MANIFEST_DIR / "datasets.json", registry)
    else:
        results = {n: read_json(STAGE1 / n / "_DONE.json") for n in names}
    if args.only_stage in (None, 2):
        stage2(names, cfg)
    if args.only_stage in (None, 3):
        stage3(names, cfg)
        stats = statistics(cfg, results)
        write_json(REPORTS_DIR / "dataset_statistics.json", stats)
        write_stats_md(stats)
        write_manifests(stats, cfg)
        if not args.keep_stage1:
            # stage1 is a temporary copy; master/ is the single normalized copy kept
            for name in names:
                for p in (STAGE1 / name).glob("part-*.parquet"):
                    p.unlink()
                (STAGE1 / name / "_DONE.json").rename(STAGE1 / name / "_DONE.parts_deleted.json")
        log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
