"""Print the C4 (Track A) key values from the F006.1.1 reports (small JSON on stdout)."""

import json
import sys
from pathlib import Path

R = Path(__file__).resolve().parents[1] / "reports" / "f006_1_1"
M = Path(__file__).resolve().parents[1] / "datasets" / "manifests"


def j(p):
    return json.loads(p.read_text())


fin = j(R / "final_holdout.json")
rob = j(R / "robustness.json")
gates = j(R / "gates.json")
reg = j(R / "candidate_model_v4_registry.json")
lock = j(R / "model_lock.json")
hman = j(M / "f006_1_1_final_holdout.json")
vman = j(M / "f006_1_1_validation.json")
eman = j(M / "f006_1_1_train_extra.json")
dsm = j(M / "F006_1_1_DATASET_MANIFEST.json")
abl = j(R / "ablation_gate_check.json") if (R / "ablation_gate_check.json").exists() else {}
me = "F006_1_1_MODEL"
out = {"gates": gates, "registry": reg, "lock_keys": {k: lock.get(k) for k in ("parent", "run", "calibration", "thresholdGlobal", "thresholdSpanish", "modelPath", "trainWindows", "config")},
       "lock_all_keys": sorted(lock.keys()), "holdout": {k: hman.get(k) for k in ("docs", "humans", "spanish_docs", "spanish_humans", "span_docs", "mixed_docs", "leakage")},
       "validation": {k: vman.get(k) for k in ("docs", "humans", "spanish_humans")}, "train_extra": eman,
       "datasets": {k: {kk: v.get(kk) for kk in ("status", "license", "rows_after_dedup", "spanLabels")} for k, v in dsm["datasets"].items()},
       "models": {}, "robustness_models": {}, "span": rob.get("span"), "ablation_gate_check": abl}
for name, m in fin["models"].items():
    sub = m["subsets"]
    out["models"][name] = {k: {kk: (round(vv, 4) if isinstance(vv, float) else vv) for kk, vv in (sub.get(k) or {}).items() if kk in ("fpr", "recall", "macro_f1", "f1", "n", "precision")}
                           for k in ("all", "spanish", "academic", "unseen_generator", "mixed", "ai_edited", "ood", "unseen_domain", "general")}
    out["models"][name]["calibration_option"] = m.get("calibration_option")
for name, m in rob["models"].items():
    out["robustness_models"][name] = {k: {kk: (round(vv, 4) if isinstance(vv, float) else vv) for kk, vv in v.items() if kk in ("macro_f1", "fpr", "recall")} for k, v in m.items() if isinstance(v, dict)}
json.dump(out, sys.stdout, indent=1, default=str)
