"""Single evaluation of the validation-selected profiles on the frozen TEST sets.

    python ai-service/scripts/f005_evaluate.py

Uses the profiles written by f005_calibrate.py (never re-tuned here) and the test rows of
data/eval/*_scores.parquet. Refuses to run twice unless --force-reevaluate is given, so test
results cannot quietly feed back into tuning. Writes training/reports/local_analyzer/ensemble_test.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f005_common import (  # noqa: E402
    EVAL_DIR,
    PROFILE_DIR,
    REPORT_DIR,
    binary_metrics,
    log,
    write_json,
)

from app.services.analyzer.calibration import Calibrator  # noqa: E402
from app.services.analyzer.ensemble import combine  # noqa: E402

PROFILES = ("BALANCED", "LOW_FALSE_POSITIVE", "VERY_LOW_FALSE_POSITIVE")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force-reevaluate", action="store_true")
    args = ap.parse_args()
    out_path = REPORT_DIR / "ensemble_test.json"
    if out_path.exists() and not args.force_reevaluate:
        log(f"{out_path} exists: tests were already evaluated once (use --force-reevaluate only for a documented rerun)")
        return 3
    prof = {m: json.loads((PROFILE_DIR / f"{m}.json").read_text(encoding="utf-8"))
            for m in ("CANDIDATE_MODEL_V2", "CANDIDATE_MODEL_V3", "ENSEMBLE_V2_V3")}
    s2 = pd.read_parquet(EVAL_DIR / "CANDIDATE_MODEL_V2_scores.parquet")
    s3 = pd.read_parquet(EVAL_DIR / "CANDIDATE_MODEL_V3_scores.parquet")
    key = ["id", "source"]
    df = s2.merge(s3[key + ["logit"]], on=key, suffixes=("_v2", "_v3"))
    test = df[df["role"] == "test"].copy()
    test["p2"] = Calibrator.from_dict(prof["CANDIDATE_MODEL_V2"]["calibration"]).predict(test["logit_v2"])
    test["p3"] = Calibrator.from_dict(prof["CANDIDATE_MODEL_V3"]["calibration"]).predict(test["logit_v3"])
    e = prof["ENSEMBLE_V2_V3"]
    test["pe"] = combine(e["method"], test["p2"], test["p3"], float(e["w2"]))
    results = {}
    for source, g in test.groupby("source"):
        y = g["label"].to_numpy().astype(int)
        res = {}
        for name, col, p in (("V2_ONLY", "p2", prof["CANDIDATE_MODEL_V2"]), ("V3_ONLY", "p3", prof["CANDIDATE_MODEL_V3"]),
                             ("ENSEMBLE", "pe", e)):
            res[name] = {pn: binary_metrics(y, g[col].to_numpy(), float(p["thresholds"][pn])) for pn in PROFILES}
        results[source] = res
    write_json(out_path, {
        "evaluatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "single evaluation; thresholds/calibration/ensemble fixed on validation before this run",
        "profiles": {k: {"calibration": v.get("calibration", {}).get("method") if isinstance(v.get("calibration"), dict) else None,
                         "thresholds": v["thresholds"], "method": v.get("method"), "w2": v.get("w2")} for k, v in prof.items()},
        "documents": {s: int(len(g)) for s, g in test.groupby("source")},
        "results": results,
    })
    log(f"wrote {out_path} for {len(results)} test sets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
