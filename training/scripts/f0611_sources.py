"""F006.1.1: download + normalise the new Track-A sources into one parquet (texts stay on Drive), plus the dataset manifest.

    python scripts/f0611_sources.py

Output rows: id, text, dataset, fine_label, language, domain, generator_family, group_id, parent_id, split_hint
(train / validation / test from an official split when one exists, else None), span_labels (JSON [[start,end],...]
or None), provenance, meta (JSON). Group rules follow the task: COWSL2H by student, abstracts by document,
SciELO by contiguous block (no article ids in the sentence-aligned release), SBW by source file + block,
Beemo by prompt_id, GRADTEX by MAGE original / human source, Heterogeneous AI Spans by source_id/group_id.
Only official public sources are read; restricted ones are recorded, never mirrored.
"""

from __future__ import annotations

import bz2
import hashlib
import io
import json
import re
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import log, write_json  # noqa: E402

RAW = Path("/content/f0611_raw")
D = Path("/content/drive/MyDrive/turniting/f006_1_1")
REPO = Path(__file__).resolve().parents[1]
FAM = [("mistral", "mistral"), ("mixtral", "mistral"), ("gemma", "gemma"), ("llama", "llama"), ("gpt", "gpt"), ("zephyr", "mistral"),
       ("tulu", "llama"), ("qwen", "qwen"), ("claude", "claude"), ("gemini", "gemini"), ("cohere", "cohere"), ("command", "cohere"), ("deepseek", "deepseek")]


def fam(name) -> str:
    s = str(name or "").lower()
    return next((f for k, f in FAM if k in s), "unknown") if s and s not in ("none", "nan", "human") else "human"


def h(s: str, n=16) -> str:
    return hashlib.sha256(str(s).encode()).hexdigest()[:n]


def passages(lines, lo=120, hi=700):
    buf, words = [], 0
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        buf.append(ln)
        words += len(ln.split())
        if words >= lo:
            yield " ".join(buf)[: hi * 8]
            buf, words = [], 0


def rec(**k):
    base = {"span_labels": None, "parent_id": None, "split_hint": None, "generator_family": "human", "provenance": None, "meta": None}
    base.update(k)
    return base


def cowsl2h() -> list[dict]:
    d = RAW / "cowsl2h"
    out = []
    for p in d.rglob("*.txt"):
        rel = p.relative_to(d).as_posix()
        low = rel.lower()
        parts = low.split("/")
        if "corrected" in parts or ".corrected." in low or "annot" in low or "anotat" in low or p.name == "id.txt":
            continue
        m = re.match(r"(\d+)\.([A-Z]\d+)_([a-z_]+)", p.name)
        if not m:
            continue
        text = p.read_text(errors="ignore").lstrip("﻿").strip()
        if len(text.split()) < 40:
            continue
        sid, quarter, prompt = m.group(1), m.group(2), m.group(3)
        out.append(rec(id=f"cowsl2h:{sid}:{quarter}:{prompt}:{h(rel, 6)}", text=text, dataset="cowsl2h", fine_label="HUMAN", language="es", domain="essay",
                       group_id=f"cowsl2h:student:{sid}", provenance="HUMAN_SPANISH_HARD (L2 / heritage learners)",
                       meta=json.dumps({"student": sid, "quarter": quarter, "prompt": prompt, "path": rel})))
    return out


def abstracts() -> list[dict]:
    from huggingface_hub import hf_hub_download

    out = []
    for split in ("train", "validation", "test"):
        df = pd.read_parquet(hf_hub_download("Flaglab/academic-knowledge-abstracts-es", f"data/{split}-00000-of-00001.parquet", repo_type="dataset"))
        for i, r in df.iterrows():
            t = str(r["resumen"]).strip()
            if len(t.split()) < 40:
                continue
            out.append(rec(id=f"acad_es:{split}:{i}", text=t, dataset="academic_abstracts_es", fine_label="HUMAN", language="es", domain="academic",
                           group_id=f"acad_es:{h(str(r['titulo']) + t[:200])}", split_hint=split, provenance="HUMAN_ACADEMIC_SPANISH",
                           meta=json.dumps({"faculty": r.get("facultad"), "title": str(r["titulo"])[:200]})))
    return out


def scielo(max_lines=600000) -> list[dict]:
    out = []
    for fid in ("14019287", "14019308", "14019293"):
        url = f"https://ndownloader.figstatic.com/files/{fid}"
        dest = RAW / f"scielo_{fid}"
        if not dest.exists():
            urllib.request.urlretrieve(url, dest)
        raw = dest.read_bytes()
        names = []
        try:
            tf = tarfile.open(fileobj=io.BytesIO(raw))
            names = [m for m in tf.getmembers() if m.isfile()]
            members = [(m.name, tf.extractfile(m).read()) for m in names]
        except tarfile.ReadError:
            import zipfile
            try:
                zf = zipfile.ZipFile(io.BytesIO(raw))
                members = [(n, zf.read(n)) for n in zf.namelist()]
            except zipfile.BadZipFile:
                members = [(f"file_{fid}", raw)]
        for name, data in members:
            if not re.search(r"(\.es$|_es\b|es\.txt|\.es\.)", name.lower()):
                continue
            lines = data.decode("utf-8", "ignore").splitlines()[:max_lines]
            for b, block in enumerate(range(0, len(lines), 2000)):
                for k, ptxt in enumerate(passages(lines[block:block + 2000], 120, 400)):
                    out.append(rec(id=f"scielo:{fid}:{b}:{k}", text=ptxt, dataset="scielo_es", fine_label="HUMAN", language="es", domain="academic",
                                   group_id=f"scielo:{fid}:{name}:{b}", provenance="HUMAN_ACADEMIC (SciELO, sentence-aligned release; block grouping)",
                                   meta=json.dumps({"file": name, "block": b})))
        log(f"  scielo {fid}: members {[n for n, _ in members][:6]}")
    return out


