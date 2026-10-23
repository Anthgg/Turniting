"""F006.2 Claude data WITHOUT an API key: the same request plan as f0062_claude.py, executed by Claude Code subagents.

    python scripts/f0062_selfgen.py jobs  --phase 1 --out <dir>     # writes job files (prompts) for subagents
    python scripts/f0062_selfgen.py jobs  --phase 2 --out <dir>     # AI_REVISED jobs (needs the phase-1 collect)
    python scripts/f0062_selfgen.py collect --out <dir>             # parses subagent outputs -> claude_es_academic.parquet

Job file  <dir>/jobs/<job>.txt     blocks  "### <custom_id>\\n<prompt>"
Output    <dir>/outputs/<job>.txt  blocks  "### <custom_id>\\n<generated text>"   (written by the subagent)
The family (opus / sonnet / haiku) of each job is the subagent model; every row records provider=anthropic,
model=claude-code-subagent/<family>. Rows keep the plan's side (TRAIN / VAL / CAL; never FINAL) and parent / group ids.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import f0062_claude as C  # noqa: E402
from f0062_common import NORM, SEED, sha256_text, stable_id  # noqa: E402

C.COUNTS.update({"AI_GENERATED": 2400, "HUMAN_REVISED_BY_AI": 500, "HUMAN_WITH_AI_INSERTS": 500, "AI_WITH_HUMAN_INSERTS": 500, "AI_REVISED": 500})
JOB = {"AI_GENERATED": 40, "HUMAN_REVISED_BY_AI": 50, "HUMAN_WITH_AI_INSERTS": 100, "AI_WITH_HUMAN_INSERTS": 50, "AI_REVISED": 50}
FAMS = {"opus": "opus", "sonnet": "sonnet", "haiku": "haiku"}
BLOCK = re.compile(r"^### ([A-Za-z0-9_-]+)\s*$", re.M)


def all_requests(out: Path) -> dict:
    tdx = pd.read_parquet(NORM / "tdx_thesis_es.parquet")
    reqs = {r["custom_id"]: r for r in C.plan(FAMS, tdx)}
    p1 = out / "collected_phase1.parquet"
    if p1.exists():
        reqs.update({r["custom_id"]: r for r in C.phase2(pd.read_parquet(p1), FAMS)})
    return reqs


def jobs(phase: int, out: Path) -> int:
    (out / "jobs").mkdir(parents=True, exist_ok=True)
    reqs = [r for r in all_requests(out).values() if r["phase"] == phase]
    by = {}
    for r in reqs:
        by.setdefault((r["cls"], r["family"]), []).append(r)
    index = []
    for (cls, fam), rs in sorted(by.items()):
        n = JOB[cls]
        for k in range(0, len(rs), n):
            name = f"p{phase}_{cls.lower()}_{fam}_{k // n:03d}"
            body = "\n\n".join(f"### {r['custom_id']}\n{r['prompt']}" for r in rs[k:k + n])
            (out / "jobs" / f"{name}.txt").write_text(body + "\n", encoding="utf-8")
            index.append({"job": name, "cls": cls, "family": fam, "items": len(rs[k:k + n])})
    (out / f"jobs_phase{phase}.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(json.dumps({"jobs": len(index), "items": sum(x["items"] for x in index),
                      "by_family": pd.DataFrame(index).groupby("family")["items"].sum().to_dict()}, indent=1))
    return 0


def collect(out: Path) -> int:
    reqs = all_requests(out)
    rows, bad, missing = [], 0, 0
    fam_of = {}
    for f in sorted((out / "outputs").glob("*.txt")):
        fam = re.search(r"_(opus|sonnet|haiku)_", f.stem).group(1)
        txt = f.read_text(encoding="utf-8")
        parts = BLOCK.split(txt)
        for cid, body in zip(parts[1::2], parts[2::2]):
            r = reqs.get(cid)
            if r is None:
                bad += 1
                continue
            a = C.assemble(r, body.strip())
            if a is None:
                bad += 1
                continue
            fam_of[cid] = fam
            model = f"claude-code-subagent/{fam}"
            rows.append({"custom_id": cid, "id": stable_id("claude_es", cid, sha256_text(a["text"])), "cls": r["cls"], "fine_label": C.FINE[r["cls"]], "label": 1,
                         "dataset": "claude_es_academic", "generator": model, "provider": "anthropic", "model": model,
                         "generation_date": time.strftime("%Y-%m-%d", time.gmtime(f.stat().st_mtime)), "prompt_family": f"{r['cls']}|{r['meta'].get('domain')}",
                         "temperature": "model_default", "max_tokens": None, "effort": "subagent_default", "domain": "academic",
                         "style": json.dumps(r["meta"].get("style"), ensure_ascii=False), "seed_id": f"{SEED}:{cid}", "text_sha256": sha256_text(a["text"]),
                         "parent_id": r["parent_id"], "parent_source_id": r["parent_id"], "group_id": r["group_id"], "topic_id": r["topic_id"], "side": r["side"],
                         "language": "es", "transformation_type": r["cls"], "meta": json.dumps(r["meta"], ensure_ascii=False), "usage_in": 0, "usage_out": 0, **a})
    df = pd.DataFrame(rows).drop_duplicates("custom_id")
    planned = {k for k in reqs}
    missing = len(planned - set(df["custom_id"]))
    df[df["cls"] == "AI_GENERATED"].to_parquet(out / "collected_phase1.parquet", index=False)
    df.to_parquet(out / "claude_es_academic.parquet", index=False)
    print(json.dumps({"rows": len(df), "by_class": df["cls"].value_counts().to_dict(), "by_model": df["model"].value_counts().to_dict(),
                      "by_side": df["side"].value_counts().to_dict(), "rejected": bad, "planned_not_generated": missing}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["jobs", "collect"])
    ap.add_argument("--phase", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    return jobs(a.phase, out) if a.cmd == "jobs" else collect(out)


if __name__ == "__main__":
    raise SystemExit(main())
