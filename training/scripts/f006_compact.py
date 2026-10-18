"""F006: compact copies of the evaluation JSONs for Git (full versions stay on Drive under turniting/f006/reports).

Rounds floats to 4 decimals, drops confusion matrices, keeps every profile only for the 'all' subset
(BALANCED for every subset). Run after f006_report.py.
"""

from __future__ import annotations

import json
from pathlib import Path

R = Path(__file__).resolve().parents[1] / "reports" / "f006"
DROP = {"confusion"}


def rnd(o):
    if isinstance(o, float):
        return round(o, 4)
    if isinstance(o, dict):
        return {k: rnd(v) for k, v in o.items() if k not in DROP}
    if isinstance(o, list):
        return [rnd(v) for v in o]
    return o


def main() -> int:
    for name in ("f006_final_holdout.json",):
        d = json.loads((R / name).read_text())
        for m, profs in d["models"].items():
            for prof, v in profs.items():
                if prof != "BALANCED":
                    v["subsets"] = {"all": v["subsets"]["all"]}
        (R / name).write_text(json.dumps(rnd(d), indent=1))
    for name in ("historical_v1_benchmark.json", "robustness_eval.json", "external_holdout_2026.json", "mixed_ai_edited_eval.json",
                 "f006_validation.json", "ablation_results.json", "model_lock.json", "F006_FULL_run.json", "candidate_model_v4_registry.json"):
        p = R / name
        if p.exists():
            d = json.loads(p.read_text())
            if name == "ablation_results.json":
                for r in d["runs"]:
                    r["subsets"] = {k: v for k, v in r["subsets"].items()}
            if name == "f006_validation.json":
                for v in d.get("ensembles_with_v4", {}).values():
                    v["thresholds"] = {k: {"threshold": t["threshold"], "fpr": t["fpr"]} for k, t in v["thresholds"].items()}
            p.write_text(json.dumps(rnd(d), indent=1))
    print({p.name: p.stat().st_size for p in sorted(R.glob("*.json"))})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
