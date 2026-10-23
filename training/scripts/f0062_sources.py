"""F006.2: download + normalise the NEW Track A sources (license-audited) into MyDrive/turniting/f006_2/datasets.

    python scripts/f0062_sources.py            # idempotent; finished sources are skipped

* tdx_thesis_es (Zenodo 7313149, NON_COMMERCIAL / research): streamed (1.6 GB, one sentence per line, documents separated by
  a blank line). A seeded sample of theses is cleaned (front matter, references / bibliography, TOC, citation-dense lines,
  administrative text, OCR damage) and cut into 120-700-word paragraphs, at most PARAS_PER_DOC per thesis.
  parent_document_id = group_id = the thesis; every split is by whole thesis. -> HUMAN_ACADEMIC_STRONG
* spanish_synthetic_2026 (Zenodo 19449815, CC BY 4.0): all machine; group = id_news (same headline across generators /
  temperatures / RAG). Never TRAIN (unseen domain + unseen small generators).
* txd22 is NOT downloaded: the 2026-10-22 audit found it is already a TURNITING_DATASET_V2 source (adapters_v2.txd22), so it is
  historical replay data, not a new source (txd() is kept only for reference and is not called).
Raw files land in datasets/raw with SHA-256 / MD5 verification; normalised parquet in datasets/normalized.
"""

from __future__ import annotations

import hashlib
import io
import json
import random
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0062_common import (A3_LLM, A3_TEMP, MANI, NORM, RAW, SEED, SOURCES, TXD_MIXED, clean_thesis, length_bucket, norm_text,  # noqa: E402
                          sha256_text, stable_id, write_json)

