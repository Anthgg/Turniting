"""F006.3 Claude-family data via Claude Code subagents (no API key). Auxiliary: TRAIN / VAL / CAL only, never FINAL.

    python scripts/f0063_selfgen.py jobs --out <dir>       # job files for subagents
    python scripts/f0063_selfgen.py collect --out <dir>    # -> claude_multilingual.parquet (+ claude_structured_docs.parquet)

Two job kinds:
* PARA: one academic paragraph per block in ES / EN / PT / FR / DE (AI_GENERATED), varied section / length / style.
* DOC: one structured thesis / paper / report per block, returned as JSON {"sections": [{"type", "lang", "text"}]} with
  realistic language switches (title ES, resumen ES, abstract EN, keywords EN, body ES, quotation EN/FR/PT, references multi-lang).
  Every AI section becomes an AI_GENERATED paragraph row with parent_document_id / section_id / section_type / paragraph_language;
  TITLE / KEYWORDS / REFERENCES sections are kept as PRESENTATION_EXCLUDED rows (never trained as HUMAN or MACHINE).
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
from f0063_common import EXCLUDED_SECTIONS, LANG_NAME, LANG_WEIGHT, LANGS, SEED, norm_text, sha256_text, stable_id, topic_side  # noqa: E402

N_PARA, N_DOC, PARA_JOB, DOC_JOB = 1200, 150, 40, 15
FAMS = {"opus": 0.25, "sonnet": 0.45, "haiku": 0.30}
TOPICS = [("Medicine", "cardiovascular risk in primary care"), ("Medicine", "antimicrobial resistance"), ("Nursing", "patient safety culture"),
          ("Education", "formative assessment"), ("Education", "teacher digital competences"), ("Education", "university dropout"),
          ("Computer science", "machine learning for tabular data"), ("Computer science", "software quality metrics"),
          ("Computer science", "web application security"), ("Engineering", "structural health monitoring"), ("Engineering", "water distribution networks"),
          ("Engineering", "energy efficiency in buildings"), ("Economics", "informal employment"), ("Economics", "regional inequality"),
          ("Business", "supply chain resilience"), ("Business", "corporate social responsibility"), ("Sociology", "urban migration"),
          ("Political science", "citizen participation"), ("Psychology", "academic stress"), ("Psychology", "adolescent wellbeing"),
          ("Law", "data protection regulation"), ("Law", "administrative procedure"), ("Environmental science", "urban heat islands"),
          ("Environmental science", "soil erosion"), ("Agronomy", "precision irrigation"), ("Linguistics", "code-switching in classrooms"),
          ("History", "industrialisation in the 19th century"), ("Philosophy", "ethics of artificial intelligence"),
          ("Biology", "marine biodiversity"), ("Chemistry", "green solvents"), ("Physics", "photovoltaic materials"),
          ("Public health", "vaccination coverage"), ("Communication", "misinformation on social media"), ("Tourism", "sustainable tourism"),
          ("Architecture", "social housing design"), ("Statistics", "missing data imputation")]
SECTIONS = ["abstract / resumen", "introduction", "theoretical framework", "methodology", "results", "discussion", "conclusion", "executive summary"]
LENGTHS = ["120-220", "220-350", "350-480"]
DOC_PATTERNS = [
    ["TITLE:es", "RESUMEN:es", "ABSTRACT:en", "KEYWORDS:en", "INTRODUCTION:es", "QUOTATION:en", "RELATED_WORK:es", "REFERENCES:multi", "CONCLUSION:es"],
    ["TITLE:en", "ABSTRACT:en", "RESUMEN:es", "INTRODUCTION:en", "METHODS:en", "QUOTATION:fr", "DISCUSSION:en", "REFERENCES:multi"],
    ["TITLE:pt", "EXECUTIVE_SUMMARY:en", "INTRODUCTION:pt", "RESULTS:pt", "QUOTATION:es", "CONCLUSION:pt", "REFERENCES:multi"],
    ["TITLE:fr", "RESUMEN:fr", "ABSTRACT:en", "INTRODUCTION:fr", "THEORETICAL_FRAMEWORK:fr", "QUOTATION:de", "CONCLUSION:fr", "REFERENCES:multi"],
    ["TITLE:de", "ABSTRACT:en", "INTRODUCTION:de", "METHODS:de", "DISCUSSION:de", "QUOTATION:en", "REFERENCES:multi"],
    ["TITLE:es", "RESUMEN:es", "ABSTRACT:en", "KEYWORDS:es", "INTRODUCTION:es", "THEORETICAL_FRAMEWORK:es", "QUOTATION:pt", "DISCUSSION:es",
     "CONCLUSION:es", "REFERENCES:multi"],
]
BLOCK = re.compile(r"^### ([A-Za-z0-9_:-]+)\s*$", re.M)


def fam(rng):
    return rng.choices(list(FAMS), weights=list(FAMS.values()))[0]


def plan() -> list[dict]:
    rng = random.Random(f"{SEED}:claude")
    reqs = []
    tps = [t for t in TOPICS if topic_side(t[1]) != "FINAL"]
    for i in range(N_PARA):
        lang = rng.choices(LANGS, weights=[LANG_WEIGHT[k] for k in LANGS])[0]
        field, topic = rng.choice(tps)
        sec, ln = rng.choice(SECTIONS), rng.choice(LENGTHS)
        tone = rng.choice(["neutral expository", "argumentative", "critical", "cautious", "plain but rigorous"])
        person = rng.choice(["impersonal", "first person plural", "first person singular"])
        cites = rng.choice(["no citations", "one fictitious citation (Surname, year)", "two fictitious citations"])
        p = (f"Write an original {sec} paragraph of an academic work in {field} on \"{topic}\". Language: {LANG_NAME[lang]} only. "
             f"{ln} words. Tone: {tone}; person: {person}; {cites}. No title, no headings, no references list.")
        reqs.append({"custom_id": f"cpara-{i:05d}", "kind": "PARA", "family": fam(rng), "prompt": p, "lang": lang, "field": field, "topic": topic,
                     "section_type": sec.split()[0].upper(), "side": topic_side(topic), "parent_id": f"claude_para:{i:05d}"})
    for i in range(N_DOC):
        field, topic = rng.choice(tps)
        pat = rng.choice(DOC_PATTERNS)
        kind = rng.choice(["master's thesis", "doctoral thesis chapter", "journal article", "technical report", "undergraduate dissertation"])
        p = (f"Write a short but realistic {kind} in {field} on \"{topic}\" with exactly these sections in this order (TYPE:language): "
             f"{', '.join(pat)}. Body sections 80-200 words each; TITLE one line; KEYWORDS 4-6 terms; QUOTATION one or two sentences of a "
             f"fictitious quoted author in the indicated language; REFERENCES 3-6 fictitious bibliography entries in several languages "
             f"(Spanish, English, French, Portuguese or German titles). Return ONE JSON object on a single line: "
             f"{{\"sections\": [{{\"type\": \"...\", \"lang\": \"..\", \"text\": \"...\"}}, ...]}}")
        reqs.append({"custom_id": f"cdoc-{i:05d}", "kind": "DOC", "family": fam(rng), "prompt": p, "pattern": pat, "field": field, "topic": topic,
                     "side": topic_side(topic), "parent_id": f"claude_doc:{i:05d}", "doc_kind": kind})
    return reqs


def jobs(out: Path) -> int:
    (out / "jobs").mkdir(parents=True, exist_ok=True)
    by = {}
    for r in plan():
        by.setdefault((r["kind"], r["family"]), []).append(r)
    idx = []
    for (kind, f), rs in sorted(by.items()):
        n = PARA_JOB if kind == "PARA" else DOC_JOB
        for k in range(0, len(rs), n):
            name = f"f63_{kind.lower()}_{f}_{k // n:03d}"
            (out / "jobs" / f"{name}.txt").write_text("\n\n".join(f"### {r['custom_id']}\n{r['prompt']}" for r in rs[k:k + n]) + "\n", encoding="utf-8")
            idx.append({"job": name, "kind": kind, "family": f, "items": len(rs[k:k + n])})
    (out / "jobs.json").write_text(json.dumps(idx, indent=1), encoding="utf-8")
    print(json.dumps({"jobs": len(idx), "items": sum(x["items"] for x in idx)}))
    return 0


def row(r, fam_, text, lang, sec_type, section_id, cls="AI_GENERATED", excluded=False):
    t = norm_text(text)
    return {"custom_id": f"{r['custom_id']}#{section_id}", "id": stable_id("claude63", r["custom_id"], section_id, sha256_text(t)), "text": t,
            "cls": "PRESENTATION_EXCLUDED" if excluded else cls, "fine_label": None if excluded else "AI_GENERATED", "label": None if excluded else 1,
            "dataset": "claude_multilingual", "generator": f"claude-code-subagent/{fam_}", "provider": "anthropic",
            "model": f"claude-code-subagent/{fam_}", "model_version": None, "generation_date": time.strftime("%Y-%m-%d", time.gmtime()),
            "language": lang, "prompt_family": f"{r['kind']}|{sec_type}", "domain": "academic", "field": r["field"], "topic": r["topic"],
            "temperature": "model_default", "generation_type": "AI_GENERATED", "role": "TRAIN_VAL_CAL", "side": r["side"],
            "parent_id": r["parent_id"], "group_id": f"claude63:{r['topic']}", "section_type": sec_type, "section_id": section_id,
            "text_sha256": sha256_text(t), "transformation_type": "AI_GENERATED", "ai_fraction": 1.0, "n_words": len(t.split()),
            "span_labels": None}


def collect(out: Path) -> int:
    reqs = {r["custom_id"]: r for r in plan()}
    rows, bad = [], 0
    for f in sorted((out / "outputs").glob("*.txt")):
        fam_ = re.search(r"_(opus|sonnet|haiku)_", f.stem).group(1)
        parts = BLOCK.split(f.read_text(encoding="utf-8"))
        for cid, body in zip(parts[1::2], parts[2::2]):
            r = reqs.get(cid)
            if r is None:
                bad += 1
                continue
            if r["kind"] == "PARA":
                t = body.strip()
                if len(t.split()) < 60:
                    bad += 1
                    continue
                rows.append(row(r, fam_, t, r["lang"], r["section_type"], "p0"))
            else:
                m = re.search(r"\{.*\}", body, re.S)
                try:
                    secs = json.loads(m.group(0))["sections"]
                except Exception:  # noqa: BLE001
                    bad += 1
                    continue
                for j, s in enumerate(secs):
                    typ = str(s.get("type", "")).upper().strip()
                    txt = str(s.get("text", "")).strip()
                    if not txt:
                        continue
                    excl = typ in EXCLUDED_SECTIONS
                    if not excl and len(txt.split()) < 25:
                        continue
                    rows.append(row(r, fam_, txt, str(s.get("lang", "multi"))[:5], typ, f"s{j:02d}", excluded=excl))
    df = pd.DataFrame(rows).drop_duplicates("custom_id")
    df.to_parquet(out / "claude_multilingual.parquet", index=False)
    print(json.dumps({"rows": len(df), "by_cls": df["cls"].value_counts().to_dict(), "by_lang": df["language"].value_counts().to_dict(),
                      "by_side": df["side"].value_counts().to_dict(), "docs": int(df.loc[df["custom_id"].str.startswith("cdoc"), "parent_id"].nunique()),
                      "rejected_blocks": bad}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["jobs", "collect"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    return jobs(Path(a.out)) if a.cmd == "jobs" else collect(Path(a.out))


if __name__ == "__main__":
    raise SystemExit(main())
