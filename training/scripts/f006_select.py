"""F006: pick the best of a set of ablation runs on F006_SELECTION_SCORE (VALIDATION only) and print a field.

    python scripts/f006_select.py --runs A1_h40 A1_h50 A1_h60 --field human_share   -> prints the chosen value
    python scripts/f006_select.py --summary  -> writes <drive>/reports/ablation_results.json + repo copy
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import selection_score, write_json  # noqa: E402

DRIVE = Path("/content/drive/MyDrive/turniting/f006")


def load(run: str) -> dict:
    return json.loads((DRIVE / "runs" / run / "run.json").read_text())


def key(r: dict):
    s = selection_score(r["best"]["subsets"])  # recomputed with the current (documented) formula
    return (s["eligible"], s["score"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", nargs="*")
    ap.add_argument("--field")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--repo-reports", default=str(Path(__file__).resolve().parents[1] / "reports" / "f006"))
    a = ap.parse_args()
    if a.summary:
        rows = []
        for p in sorted((DRIVE / "runs").glob("*/run.json")):
            r = json.loads(p.read_text())
            b = r["best"]
            b["selection"] = selection_score(b["subsets"])
            rows.append({"run": r["run"], "stage": r["stage"], "config": r["config"], "best_step": b["step"],
                         "selection": b["selection"], "threshold_general_fpr_0.04": b["threshold_general_fpr_0.04"],
                         "subsets": {k: {m: v.get(m) for m in ("n", "n_human", "fpr", "recall", "macro_f1", "roc_auc")}
                                     for k, v in b["subsets"].items()},
                         "train_minutes": round(r["trainSeconds"] / 60, 1), "windows_per_sec": r["throughputWindowsPerSec"],
                         "sample_audit": {k: r["sampleAudit"].get(k) for k in ("training_windows", "human_share_windows",
                                                                                "hard_share_of_human_windows", "paragraph_share")}})
        v3 = DRIVE / "runs" / "V3_INIT_validation.json"
        v3d = json.loads(v3.read_text()) if v3.exists() else None
        if v3d:
            v3d["selection"] = selection_score(v3d["subsets"])
        out = {"selection_rule": "eligible (FPR all validation humans <= 0.05 at general-human FPR 0.04) first, then max F006_SELECTION_SCORE",
               "v3_init_on_f006_validation": v3d, "runs": rows}
        write_json(DRIVE / "reports" / "ablation_results.json", out)
        write_json(Path(a.repo_reports) / "ablation_results.json", out)
        for r in sorted(rows, key=lambda x: (x["selection"]["eligible"], x["selection"]["score"]), reverse=True):
            print(f"{r['run']:<28} score={r['selection']['score']:.4f} elig={r['selection']['eligible']} "
                  f"fpr_all={r['selection']['fprs']['fpr_all_humans']:.4f}")
        return 0
    runs = [r for r in a.runs if (DRIVE / "runs" / r / "run.json").exists()]
    if not runs:
        raise SystemExit("no finished runs among " + " ".join(a.runs))
    best = max((load(r) for r in runs), key=key)
    print(best["config"][a.field] if a.field else best["run"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
