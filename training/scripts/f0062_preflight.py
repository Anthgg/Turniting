"""F006.2 pre-training gate: prints the run banner and STOPS (exit 3) unless every leakage gate is exactly 0.

    python scripts/f0062_preflight.py --run F0062_B --windows 250000 --lr 5e-6 --base-model <init dir>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0062_common import CKPT, MANI, REPO, SPLITS, write_json  # noqa: E402


def gpu() -> dict:
    try:
        import torch

        if not torch.cuda.is_available():
            return {"GPU": "NONE", "VRAM": None, "CUDA": None, "PRECISION": "fp32"}
        p = torch.cuda.get_device_properties(0)
        return {"GPU": p.name, "VRAM": f"{p.total_memory / 2**30:.1f} GiB", "CUDA": torch.version.cuda,
                "PRECISION": "bf16" if torch.cuda.is_bf16_supported() else "fp16"}
    except Exception as e:  # noqa: BLE001
        return {"GPU": f"unknown ({type(e).__name__})", "VRAM": None, "CUDA": None, "PRECISION": None}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--windows", type=int, required=True)
    ap.add_argument("--lr", type=float, required=True)
    ap.add_argument("--base-model", required=True)
    ap.add_argument("--effective-batch", type=int, default=64)
    a = ap.parse_args()
    hman = json.loads((MANI / "f006_2_final_external_holdout.json").read_text())
    rows = {k: len(pd.read_parquet(SPLITS / f"f006_2_{f}.parquet", columns=["id"])) for k, f in
            (("VALIDATION_ROWS", "validation"), ("CALIBRATION_ROWS", "calibration"), ("OOD_ROWS", "ood"), ("FINAL_HOLDOUT_ROWS", "final_external_holdout"))}
    val = pd.read_parquet(SPLITS / "f006_2_validation.parquet", columns=["primary"])
    extra = json.loads((MANI / "f006_2_train_extra.json").read_text())
    probe = CKPT / "runs" / a.run / "auto_batch.json"
    ab = json.loads(probe.read_text()) if probe.exists() else {}
    g = hman["gates"]
    banner = {"PHASE": "F006_2", **gpu(), "BASE_MODEL": a.base_model, "TRAIN_ROWS": extra["rows"], **rows,
              "UNSEEN_GENERATOR_ROWS": int((val["primary"] == "unseen_generator").sum()),
              "BATCH_SIZE": ab.get("micro_batch", "auto (memory probe at start)"), "GRADIENT_ACCUMULATION": ab.get("accumulation", "auto"),
              "EFFECTIVE_BATCH_SIZE": ab.get("effective_batch", a.effective_batch), "MAX_SEQUENCE_LENGTH": 512, "LEARNING_RATE": a.lr,
              "ESTIMATED_STEPS": a.windows // a.effective_batch, "DRIVE_OUTPUT_PATH": str(CKPT / "runs" / a.run),
              "TRAIN_INTERSECT_VALIDATION": g["TRAIN_INTERSECT_VALIDATION"], "TRAIN_INTERSECT_CALIBRATION": g["TRAIN_INTERSECT_CALIBRATION"],
              "TRAIN_INTERSECT_FINAL_HOLDOUT": g["TRAIN_INTERSECT_FINAL_HOLDOUT"], "PARENT_OVERLAP": g["PARENT_OVERLAP"],
              "SOURCE_LEAKAGE": g["SOURCE_LEAKAGE"], "LINEAGE_LEAKAGE": g["LINEAGE_LEAKAGE"]}
    for k, v in banner.items():
        print(f"{k} = {v}")
    write_json(REPO / "reports" / "f006_2" / f"preflight_{a.run}.json", banner)
    if any(g[k] != 0 for k in g) or hman["leakage"]["result"] != "PASS":
        print("STOP_BEFORE_TRAINING")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
