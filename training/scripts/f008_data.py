"""F008: fetch the similarity / plagiarism sources (official repos only) and normalise them.

    python scripts/f008_data.py

* PAN-PC-11 (Zenodo 3250095, CC-BY-4.0): suspicious docs + source docs + XML plagiarism cases with
  this_offset/this_length/source_offset/source_length/obfuscation/type.
* MIRACL corpus Spanish (miracl/miracl-corpus, Apache-2.0): first N shards (Wikipedia passages; docid = article#k).
* mMARCO Spanish (unicamp-dl/mmarco, google translation): dev.small queries, BM25 top-1000 run, qrels; only the
  passages needed for a BM25-top-100 re-ranking evaluation are kept (no 8.8M-passage load).
* PAWS-X Spanish (google-research-datasets/paws, x-final): paraphrase / adversarial-overlap pairs.
* PAN 2025 / PAN 2026 generative plagiarism: restricted on Zenodo / TIRA -> PENDING_ACCESS (not mirrored).
"""

from __future__ import annotations

import gzip
import json
import re
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import log, write_json  # noqa: E402

W = Path("/content/f008work")
D = Path("/content/drive/MyDrive/turniting/f008")
REPO = Path(__file__).resolve().parents[1]


def dl(url: str, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "turniting-research/f008"})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as fh:
        while True:
            b = r.read(1 << 22)
            if not b:
                break
            fh.write(b)
    return dest


def pan11() -> dict:
    base = W / "pan11"
    if not (base / "extracted").exists():
        p1 = dl("https://zenodo.org/api/records/3250095/files/pan-plagiarism-corpus-2011.part1.rar/content", base / "pan-plagiarism-corpus-2011.part1.rar")
        dl("https://zenodo.org/api/records/3250095/files/pan-plagiarism-corpus-2011.part2.rar/content", base / "pan-plagiarism-corpus-2011.part2.rar")
        subprocess.run("which unrar || (apt-get -qq update && apt-get -qq install -y unrar) >/dev/null 2>&1", shell=True)
        (base / "extracted").mkdir(exist_ok=True)
        r = subprocess.run(["unrar", "x", "-o+", "-inul", str(p1), str(base / "extracted")], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("unrar failed: " + r.stderr[:300])
    ex = base / "extracted"
    xmls = list(ex.rglob("suspicious-document*.xml"))
    cases, susp = [], []
    for x in xmls:
        t = x.read_text(errors="ignore")
        sid = x.stem
        for m in re.finditer(r"<feature[^>]*name=\"plagiarism\"[^>]*/>", t):
            a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(0)))
            cases.append({"suspicious": sid, "this_offset": int(a.get("this_offset", 0)), "this_length": int(a.get("this_length", 0)),
                          "source": Path(a.get("source_reference", "")).stem, "source_offset": int(a.get("source_offset", 0)),
                          "source_length": int(a.get("source_length", 0)), "obfuscation": a.get("obfuscation", "none"), "type": a.get("type", ""),
                          "source_language": a.get("source_language", "en"), "this_language": a.get("this_language", "en")})
        susp.append({"suspicious": sid, "xml": str(x), "txt": str(x.with_suffix(".txt"))})
    srcs = [{"source": p.stem, "txt": str(p)} for p in ex.rglob("source-document*.txt")]
    pd.DataFrame(cases).to_parquet(W / "pan11_cases.parquet", index=False)
    pd.DataFrame(susp).to_parquet(W / "pan11_suspicious.parquet", index=False)
    pd.DataFrame(srcs).to_parquet(W / "pan11_sources.parquet", index=False)
    return {"status": "DOWNLOADED", "license": "CC-BY-4.0", "suspicious_docs": len(susp), "source_docs": len(srcs), "plagiarism_cases": len(cases),
            "obfuscation": pd.DataFrame(cases)["obfuscation"].value_counts().to_dict() if cases else {}}


def miracl(shards: int = 3) -> dict:
    from huggingface_hub import hf_hub_download

    rows = []
    for k in range(shards):
        p = hf_hub_download("miracl/miracl-corpus", f"miracl-corpus-v1.0-es/docs-{k}.jsonl.gz", repo_type="dataset")
        with gzip.open(p, "rt", encoding="utf-8") as fh:
            for line in fh:
                r = json.loads(line)
                rows.append({"docid": r["docid"], "title": r.get("title", ""), "text": r["text"]})
    df = pd.DataFrame(rows)
    df["article"] = df["docid"].str.split("#").str[0]
    df.to_parquet(W / "miracl_es.parquet", index=False)
    return {"status": "DOWNLOADED", "license": "Apache-2.0", "passages": len(df), "articles": int(df["article"].nunique()), "shards": shards}


