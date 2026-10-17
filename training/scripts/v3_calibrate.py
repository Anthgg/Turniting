"""Package a V3 checkpoint: thresholds (+ optional calibration) chosen on VALIDATION V2 doc logits only.

    python scripts/v3_calibrate.py --exp-dir <drive>/v3/checkpoints/<exp> --out <drive>/v3/models/global \
        --name TURNITING_RESEARCH_V3_GLOBAL [--calibrate]
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.calibration import select_calibrator  # noqa: E402
from turniting_train.common import CONFIG_DIR, git_commit, load_yaml, utc_now, write_json  # noqa: E402
from turniting_train.metrics import brier, ece_score, select_thresholds  # noqa: E402
from turniting_train.transformer import sigmoid  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--calibrate", action="store_true")
    args = ap.parse_args()
    cfg = load_yaml(CONFIG_DIR / "v3.yaml")["train"]["calibration"]
    exp_dir, out = Path(args.exp_dir), Path(args.out)
    exp = json.loads((exp_dir / "experiment.json").read_text())
    val = pd.read_parquet(exp_dir / "validation_doc_logits.parquet")
    y, logits = val["label"].values, val["logit"].values
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(exp_dir / "best", out)
    p_raw = sigmoid(logits)
    ece_raw, rel_raw = ece_score(y, p_raw)
    probs, cal = p_raw, None
    if args.calibrate:
        calibrator, cv = select_calibrator(logits, y, cfg["methods"], seed=42)
        probs = calibrator.predict(logits)
        ece_cal, rel_cal = ece_score(y, probs)
        cal = {"selected": calibrator.to_dict(), "selection": "lowest 3-fold CV ECE on VALIDATION V2 (tie-break Brier)",
               "cv_report": cv, "validation": {"ece_before": ece_raw, "ece_after": ece_cal, "brier_before": brier(y, p_raw),
                                               "brier_after": brier(y, probs)},
               "reliability_before": rel_raw, "reliability_after": rel_cal,
               "fitted_on": "VALIDATION V2 document logits (no Turnitin reports, no VALIDATION_CASE_001)"}
        write_json(out / "calibration.json", cal)
    th = select_thresholds(y, probs, cfg["low_fpr_max"], cfg["high_precision_target"])
    write_json(out / "thresholds.json", {**th, "chosen_on": "VALIDATION_V2", "space": "calibrated" if args.calibrate else "raw"})
    write_json(out / "model_manifest.json", {
        "modelVersion": args.name, "displayName": "Turniting Research V3", "variant": args.name,
        "experimentId": exp["experimentId"], "mode": exp["mode"], "architecture": exp["model"] + " + V3 multi-task heads",
        "modelRevision": exp["modelRevision"], "datasetVersion": "TURNITING_DATASET_V2", "gitCommit": git_commit(),
        "createdAt": utc_now(), "outputs": ["P(MACHINE_SIGNAL)", "P(HUMAN/GENERATED/EDITED/MIXED)", "token AI probability"],
        "calibrated": bool(args.calibrate), "status": "RESEARCH_ONLY", "commercialEligibility": "RESEARCH_ONLY",
        "notTurnitin": "Independent research detector; not a Turnitin model and not equivalent to Turnitin scores.",
        "validation_reliability_raw": {"ece": ece_raw, "brier": brier(y, p_raw)},
    })
    print(f"packaged {args.name} -> {out} thresholds={ {k: v['threshold'] for k, v in th.items()} }")
    if cal:
        print("calibration:", cal["selected"]["method"], cal["validation"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
