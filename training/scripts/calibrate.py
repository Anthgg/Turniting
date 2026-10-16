"""Package a trained transformer checkpoint: thresholds (+ optional calibration), all chosen
on VALIDATION document logits saved by train_transformer.py. TEST is not used.

    python scripts/calibrate.py --experiment checkpoints/<exp> --out models/transformer/global --name GLOBAL_MULTILINGUAL_TRANSFORMER
    python scripts/calibrate.py --experiment checkpoints/<exp> --out models/calibrated/spanish_academic --calibrate \
        --name CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER --link-weights
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.calibration import Calibrator, select_calibrator  # noqa: E402
from turniting_train.common import (  # noqa: E402
    CONFIG_DIR, DATASET_VERSION, MODEL_DISPLAY_NAME, MODEL_VERSION, TRAINING_DIR, git_commit, load_yaml, read_json,
    utc_now, write_json,
)
from turniting_train.metrics import brier, ece_score, select_thresholds  # noqa: E402
from turniting_train.transformer import sigmoid  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--experiment", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--link-weights", action="store_true",
                    help="reference the checkpoint weights instead of copying them (disk budget)")
    args = ap.parse_args()
    cfg = load_yaml(CONFIG_DIR / "training.yaml")
    exp_dir = Path(args.experiment)
    best = exp_dir / "best"
    out = Path(args.out)
    exp = read_json(exp_dir / "experiment.json")
    val = pd.read_parquet(exp_dir / "validation_doc_logits.parquet")
    y, logits = val["label"].values, val["logit"].values

    if out.exists():
        shutil.rmtree(out)
    if args.link_weights:
        out.mkdir(parents=True)
        for f in ("inference_config.json",):
            shutil.copy2(best / f, out / f)
        write_json(out / "base_model.json", {"path": str(best.resolve().relative_to(TRAINING_DIR.resolve()))})
    else:
        shutil.copytree(best, out, ignore=shutil.ignore_patterns("checkpoint_info.json"))

    p_raw = sigmoid(logits)
    ece_before, rel_before = ece_score(y, p_raw)
    cal_info = None
    probs = p_raw
    if args.calibrate:
        calibrator, cv_report = select_calibrator(logits, y, cfg["calibration"]["methods"], seed=cfg["seed"])
        probs = calibrator.predict(logits)
        ece_after, rel_after = ece_score(y, probs)
        cal_info = {
            "selected": calibrator.to_dict(),
            "selection": "lowest 3-fold cross-validated ECE on VALIDATION (tie-break Brier)",
            "cv_report": cv_report,
            "validation": {"ece_before": ece_before, "ece_after": ece_after, "brier_before": brier(y, p_raw),
                           "brier_after": brier(y, probs)},
            "reliability_before": rel_before,
            "reliability_after": rel_after,
            "fitted_on": "VALIDATION document logits (no Turnitin reports)",
        }
        write_json(out / "calibration.json", cal_info)
    thresholds = select_thresholds(y, probs, cfg["calibration"]["low_fpr_max"], cfg["calibration"]["high_precision_target"])
    write_json(out / "thresholds.json", {**thresholds, "chosen_on": "VALIDATION", "space": "calibrated" if args.calibrate else "raw"})
    write_json(out / "model_manifest.json", {
        "modelVersion": MODEL_VERSION,
        "displayName": MODEL_DISPLAY_NAME,
        "variant": args.name,
        "experimentId": exp["experimentId"],
        "architecture": exp["model"],
        "modelRevision": exp["modelRevision"],
        "datasetVersion": DATASET_VERSION,
        "gitCommit": git_commit(),
        "createdAt": utc_now(),
        "outputs": ["P(HUMAN)", "P(MACHINE)"],
        "labels": {"0": "HUMAN", "1": "MACHINE"},
        "defaultThreshold": "BALANCED",
        "calibrated": bool(args.calibrate),
        "notTurnitin": "Independent detector; not a Turnitin model and not equivalent to Turnitin scores.",
        "validation_reliability_raw": {"ece": ece_before, "brier": brier(y, p_raw)},
    })
    print(f"packaged {args.name} -> {out} thresholds={ {k: v['threshold'] for k, v in thresholds.items()} }")
    if cal_info:
        print("calibration:", cal_info["selected"]["method"], cal_info["validation"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