def mmarco(n_queries: int = 2000, top: int = 100) -> dict:
    from huggingface_hub import hf_hub_download

    q = pd.read_csv(hf_hub_download("unicamp-dl/mmarco", "data/google/queries/dev/spanish_queries.dev.small.tsv", repo_type="dataset"), sep="\t",
                    names=["qid", "query"], dtype={"qid": str})
    run = pd.read_csv(hf_hub_download("unicamp-dl/mmarco", "data/google/runs/run.bm25_spanish-msmarco.txt", repo_type="dataset"), sep=r"\s+",
                      names=["qid", "pid", "rank"], dtype={"qid": str, "pid": str}, engine="python")
    qrels_path = None
    for cand in ("data/qrels.dev.small.tsv", "data/google/qrels.dev.small.tsv", "qrels.dev.small.tsv"):
        try:
            qrels_path = hf_hub_download("unicamp-dl/mmarco", cand, repo_type="dataset")
            break
        except Exception:
            continue
    if qrels_path is None:
        qrels_path = str(dl("https://msmarco.z22.web.core.windows.net/msmarcoranking/qrels.dev.small.tsv", W / "qrels.dev.small.tsv"))
    qrels = pd.read_csv(qrels_path, sep="\t", names=["qid", "x", "pid", "rel"], dtype={"qid": str, "pid": str})
    qs = q[q["qid"].isin(set(qrels["qid"]))].sample(min(n_queries, len(q)), random_state=8)
    run = run[run["qid"].isin(set(qs["qid"])) & (run["rank"] <= top)]
    need = set(run["pid"]) | set(qrels.loc[qrels["qid"].isin(set(qs["qid"])), "pid"])
    coll = hf_hub_download("unicamp-dl/mmarco", "data/google/collections/spanish_collection.tsv", repo_type="dataset")
    keep = []
    with open(coll, encoding="utf-8") as fh:
        for line in fh:
            pid, _, text = line.rstrip("\n").partition("\t")
            if pid in need:
                keep.append({"pid": pid, "text": text})
    pd.DataFrame(keep).to_parquet(W / "mmarco_es_passages.parquet", index=False)
    qs.to_parquet(W / "mmarco_es_queries.parquet", index=False)
    run.to_parquet(W / "mmarco_es_bm25run.parquet", index=False)
    qrels[qrels["qid"].isin(set(qs["qid"]))].to_parquet(W / "mmarco_es_qrels.parquet", index=False)
    return {"status": "DOWNLOADED", "license": "Apache-2.0 (mMARCO) / MS MARCO terms", "queries": len(qs), "passages_kept": len(keep), "bm25_depth": top}


def pawsx() -> dict:
    try:
        p = dl("https://storage.googleapis.com/paws/pawsx/x-final.tar.gz", W / "x-final.tar.gz")
    except Exception as e:  # GCS bucket now 403 -> Google's own HF org copy of the same release
        from datasets import load_dataset

        log(f"PAWS-X GCS failed ({e}); using google-research-datasets/paws-x (es)")
        ds = load_dataset("google-research-datasets/paws-x", "es")
        names = {"train": "translated_train", "validation": "dev_2k", "test": "test_2k"}
        df = pd.concat([ds[k].to_pandas().assign(split=names[k]) for k in ds], ignore_index=True)
        df.to_parquet(W / "pawsx_es.parquet", index=False)
        return {"status": "DOWNLOADED", "source": "huggingface google-research-datasets/paws-x (official Google org)", "license": "PAWS-X: free use with attribution",
                "pairs": len(df), "by_split": df["split"].value_counts().to_dict(), "paraphrase_share": float(df["label"].mean())}
    rows = []
    with tarfile.open(p) as tf:
        for m in tf.getmembers():
            if m.isfile() and "/es/" in m.name and m.name.endswith(".tsv"):
                df = pd.read_csv(tf.extractfile(m), sep="\t", quoting=3, on_bad_lines="skip")
                df["split"] = Path(m.name).stem
                rows.append(df)
    df = pd.concat(rows, ignore_index=True)
    df.to_parquet(W / "pawsx_es.parquet", index=False)
    return {"status": "DOWNLOADED", "license": "PAWS-X: free use with attribution (see repo LICENSE)", "pairs": len(df), "by_split": df["split"].value_counts().to_dict(),
            "paraphrase_share": float(df["label"].mean()) if "label" in df else None}


def main() -> int:
    W.mkdir(parents=True, exist_ok=True)
    man = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "datasets": {}}
    only = set(sys.argv[1:])
    mp = D / "manifests" / "f008_dataset_manifest.json"
    if only and mp.exists():
        man["datasets"] = json.loads(mp.read_text())["datasets"]
    for name, fn in (("pan2011_pan_pc_11", pan11), ("miracl_es", miracl), ("mmarco_es", mmarco), ("pawsx_es", pawsx)):
        if only and name not in only:
            continue
        t0 = time.time()
        try:
            man["datasets"][name] = {**fn(), "seconds": round(time.time() - t0, 1)}
            log(f"{name}: {man['datasets'][name]}")
        except Exception as e:
            man["datasets"][name] = {"status": "FAILED", "error": f"{type(e).__name__}: {str(e)[:300]}"}
            log(f"{name}: FAILED {e}")
    man["datasets"]["pan2025_generative_plagiarism"] = {"status": "PENDING_ACCESS", "source": "Zenodo record 14969012 (restricted)", "license": "restricted"}
    man["datasets"]["pan2026_generative_plagiarism"] = {"status": "PENDING_ACCESS", "source": "Zenodo record 20590774 (restricted) + TIRA protocol (pan-webis-de/pan-code, clef26)",
                                                        "license": "restricted"}
    man["models"] = {"bge_m3": "BAAI/bge-m3 (MIT)", "bge_reranker_v2_m3": "BAAI/bge-reranker-v2-m3 (Apache-2.0)", "e5": "intfloat/multilingual-e5-large-instruct (MIT)",
                     "code": "FlagOpen/FlagEmbedding (MIT)"}
    D.joinpath("manifests").mkdir(parents=True, exist_ok=True)
    write_json(D / "manifests" / "f008_dataset_manifest.json", man)
    write_json(REPO / "reports" / "f008" / "f008_dataset_manifest.json", man)
    for f in W.glob("*.parquet"):
        (D / "datasets").mkdir(parents=True, exist_ok=True)
        subprocess.run(["cp", str(f), str(D / "datasets" / f.name)])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
