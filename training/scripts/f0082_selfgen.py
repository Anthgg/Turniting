"""F008.2 Claude pairs WITHOUT an API key: f0082_claude.plan executed by Claude Code subagents (TRAINING DATA ONLY).

    python scripts/f0082_selfgen.py jobs --out <dir>       # job files: blocks "### <custom_id>\\n<prompt>"
    python scripts/f0082_selfgen.py collect --out <dir>    # outputs: blocks "### <custom_id>\\n<one JSON object>" -> claude_pairs.parquet
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import pandas as pd

os.environ.setdefault("F0082_SEEDS", "1000")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import f0082_claude as C  # noqa: E402
from f0082_common import SEED, norm_text, sha256_text  # noqa: E402

FAMS = {"opus": "opus", "sonnet": "sonnet", "haiku": "haiku"}
PER_JOB = 40
BLOCK = re.compile(r"^### ([A-Za-z0-9_-]+)\s*$", re.M)


def jobs(out: Path) -> int:
    (out / "jobs").mkdir(parents=True, exist_ok=True)
    reqs = C.plan(FAMS)
    by = {}
    for r in reqs:
        by.setdefault(r["family"], []).append(r)
    idx = []
    for fam, rs in sorted(by.items()):
        for k in range(0, len(rs), PER_JOB):
            name = f"pairs_{fam}_{k // PER_JOB:03d}"
            (out / "jobs" / f"{name}.txt").write_text("\n\n".join(f"### {r['custom_id']}\n{r['prompt']}" for r in rs[k:k + PER_JOB]) + "\n", encoding="utf-8")
            idx.append({"job": name, "family": fam, "items": len(rs[k:k + PER_JOB])})
    (out / "jobs_pairs.json").write_text(json.dumps(idx, indent=1), encoding="utf-8")
    print(json.dumps({"jobs": len(idx), "seeds": len(reqs)}, indent=1))
    return 0


def collect(out: Path) -> int:
    reqs = {r["custom_id"]: r for r in C.plan(FAMS)}
    rows, bad = [], 0
    for f in sorted((out / "outputs").glob("*.txt")):
        fam = re.search(r"_(opus|sonnet|haiku)_", f.stem).group(1)
        parts = BLOCK.split(f.read_text(encoding="utf-8"))
        for cid, body in zip(parts[1::2], parts[2::2]):
            q = reqs.get(cid)
            try:
                m = re.search(r"\{.*\}", body, re.S)
                obj = json.loads(m.group(0)) if m else None
            except Exception:  # noqa: BLE001
                obj = None
            if q is None or not isinstance(obj, dict):
                bad += 1
                continue
            seed = norm_text(obj.get("seed", ""))
            if len(seed.split()) < 20:
                bad += 1
                continue
            sid = f"claude_seed:{cid}"
            model = f"claude-code-subagent/{fam}"
            for fld in C.FIELDS:
                if fld == "seed":
                    continue
                t = norm_text(obj.get(fld, ""))
                if not C.valid(fld, seed, t):
                    continue
                rows.append({"seed_custom_id": cid, "pair_id": f"{cid}:{fld}", "text_a": seed, "text_b": t, "pair_class": fld,
                             "lang_b": "en" if fld == "TRANSLATED_PARAPHRASE" else "es", "dataset": "claude_pairs", "provider": "anthropic", "model": model,
                             "generation_date": time.strftime("%Y-%m-%d", time.gmtime(f.stat().st_mtime)), "prompt_family": f"seed_bundle|{q['topic']}|{q['register']}",
                             "temperature": "model_default", "max_tokens": None, "effort": "subagent_default", "domain": q["topic"], "style": q["register"],
                             "seed_id": f"{SEED}:{cid}", "sha256": sha256_text(seed + "␟" + t), "parent_source_id": sid, "lineage": sid,
                             "usage_in": 0, "usage_out": 0})
    df = pd.DataFrame(rows)
    df.to_parquet(out / "claude_pairs.parquet", index=False)
    print(json.dumps({"pairs": len(df), "seeds": int(df["seed_custom_id"].nunique()), "by_class": df["pair_class"].value_counts().to_dict(),
                      "by_model": df["model"].value_counts().to_dict(), "rejected_blocks": bad}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["jobs", "collect"])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    return jobs(Path(a.out)) if a.cmd == "jobs" else collect(Path(a.out))


if __name__ == "__main__":
    raise SystemExit(main())