def sbw(max_bytes=600_000_000, max_passages=120000) -> list[dict]:
    url = "http://cs.famaf.unc.edu.ar/~ccardellino/SBWCE/clean_corpus.tar.bz2"
    out = []
    req = urllib.request.Request(url, headers={"User-Agent": "turniting-research/f0611"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        stream = bz2.BZ2File(resp)
        tf = tarfile.open(fileobj=stream, mode="r|")
        read = 0
        for m in tf:
            if not m.isfile():
                continue
            f = tf.extractfile(m)
            data = f.read(30_000_000) if f else b""
            read += len(data)
            lines = data.decode("utf-8", "ignore").splitlines()
            for b, block in enumerate(range(0, len(lines), 5000)):
                for k, ptxt in enumerate(passages(lines[block:block + 5000], 120, 700)):
                    if k % 3:  # keep every third passage for diversity
                        continue
                    out.append(rec(id=f"sbw:{h(m.name, 8)}:{b}:{k}", text=ptxt, dataset="spanish_billion_words", fine_label="HUMAN", language="es",
                                   domain="general", group_id=f"sbw:{m.name}:{b}", provenance="HUMAN_STRONG (SBWCE, pre-2016 corpora)",
                                   meta=json.dumps({"subcorpus_file": m.name})))
            log(f"  sbw {m.name}: {len(out):,} passages ({read / 1e6:.0f} MB read)")
            if read > max_bytes or len(out) >= max_passages:
                break
    return out[:max_passages]


def beemo() -> list[dict]:
    from huggingface_hub import hf_hub_download

    df = pd.read_parquet(hf_hub_download("toloka/beemo", "data/train-00000-of-00001.parquet", repo_type="dataset"))
    out = []
    for r in df.to_dict("records"):
        g = f"beemo:prompt:{r['prompt_id']}"
        for col, label, gen in (("human_output", "HUMAN", None), ("model_output", "AI_GENERATED", r["model"]), ("human_edits", "HUMAN_EDITED_AI", r["model"]),
                                ("llama-3.1-70b_edits", "AI_EDITED", "llama-3.1-70b"), ("gpt-4o_edits", "AI_EDITED", "gpt-4o")):
            t = r.get(col)
            if not isinstance(t, str) or len(t.split()) < 30:
                continue
            out.append(rec(id=f"beemo:{r['id']}:{col}", text=t.strip(), dataset="beemo_f0611", fine_label=label, language="en", domain=str(r["category"]).lower(),
                           group_id=g, generator_family=fam(gen) if label != "HUMAN" else "human", provenance="Beemo (expert / LLM edits)",
                           meta=json.dumps({"prompt_id": r["prompt_id"], "variant": col, "model": gen})))
    return out


GRADTEX_LABEL = {"human": "HUMAN", "MGT": "AI_GENERATED", "completion": "MIXED", "paraphrase": "PARAPHRASED_AI", "polish": "AI_EDITED", "rewrite_style": "AI_EDITED"}


def gradtex() -> list[dict]:
    from huggingface_hub import hf_hub_download

    out = []
    for split in ("train", "validation", "test"):
        df = pd.read_parquet(hf_hub_download("elisabeth-pl-pl/GRADTEX", f"{split}.parquet", repo_type="dataset"))
        for i, r in df.iterrows():
            t = str(r["text"]).strip()
            if len(t.split()) < 30:
                continue
            mage = r.get("original_name_in_MAGE")
            key = str(mage) if pd.notna(mage) and str(mage) else h(str(r.get("human_source_text"))[:500])
            out.append(rec(id=f"gradtex:{split}:{i}", text=t, dataset="gradtex_f0611", fine_label=GRADTEX_LABEL.get(str(r["scenario_family"]), "AI_GENERATED"),
                           language=str(r.get("language") or "en")[:2], domain=str(r.get("domain") or "unknown"), group_id=f"gradtex:{key}",
                           generator_family=fam(r.get("model_family")), split_hint=split,
                           provenance="GRADTEX (partly built on MAGE; deduplicated against V1/V2 MAGE)",
                           meta=json.dumps({"scenario": r["scenario"], "scenario_family": r["scenario_family"], "generator_model": r.get("generator_model"),
                                            "test_split": str(r.get("test_split")), "MAGE": str(r.get("original_name_in_MAGE"))})))
    return out


def has() -> list[dict]:
    from huggingface_hub import hf_hub_download

    out = []
    for cfg in ("mixed", "human_controls"):  # one canonical view; never 'all' together with its member configs
        for split in ("train", "validation", "test"):
            df = pd.read_parquet(hf_hub_download("open-text-detector/heterogeneous-ai-spans", f"data/{cfg}/{split}.parquet", repo_type="dataset"))
            for i, r in df.iterrows():
                t = str(r.get("text") or "").strip()
                if len(t.split()) < 30:
                    continue
                spans = r.get("spans")
                sp = None
                if spans is not None and len(spans):
                    sp = json.dumps([[int(s["start"]), int(s["end"])] if isinstance(s, dict) else [int(s[0]), int(s[1])] for s in spans])
                label = "MIXED" if cfg == "mixed" and sp else "HUMAN"
                gid = r.get("group_id") or r.get("source_id") or h(t[:300])
                out.append(rec(id=f"has:{cfg}:{split}:{r.get('id', i)}", text=t, dataset="has_f0611", fine_label=label, language="en",
                               domain=str(r.get("source_dataset") or r.get("domain") or "unknown"), group_id=f"has:{gid}", parent_id=str(r.get("source_id")),
                               generator_family=fam(r.get("generator") or r.get("model")) if label != "HUMAN" else "human", split_hint=split, span_labels=sp,
                               provenance="Heterogeneous AI Spans (exact AI spans; matched human controls)",
                               meta=json.dumps({"config": cfg, "ai_fraction_chars": r.get("ai_fraction_chars"), "source_dataset": str(r.get("source_dataset"))})))
    return out


SOURCES = {"cowsl2h": cowsl2h, "academic_abstracts_es": abstracts, "scielo_es": scielo, "spanish_billion_words": sbw,
           "beemo": beemo, "gradtex": gradtex, "heterogeneous_ai_spans": has}
LICENSES = {"cowsl2h": ("Apache-2.0 (repo)", "PERMISSIVE"), "academic_abstracts_es": ("CC-BY-4.0", "ATTRIBUTION"), "scielo_es": ("CC-BY-4.0 (bigbio card)", "ATTRIBUTION"),
            "spanish_billion_words": ("CC-BY-SA-4.0", "ATTRIBUTION"), "beemo": ("MIT", "PERMISSIVE"), "gradtex": ("CC-BY-4.0", "ATTRIBUTION"),
            "heterogeneous_ai_spans": ("other (see LICENSE.md)", "UNDECLARED")}
NOT_DOWNLOADED = {
    "cedel2": {"status": "MANUAL_ACCESS_REQUIRED", "license": "CC-BY-NC-ND-3.0-ES", "category": "NON_COMMERCIAL",
               "notes": "cedel2.learnercorpora.com exposes a search UI only; bulk export requires a user session; not automated"},
    "aiud_span_v2": {"status": "BLOCKED_ACCESS", "license": "unknown (gated)", "category": "BLOCKED", "notes": "gated on Hugging Face; no HF_TOKEN in Colab Secrets"},
    "semeval2024_task8_subtask_c": {"status": "UNAVAILABLE", "license": "unknown", "category": "UNDECLARED",
                                    "notes": "github.com/mbzuai-nlp/SemEval2024-task8 not reachable anonymously (clone asks for credentials); data links point to Google Drive"},
}


def main() -> int:
    D.joinpath("datasets").mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    rows, man = [], {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "datasets": {}}
    for name, fn in SOURCES.items():
        t0 = time.time()
        try:
            r = fn()
            rows.extend(r)
            df = pd.DataFrame(r)
            man["datasets"][name] = {"status": "DOWNLOADED", "rows": len(r), "bytes_text": int(df["text"].str.len().sum()) if len(df) else 0,
                                     "license": LICENSES[name][0], "license_category": LICENSES[name][1],
                                     "language": df["language"].value_counts().to_dict() if len(df) else {}, "fine_labels": df["fine_label"].value_counts().to_dict() if len(df) else {},
                                     "groups": int(df["group_id"].nunique()) if len(df) else 0, "span_labelled": int(df["span_labels"].notna().sum()) if len(df) else 0,
                                     "mixed": int((df["fine_label"] == "MIXED").sum()) if len(df) else 0, "seconds": round(time.time() - t0, 1)}
            log(f"{name}: {len(r):,} rows")
        except Exception as e:
            man["datasets"][name] = {"status": "FAILED", "error": f"{type(e).__name__}: {str(e)[:300]}", "license": LICENSES[name][0]}
            log(f"{name}: FAILED {e}")
    man["datasets"].update(NOT_DOWNLOADED)
    df = pd.DataFrame(rows)
    df.to_parquet(D / "datasets" / "new_sources_raw.parquet", index=False)
    write_json(D / "manifests" / "new_sources_download.json", man)
    write_json(REPO / "reports" / "f006_1_1" / "new_sources_download.json", man)
    log(f"total {len(df):,} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
