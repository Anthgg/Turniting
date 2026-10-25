"""F006.3 new Track A sources (license-audited, see reports/F006_3_LICENSE_AUDIT.json), written to f006_3/datasets/normalized.

    python scripts/f0063_sources.py

* openalex_academic (CC0 metadata; abstracts as distributed by OpenAlex): HUMAN academic abstracts, ES / EN / PT / FR / DE (+ IT, NL),
  publication years 2012-2020 (before public LLM writing tools). parent_document_id = OpenAlex work; split unit = whole venue.
  Topic labels (concept names) are kept for generation prompts; abstract text is never shown to a generator except for the
  HUMAN_REVISED_BY_AI / insert classes, which inherit the source work as parent.
* aigtbench (Apache-2.0, EN social media): human + GPT-3.5 / GPT-4o / GPT-4o-mini / Llama-2 / LLaMA-65B / Llama-3.1 rows.
  GPT-4o, GPT-4o-mini and Llama-3.1 are FINAL_ONLY (modern unseen generators); the rest may train.
"""

from __future__ import annotations

import json
import random
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0063_common import MANI, NORM, RAW, SEED, is_presentation, norm_text, sha256_text, stable_id, write_json  # noqa: E402

OA_TARGET = {"es": 7000, "en": 5500, "pt": 3500, "fr": 3500, "de": 3500, "it": 900, "nl": 900}
AIGT = "https://huggingface.co/datasets/tarryzhang/AIGTBench/resolve/6f1557d800b69df1a445ff5fff254971e8c45380/data/{f}"
AIGT_FINAL_ONLY = ("gpt-4o", "gpt4o", "llama-3.1", "llama3.1")
MAIL = "anthgg17@gmail.com"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get(url: str, tries: int = 6):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": f"turniting-research (mailto:{MAIL})"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            log(f"retry {k + 1}: {type(e).__name__}")
            time.sleep(2 ** (k + 1))
    raise SystemExit(f"ABORT: {url[:120]}")


def abstract(inv: dict | None) -> str:
    if not inv:
        return ""
    pos = sorted((p, w) for w, ps in inv.items() for p in ps)
    return " ".join(w for _, w in pos)


def openalex(lang: str, n: int) -> list[dict]:
    rows, seen = [], set()
    sel = "id,title,language,publication_year,primary_location,abstract_inverted_index,concepts,type"
    for seed in range(1, 40):
        if len(rows) >= n:
            break
        for flt in (f"language:{lang}", f"language:https://openalex.org/languages/{lang}"):
            q = urllib.parse.urlencode({"filter": f"{flt},has_abstract:true,publication_year:2012-2020,type:article", "sample": 2000,
                                        "seed": SEED + seed, "per-page": 200, "select": sel, "mailto": MAIL})
            got = 0
            for page in range(1, 11):
                d = get(f"https://api.openalex.org/works?{q}&page={page}")
                res = d.get("results") or []
                got += len(res)
                for w in res:
                    if w["id"] in seen:
                        continue
                    seen.add(w["id"])
                    t = norm_text(abstract(w.get("abstract_inverted_index")))
                    nw = len(t.split())
                    if nw < 80 or nw > 450 or is_presentation(t):
                        continue
                    src = ((w.get("primary_location") or {}).get("source") or {})
                    venue = src.get("id") or f"novenue:{w['id']}"
                    con = sorted(w.get("concepts") or [], key=lambda c: (-c.get("score", 0)))
                    lvl0 = next((c["display_name"] for c in con if c.get("level") == 0), "General")
                    lvl1 = next((c["display_name"] for c in con if c.get("level") == 1), lvl0)
                    rows.append({"id": stable_id("openalex", w["id"]), "text": t, "fine_label": "HUMAN", "label": 0, "cls": "HUMAN",
                                 "dataset": "openalex_academic", "generator": "human", "language": lang, "domain": "academic",
                                 "field": lvl0, "topic": lvl1, "venue": venue, "group_id": f"venue:{venue}", "parent_id": w["id"],
                                 "source_id": w["id"], "year": w.get("publication_year"), "n_words": nw, "text_sha256": sha256_text(t),
                                 "section_type": "ABSTRACT", "ai_fraction": 0.0, "transformation_type": "none"})
                if len(res) < 200 or len(rows) >= n:
                    break
            if got:
                break
        log(f"openalex {lang}: {len(rows):,}")
    return rows[:n]


