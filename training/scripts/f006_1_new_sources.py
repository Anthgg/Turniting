"""F006.1: add public Spanish HUMAN sources (official HF repos only), dedup against TURNITING_DATASET_V2.

    python scripts/f006_1_new_sources.py --out /content/drive/MyDrive/turniting/f006_1

Sources (all registered in the output manifest with license / provenance):
* XL-Sum Spanish (csebuetnlp/xlsum, BBC Mundo, CC BY-NC-SA 4.0, research only): professional journalism written
  for a Latin-American audience, published before 2021 -> HUMAN_STRONG, region LATAM_INTERNATIONAL.
* CC-NEWS-ES (LeoCordoba/CC-NEWS-ES, MIT): Spanish-language news crawled in 2019 (pre-LLM); region from the
  site's country TLD when it has one (.mx .ar .co .pe .cl .es ...) -> HUMAN_STRONG when dated <= 2020.
Nothing is scraped; only public dataset files are read. Texts stay on Drive (never in Git).
Exact duplicates (normalized hash) and near duplicates (MinHash J>=0.8) against V2 Spanish rows are dropped.
Every article is its own group (group_id = source:url-or-id hash), so splits stay group-safe.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import tarfile
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import log, write_json  # noqa: E402
from turniting_train.textnorm import normalized_text_hash  # noqa: E402

TLD_REGION = {"mx": "MX", "ar": "AR", "co": "CO", "pe": "PE", "cl": "CL", "es": "ES", "ve": "VE", "ec": "EC", "uy": "UY",
              "bo": "BO", "py": "PY", "cr": "CR", "gt": "GT", "hn": "HN", "sv": "SV", "ni": "NI", "pa": "PA", "do": "DO",
              "cu": "CU", "pr": "PR"}


def h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:20]


def clean(t: str) -> str:
    t = re.sub(r"[ \t]+", " ", t or "").strip()
    return re.sub(r"\n{3,}", "\n\n", t)


def xlsum(max_rows: int) -> pd.DataFrame:
    from huggingface_hub import hf_hub_download

    p = hf_hub_download("csebuetnlp/xlsum", "data/spanish_XLSum_v2.0.tar.bz2", repo_type="dataset")
    rows = []
    with tarfile.open(p, "r:bz2") as tf:
        for m in tf.getmembers():
            if not m.isfile() or not m.name.endswith(".jsonl"):
                continue
            split = Path(m.name).stem.split("_")[-1]
            for line in io.TextIOWrapper(tf.extractfile(m), encoding="utf-8"):
                r = json.loads(line)
                text = clean(r.get("text", ""))
                if len(text.split()) < 40:
                    continue
                rows.append({"src_id": r.get("id") or r.get("url"), "url": r.get("url"), "text": text, "title": r.get("title"),
                             "original_split": split})
    df = pd.DataFrame(rows)
    df = df.sample(min(max_rows, len(df)), random_state=61) if len(df) > max_rows else df
    df["dataset"], df["domain"], df["region"], df["year"] = "xlsum_es_bbcmundo", "news", "LATAM_INTERNATIONAL", None
    df["provenance"], df["license"] = "HUMAN_STRONG", "CC-BY-NC-SA-4.0 (research only)"
    return df


def ccnews(max_rows: int, max_files: int) -> pd.DataFrame:
    from huggingface_hub import HfApi, hf_hub_download

    files = sorted(f for f in HfApi().list_repo_files("LeoCordoba/CC-NEWS-ES", repo_type="dataset") if f.endswith((".parquet", ".csv", ".json", ".jsonl", ".gz")))
    frames = []
    for f in files[:max_files]:
        p = hf_hub_download("LeoCordoba/CC-NEWS-ES", f, repo_type="dataset")
        if f.endswith(".parquet"):
            frames.append(pd.read_parquet(p))
        elif ".json" in f:
            frames.append(pd.read_json(p, lines=True))
        else:
            frames.append(pd.read_csv(p))
    df = pd.concat(frames, ignore_index=True)
    tcol = next(c for c in ("text", "content", "article") if c in df.columns)
    ucol = next((c for c in ("url", "link") if c in df.columns), None)
    dcol = next((c for c in ("country", "domain", "source") if c in df.columns), None)
    df = df.rename(columns={tcol: "text"})
    df["text"] = df["text"].map(clean)
    df = df[df["text"].str.split().str.len() >= 40]
    df["url"] = df[ucol] if ucol else None
    host = (df[ucol].astype(str).str.extract(r"https?://([^/]+)")[0] if ucol else df[dcol].astype(str) if dcol else pd.Series([""] * len(df), index=df.index))
    tld = host.fillna("").str.extract(r"\.([a-z]{2})$")[0]
    df["region"] = tld.map(TLD_REGION).fillna("UNKNOWN")
    df["src_id"] = df["url"].fillna(df["text"].str[:200])
    df = df.sample(min(max_rows, len(df)), random_state=62) if len(df) > max_rows else df
    df["dataset"], df["domain"], df["year"] = "cc_news_es_2019", "news", 2019
    df["provenance"], df["license"], df["title"], df["original_split"] = "HUMAN_STRONG", "MIT (dataset card); article rights remain with publishers; research use", None, None
    return df[["src_id", "url", "text", "title", "original_split", "dataset", "domain", "region", "year", "provenance", "license"]]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/content/drive/MyDrive/turniting/f006_1")
    ap.add_argument("--master", default="/content/f006work/master_v2")
    ap.add_argument("--xlsum-rows", type=int, default=25000)
    ap.add_argument("--ccnews-rows", type=int, default=25000)
    ap.add_argument("--ccnews-files", type=int, default=4)
    ap.add_argument("--repo-reports", default=str(Path(__file__).resolve().parents[1] / "reports" / "f006_1"))
    a = ap.parse_args()
    out = Path(a.out)
    dest = out / "datasets" / "new_spanish_humans.parquet"
    if dest.exists():
        log(f"{dest} exists; skipping")
        return 0
    t0 = time.time()
    status, parts = {}, []
    for name, fn in (("xlsum_es_bbcmundo", lambda: xlsum(a.xlsum_rows)), ("cc_news_es_2019", lambda: ccnews(a.ccnews_rows, a.ccnews_files))):
        try:
            df = fn()
            parts.append(df)
            status[name] = {"status": "DOWNLOADED", "rows_after_length_filter": int(len(df))}
            log(f"{name}: {len(df):,} rows")
        except Exception as e:
            status[name] = {"status": "FAILED", "error": f"{type(e).__name__}: {str(e)[:200]}"}
            log(f"{name}: FAILED {e}")
    if not parts:
        write_json(out / "manifests" / "new_spanish_sources.json", {"sources": status})
        return 0
    new = pd.concat(parts, ignore_index=True)
    new["text_hash"] = new["text"].map(normalized_text_hash)
    before = len(new)
    new = new.drop_duplicates("text_hash")
    # exact + near duplicates against V2 Spanish rows
    import pyarrow.compute as pc
    import pyarrow.dataset as pads

    v2 = []
    for split in sorted(p.name for p in Path(a.master).iterdir() if p.is_dir()):
        ds = pads.dataset(str(Path(a.master) / split), format="parquet")
        v2.append(ds.to_table(columns=["id", "text_original", "text_hash"], filter=pc.field("language") == "es").to_pandas())
    v2 = pd.concat(v2, ignore_index=True)
    exact = new["text_hash"].isin(set(v2["text_hash"]))
    new = new[~exact].reset_index(drop=True)
    from turniting_train.dedup import MinHasher, band_hashes, candidate_pairs, estimated_jaccard

    mh = MinHasher(num_perm=64, seed=42, max_chars=3000)
    texts = new["text"].tolist() + v2["text_original"].tolist()
    sig = np.stack([mh.signature(t) for t in texts])
    pairs = candidate_pairs(band_hashes(sig, 8), np.ones(len(texts), bool))
    near_new = set()
    if len(pairs):
        j = estimated_jaccard(sig, pairs)
        p = pairs[j >= 0.8]
        n0 = len(new)
        for x, y in p:
            if x < n0 <= y:
                near_new.add(int(x))
            elif y < n0 <= x:
                near_new.add(int(y))
            elif x < n0 and y < n0:
                near_new.add(int(max(x, y)))
    new = new.drop(index=sorted(near_new)).reset_index(drop=True)
    new["id"] = [f"f0061:{d}:{h(str(s))}" for d, s in zip(new["dataset"], new["src_id"])]
    new = new.drop_duplicates("id")
    new["group_id"] = "f0061g:" + new["id"].map(h)
    new["language"], new["fine_label"], new["label"] = "es", "HUMAN", 0
    new["n_words"] = new["text"].str.split().str.len()
    new.to_parquet(dest, index=False)
    man = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sources": status,
           "rows_before_dedup": int(before), "exact_dup_vs_v2_removed": int(exact.sum()), "near_dup_removed": len(near_new),
           "rows_final": int(len(new)), "by_dataset": new["dataset"].value_counts().to_dict(),
           "by_region": new.groupby(["dataset", "region"]).size().astype(int).rename(lambda k: "|".join(map(str, k))).to_dict(),
           "by_provenance": new["provenance"].value_counts().to_dict(), "licenses": new.groupby("dataset")["license"].first().to_dict(),
           "official_sources": {"xlsum_es_bbcmundo": "https://huggingface.co/datasets/csebuetnlp/xlsum",
                                "cc_news_es_2019": "https://huggingface.co/datasets/LeoCordoba/CC-NEWS-ES"},
           "seconds": round(time.time() - t0, 1)}
    write_json(out / "manifests" / "new_spanish_sources.json", man)
    write_json(Path(a.repo_reports) / "new_spanish_sources.json", man)
    log(json.dumps({k: man[k] for k in ("rows_final", "by_dataset", "exact_dup_vs_v2_removed", "near_dup_removed")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
