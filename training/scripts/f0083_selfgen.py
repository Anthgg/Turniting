"""F008.3 multilingual Claude pairs via Claude Code subagents (TRAINING DATA ONLY; never final holdout).

    python scripts/f0083_selfgen.py jobs --out <dir>
    python scripts/f0083_selfgen.py collect --out <dir>      # -> claude_pairs_multilingual.parquet

One block = one seed passage (4-6 sentences) in a source language and every transformation of it, some in a second language.
All rows of a seed share parent_source_id = lineage = the seed (translation lineage included), so a seed never crosses splits.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import time
from pathlib import Path

import pandas as pd

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import SEED, norm_text, sha256_text  # noqa: E402

N = 400
PER_JOB = 20
FAMS = {"opus": 0.25, "sonnet": 0.45, "haiku": 0.30}
LANGS = {"es": 0.36, "en": 0.26, "pt": 0.12, "fr": 0.13, "de": 0.13}
NAMES = {"es": "Spanish", "en": "English", "pt": "Portuguese", "fr": "French", "de": "German"}
PAIR_LANG = {"es": ["en", "en", "pt", "fr", "de"], "en": ["es", "es", "pt", "fr", "de"], "pt": ["es", "en"], "fr": ["es", "en"], "de": ["es", "en"]}
TOPICS = ["public health", "higher education", "civil engineering", "regional economics", "renewable energy", "cybersecurity", "agriculture",
          "clinical psychology", "administrative law", "urban transport", "marine biology", "management", "linguistics", "contemporary history",
          "data science", "nutrition", "sustainable architecture", "tourism", "political communication", "environmental chemistry"]
SAME = {  # field: (target language: "src" | "tgt", meaning)
    "FAITHFUL_PARAPHRASE": ("src", "same meaning, moderate lexical changes"),
    "STRONG_PARAPHRASE": ("src", "same meaning, very different vocabulary and sentence structure"),
    "LONG_DISTANCE_PARAPHRASE": ("src", "same meaning but reorganised: reorder the arguments, merge and split sentences, move information; little shared wording"),
    "STRUCTURAL_REWRITE": ("src", "same meaning, passive / subordinate restructuring, different order of ideas"),
    "PARTIAL_PARAPHRASE": ("src", "keeps only part of the content (drops or adds one idea)"),
    "DIRECT_TRANSLATION": ("tgt", "faithful translation"),
    "TRANSLATED_PARAPHRASE": ("tgt", "translation that is also a free paraphrase (different structure)"),
    "TRANSLATED_PARTIAL_COPY": ("tgt", "translation of only some of the sentences"),
    "LEXICAL_HARD_NEGATIVE": ("src", "reuses almost all the words but says something different"),
    "NEGATION_HARD_NEGATIVE": ("src", "identical except that the main claim is negated / inverted"),
    "NUMBER_CHANGED_NEGATIVE": ("src", "identical except that numbers or their direction change"),
    "ENTITY_CHANGED_NEGATIVE": ("src", "identical except that the agent, entity or place changes"),
    "CAUSALITY_CHANGED_NEGATIVE": ("src", "same facts but the cause-effect relation is inverted or removed"),
    "TEMPORAL_CHANGED_NEGATIVE": ("src", "same facts but dates / temporal order change"),
    "CONTRADICTION": ("src", "a statement that contradicts the passage"),
    "SAME_TOPIC_NEGATIVE": ("src", "same topic, different claim, little shared vocabulary"),
    "CROSS_LANGUAGE_HARD_NEGATIVE": ("tgt", "a translation with one number or entity changed so the meaning differs"),
}
BLOCK = re.compile(r"^### ([A-Za-z0-9_-]+)\s*$", re.M)


def plan() -> list[dict]:
    rng = random.Random(f"{SEED}:f0083")
    out = []
    for i in range(N):
        src = rng.choices(list(LANGS), weights=list(LANGS.values()))[0]
        tgt = rng.choice(PAIR_LANG[src])
        topic = rng.choice(TOPICS)
        fam = rng.choices(list(FAMS), weights=list(FAMS.values()))[0]
        fields = "\n".join(f"- {k} ({NAMES[src] if v[0] == 'src' else NAMES[tgt]}): {v[1]}" for k, v in SAME.items())
        p = (f"Topic: {topic}. Write a JSON object with these string fields.\n- seed ({NAMES[src]}): an original academic passage of 4-6 sentences "
             f"(90-160 words) with at least two numbers, a fictitious entity, a date and a cause-effect relation.\n{fields}\n"
             f"Everything refers to the same seed; invent every entity, figure and author.")
        out.append({"custom_id": f"m83-{i:05d}", "family": fam, "prompt": p, "src": src, "tgt": tgt, "topic": topic})
    return out


def jobs(out: Path) -> int:
    (out / "jobs").mkdir(parents=True, exist_ok=True)
    by = {}
    for r in plan():
        by.setdefault(r["family"], []).append(r)
    idx = []
    for f, rs in sorted(by.items()):
        for k in range(0, len(rs), PER_JOB):
            name = f"f83_pairs_{f}_{k // PER_JOB:03d}"
            (out / "jobs" / f"{name}.txt").write_text("\n\n".join(f"### {r['custom_id']}\n{r['prompt']}" for r in rs[k:k + PER_JOB]) + "\n", encoding="utf-8")
            idx.append({"job": name, "family": f, "items": len(rs[k:k + PER_JOB])})
    (out / "jobs.json").write_text(json.dumps(idx, indent=1), encoding="utf-8")
    print(json.dumps({"jobs": len(idx), "seeds": N}))
    return 0


def collect(out: Path) -> int:
    reqs = {r["custom_id"]: r for r in plan()}
    rows, bad = [], 0
    for f in sorted((out / "outputs").glob("*.txt")):
        fam = re.search(r"_(opus|sonnet|haiku)_", f.stem).group(1)
        parts = BLOCK.split(f.read_text(encoding="utf-8"))
        for cid, body in zip(parts[1::2], parts[2::2]):
            q = reqs.get(cid)
            m = re.search(r"\{.*\}", body, re.S)
            try:
                obj = json.loads(m.group(0)) if m else None
            except Exception:  # noqa: BLE001
                obj = None
            if q is None or not isinstance(obj, dict) or len(norm_text(obj.get("seed", "")).split()) < 50:
                bad += 1
                continue
            seed = norm_text(obj["seed"])
            sid = f"claude83_seed:{cid}"
            for k, (side, _) in SAME.items():
                t = norm_text(obj.get(k, ""))
                if len(t.split()) < 8 or t == seed:
                    continue
                if k in ("NUMBER_CHANGED_NEGATIVE",) and re.findall(r"\d+", t) == re.findall(r"\d+", seed):
                    continue
                pos = k in ("FAITHFUL_PARAPHRASE", "STRONG_PARAPHRASE", "LONG_DISTANCE_PARAPHRASE", "STRUCTURAL_REWRITE", "DIRECT_TRANSLATION",
                            "TRANSLATED_PARAPHRASE")
                label = 1.0 if pos else 0.5 if k in ("PARTIAL_PARAPHRASE", "TRANSLATED_PARTIAL_COPY") else 0.0
                rows.append({"pair_id": f"{cid}:{k}", "text_a": seed, "text_b": t, "pair_class": k, "label": label, "lang_a": q["src"],
                             "lang_b": q["src"] if side == "src" else q["tgt"], "cross_language": side == "tgt", "dataset": "claude_pairs_multilingual",
                             "provider": "anthropic", "model": f"claude-code-subagent/{fam}", "generation_date": time.strftime("%Y-%m-%d", time.gmtime()),
                             "prompt_family": f"seed_bundle|{q['topic']}", "domain": q["topic"], "parent_source_id": sid, "lineage": sid,
                             "translation_lineage": sid, "sha256": sha256_text(seed + "␟" + t)})
    df = pd.DataFrame(rows)
    df.to_parquet(out / "claude_pairs_multilingual.parquet", index=False)
    print(json.dumps({"pairs": len(df), "seeds": int(df["parent_source_id"].nunique()) if len(df) else 0,
                      "by_class": df["pair_class"].value_counts().to_dict() if len(df) else {},
                      "cross_language": int(df["cross_language"].sum()) if len(df) else 0, "rejected": bad}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["jobs", "collect"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    return jobs(Path(a.out)) if a.cmd == "jobs" else collect(Path(a.out))


if __name__ == "__main__":
    raise SystemExit(main())