def aigtbench() -> pd.DataFrame:
    parts = []
    for f in ("test-00000-of-00002.parquet", "train-00000-of-00002.parquet"):
        p = RAW / f"aigtbench_{f}"
        if not p.exists():
            urllib.request.urlretrieve(AIGT.format(f=f), p)
        parts.append(pd.read_parquet(p).assign(source_split=f.split("-")[0]))
    df = pd.concat(parts, ignore_index=True)
    df = df[df["text"].astype(str).str.split().str.len().between(60, 500)]
    rng = random.Random(SEED)
    keep = []
    for m, g in df.groupby("model"):
        keep.append(g.sample(min(len(g), 900), random_state=SEED))
    df = pd.concat(keep, ignore_index=True)
    out = []
    for r in df.itertuples(index=False):
        t = norm_text(r.text)
        m = str(r.model)
        human = m.lower() in ("human", "human-written", "human_written") or int(r.label) == 0
        final_only = any(k in m.lower() for k in AIGT_FINAL_ONLY)
        out.append({"id": stable_id("aigtbench", sha256_text(t)), "text": t, "fine_label": "HUMAN" if human else "AI_GENERATED",
                    "label": 0 if human else 1, "cls": "HUMAN" if human else "AI_GENERATED", "dataset": "aigtbench",
                    "generator": "human" if human else m, "language": "en", "domain": f"social_media:{r.social_media_platform}",
                    "field": "social_media", "topic": str(r.social_media_platform), "venue": f"aigt:{r.social_media_platform}",
                    "group_id": f"aigt:{sha256_text(t)[:12]}", "parent_id": None, "source_id": None, "year": None, "n_words": len(t.split()),
                    "text_sha256": sha256_text(t), "section_type": "BODY", "ai_fraction": 0.0 if human else 1.0, "transformation_type": "none",
                    "role": "FINAL_ONLY" if (final_only and not human) else "ANY", "source_split": r.source_split})
    del rng
    return pd.DataFrame(out).drop_duplicates("id")


def main() -> int:
    for p in (RAW, NORM, MANI):
        p.mkdir(parents=True, exist_ok=True)
    man = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sources": {}}
    op = NORM / "openalex_academic.parquet"
    if not op.exists():
        rows = []
        for lang, n in OA_TARGET.items():
            rows += openalex(lang, n)
        df = pd.DataFrame(rows).drop_duplicates("text_sha256")
        df.to_parquet(op, index=False)
    df = pd.read_parquet(op)
    man["sources"]["openalex_academic"] = {"license": "CC0 (OpenAlex data); abstracts distributed by OpenAlex", "rows": int(len(df)),
                                           "by_language": df["language"].value_counts().to_dict(), "venues": int(df["venue"].nunique()),
                                           "years": "2012-2020"}
    ap = NORM / "aigtbench.parquet"
    if not ap.exists():
        aigtbench().to_parquet(ap, index=False)
    a = pd.read_parquet(ap)
    man["sources"]["aigtbench"] = {"license": "Apache-2.0", "revision": "6f1557d800b69df1a445ff5fff254971e8c45380", "rows": int(len(a)),
                                   "by_generator": a["generator"].value_counts().to_dict(), "final_only_rows": int((a["role"] == "FINAL_ONLY").sum())}
    write_json(MANI / "f006_3_sources.json", man)
    log(json.dumps(man["sources"], ensure_ascii=False)[:1500])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
