"""Pick the recommended model on VALIDATION only and materialise models/transformer/best.

Objective (documented, not tuned on TEST):
  primary   = mean(validation Spanish macro F1, validation academic macro F1)
  guard     = validation FPR must be <= min FPR among candidates + 0.02
  tie-break = primary within 0.01 counts as a tie -> lower validation ECE (calibration), then lower FPR
OOD / adversarial / unseen sets are TEST-side: they are reported, never used to choose.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import MODELS_DIR, REPORTS_DIR, TRAINING_DIR, read_json, utc_now, write_json  # noqa: E402

CANDIDATES = {
    "BEST_BASELINE": "models/baseline/best",
    "GLOBAL_MULTILINGUAL_TRANSFORMER": "models/transformer/global",
    "SPANISH_ACADEMIC_TRANSFORMER": "models/transformer/spanish_academic",
    "CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER": "models/calibrated/spanish_academic",
}


def main() -> int:
    rows = {}
    for name in CANDIDATES:
        ev = read_json(REPORTS_DIR / "eval" / f"{name}__validation.json")
        if not ev:
            continue
        s = ev["sets"]
        rows[name] = {
            "val_macro_f1": s["validation"]["macro_f1"],
            "val_fpr": s["validation"]["fpr"],
            "val_ece": s["validation"]["ece"],
            "val_spanish_macro_f1": s["validation_spanish"]["macro_f1"],
            "val_academic_macro_f1": s["validation_academic"]["macro_f1"],
        }
        rows[name]["primary"] = (rows[name]["val_spanish_macro_f1"] + rows[name]["val_academic_macro_f1"]) / 2
    min_fpr = min(r["val_fpr"] for r in rows.values())
    eligible = {k: v for k, v in rows.items() if v["val_fpr"] <= min_fpr + 0.02} or rows
    def choose(pool):
        top = max(v["primary"] for v in pool.values())
        tied = {k: v for k, v in pool.items() if v["primary"] >= top - 0.01}
        return min(tied, key=lambda k: (tied[k]["val_ece"], tied[k]["val_fpr"]))

    best = choose(eligible)
    transformers = {k: v for k, v in rows.items() if k != "BEST_BASELINE"}
    best_tf = best if best in transformers else choose(transformers)

    # models/transformer/best = winning transformer variant, self-contained (weights copied)
    src = TRAINING_DIR / CANDIDATES[best_tf]
    dst = MODELS_DIR / "transformer" / "best"
    if dst.exists():
        shutil.rmtree(dst)
    link = read_json(src / "base_model.json", None)
    weights = TRAINING_DIR / link["path"] if link else src
    shutil.copytree(weights, dst, ignore=shutil.ignore_patterns("checkpoint_info.json"))
    for f in ("thresholds.json", "calibration.json", "inference_config.json", "model_manifest.json"):
        if (src / f).exists():
            shutil.copy2(src / f, dst / f)
    manifest = read_json(dst / "model_manifest.json", {})
    manifest.update({"selectedAs": best_tf, "selectedAt": utc_now(), "selectionRule": __doc__.strip()})
    write_json(dst / "model_manifest.json", manifest)
    write_json(REPORTS_DIR / "model_selection.json", {"candidates": rows, "recommended": best,
                                                     "best_transformer": best_tf, "rule": __doc__.strip()})
    print(f"recommended={best} best_transformer={best_tf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