TDX_DOCS = 3200        # theses sampled (of 9,790)
PARAS_PER_DOC = 8


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def fetch(url: str, dest: Path, md5: str | None = None, sha256: str | None = None) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        tmp = dest.with_suffix(dest.suffix + ".part")
        for k in range(5):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "turniting-research/1.0"})
                with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as fh:
                    while chunk := r.read(8 << 20):
                        fh.write(chunk)
                tmp.rename(dest)
                break
            except Exception as e:  # noqa: BLE001
                log(f"download retry {k + 1}: {type(e).__name__}")
                time.sleep(2 ** (k + 1))
        else:
            raise SystemExit(f"ABORT: could not download {url}")
    h5, h256 = hashlib.md5(), hashlib.sha256()
    with open(dest, "rb") as fh:
        while chunk := fh.read(8 << 20):
            h5.update(chunk)
            h256.update(chunk)
    if md5 and h5.hexdigest() != md5:
        raise SystemExit(f"ABORT: md5 mismatch for {dest.name}")
    if sha256 and h256.hexdigest() != sha256:
        raise SystemExit(f"ABORT: sha256 mismatch for {dest.name}")
    return {"file": dest.name, "bytes": dest.stat().st_size, "md5": h5.hexdigest(), "sha256": h256.hexdigest(),
            "downloadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(dest.stat().st_mtime))}


def row(text, fine, dataset, generator, group, parent=None, **kw) -> dict:
    t = norm_text(text)
    n = len(t.split())
    return {"id": stable_id(dataset, group, parent, sha256_text(t)), "text": t, "fine_label": fine, "label": int(fine != "HUMAN"),
            "dataset": dataset, "generator": generator, "group_id": f"{dataset}:{group}", "parent_id": parent, "n_words": n,
            "len_bucket": length_bucket(n), "text_sha256": sha256_text(t), **kw}


def tdx() -> dict:
    src = SOURCES["tdx_thesis_es"]
    info = fetch(src["url"], RAW / "tdx_es.txt", md5=src["md5"])
    rng = random.Random(SEED)
    # pass 1: count documents
    n_docs, prev_blank = 0, True
    with open(RAW / "tdx_es.txt", encoding="utf-8", errors="replace") as fh:
        for ln in fh:
            blank = not ln.strip()
            if not blank and prev_blank:
                n_docs += 1
            prev_blank = blank
    chosen = set(rng.sample(range(n_docs), min(TDX_DOCS, n_docs)))
    rows, agg, k, buf = [], {"docs_total": n_docs, "docs_sampled": len(chosen), "docs_kept": 0}, -1, []

    def flush(idx, lines):
        if idx not in chosen:
            return
        paras, st = clean_thesis("\n".join(lines))
        for key, v in st.items():
            agg[key] = agg.get(key, 0) + v
        if len(paras) < 3:
            agg["docs_too_few_paragraphs"] = agg.get("docs_too_few_paragraphs", 0) + 1
            return
        agg["docs_kept"] += 1
        pick = random.Random(f"{SEED}:{idx}").sample(range(len(paras)), min(PARAS_PER_DOC, len(paras)))
        for j in sorted(pick):
            rows.append(row(paras[j], "HUMAN", "tdx_thesis_es", "human", f"thesis{idx:05d}", parent=f"tdx:thesis{idx:05d}",
                            language="es", domain="academic", source_id=f"thesis{idx:05d}#p{j}", prompt_family=None,
                            transformation_type="none", ai_fraction=0.0, subset="HUMAN_ACADEMIC_STRONG"))

    prev_blank = True
    with open(RAW / "tdx_es.txt", encoding="utf-8", errors="replace") as fh:
        for ln in fh:
            if ln.strip():
                if prev_blank:
                    if buf:
                        flush(k, buf)
                    k, buf = k + 1, []
                buf.append(ln.rstrip("\n"))
                prev_blank = False
            else:
                prev_blank = True
        if buf:
            flush(k, buf)
    df = pd.DataFrame(rows)
    df.to_parquet(NORM / "tdx_thesis_es.parquet", index=False)
    return {**info, **agg, "rows": len(df), "groups": int(df["group_id"].nunique())}


def a3() -> dict:
    src = SOURCES["spanish_synthetic_2026"]
    info = fetch(src["url"], RAW / "spanish_synthetic_2026.zip", md5=src["md5"])
    rows = []
    with zipfile.ZipFile(RAW / "spanish_synthetic_2026.zip") as z:
        for name in sorted(n for n in z.namelist() if n.endswith(".json")):
            paper = name.rsplit("_", 1)[-1].replace(".json", "")
            for r in json.load(io.TextIOWrapper(z.open(name), encoding="utf-8")):
                gen = A3_LLM.get(int(r["id_llm"]), f"llm{r['id_llm']}")
                rows.append(row(r["synthetic_description"], "AI_GENERATED", "spanish_synthetic_2026", gen, f"{paper}:{r['id_news']}",
                                parent=f"news:{paper}:{r['id_news']}", language="es", domain="news_description",
                                source_id=r["_id"]["$oid"] if isinstance(r.get("_id"), dict) else str(r.get("_id")),
                                prompt_family=f"{'RAG' if int(r['RAG']) else 'NO_RAG'}|t={A3_TEMP.get(int(r['id_feature']))}",
                                transformation_type="none", ai_fraction=1.0, subset="SPANISH_SLM_NEWS"))
    df = pd.DataFrame(rows).drop_duplicates("id")
    df = df[df["n_words"] >= 20]
    df.to_parquet(NORM / "spanish_synthetic_2026.parquet", index=False)
    return {**info, "rows": len(df), "groups": int(df["group_id"].nunique()), "by_generator": df["generator"].value_counts().to_dict()}


def txd() -> dict:
    src = SOURCES["txd22"]
    info = fetch(src["url"], RAW / "txd22.csv", sha256=src["sha256"])
    raw = open(RAW / "txd22.csv", "rb").read()
    try:
        text, enc = raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        text, enc = raw.decode("cp1252", errors="replace"), "cp1252"
    t = pd.read_csv(io.StringIO(text))
    rows = []
    for r in t.itertuples(index=False):
        srcl = str(r.Source).strip()
        if "+" in srcl:  # checked first: "Human-written + AI-refined" also starts with "Human"
            s = srcl.lower()
            key = next(k for k in TXD_MIXED if {p.strip().lower() for p in k.split("+")} == {p.strip() for p in s.split("+")}) \
                if any({p.strip().lower() for p in k.split("+")} == {p.strip() for p in s.split("+")} for k in TXD_MIXED) else None
            if key is None:  # unknown spelling: decide from the components, never default to MACHINE
                h, g, r_ = "human" in s, "generated" in s, "refined" in s
                fine, frac = ("MIXED", 0.6) if (h and g and r_) else ("MIXED", 0.5) if (h and g) else ("AI_EDITED", 0.6) if h else ("PARAPHRASED_AI", 1.0)
            else:
                fine, frac = TXD_MIXED[key]
            gen = "mixed:" + srcl
        elif srcl.lower().startswith("human"):
            fine, frac, gen = "HUMAN", 0.0, "human"
        else:
            fine, frac, gen = "AI_GENERATED", 1.0, srcl
        q = norm_text(str(r.Question))
        rows.append(row(str(r.Answer), fine, "txd22", gen, sha256_text(q)[:16], parent=f"txdq:{sha256_text(q)[:16]}", language="en",
                        domain="qa_explanatory", source_id=None, prompt_family="txd_unified_prompt", transformation_type=srcl if "+" in srcl else "none",
                        ai_fraction=frac, subset="TXD22_AUX"))
    df = pd.DataFrame(rows).drop_duplicates("id")
    df = df[df["n_words"] >= 20]
    df.to_parquet(NORM / "txd22.parquet", index=False)
    return {**info, "encoding": enc, "rows": len(df), "groups": int(df["group_id"].nunique()), "by_source": df["generator"].value_counts().to_dict()}


def main() -> int:
    for p in (RAW, NORM, MANI):
        p.mkdir(parents=True, exist_ok=True)
    mp = MANI / "f006_2_sources.json"
    man = json.loads(mp.read_text()) if mp.exists() else {"sources": {}}
    for name, fn, out in (("tdx_thesis_es", tdx, "tdx_thesis_es.parquet"), ("spanish_synthetic_2026", a3, "spanish_synthetic_2026.parquet"),
                          ):
        if (NORM / out).exists() and name in man["sources"]:
            log(f"{name}: done")
            continue
        t0 = time.time()
        log(f"{name}: downloading / normalising")
        res = fn()
        man["sources"][name] = {**{k: v for k, v in SOURCES[name].items() if k != "url"}, "url": SOURCES[name]["url"], **res,
                                "seconds": round(time.time() - t0, 1)}
        write_json(mp, man)
        log(f"{name}: {res['rows']:,} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
