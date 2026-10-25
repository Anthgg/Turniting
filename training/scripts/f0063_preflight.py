"""F006.3 pre-training gate: prints the banner and STOPS (exit 3) unless CROSS_SPLIT / PARENT / SOURCE / GROUP leakage are exactly 0.

    python scripts/f0063_preflight.py --run F0063_B2 --base-model <init dir>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0062_preflight import gpu  # noqa: E402
from f0063_common import CKPT, LANGS, MANI, MIXED, REPO, SPLITS, write_json  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--base-model", required=True)
    a = ap.parse_args()
    hman = json.loads((MANI / "f006_3_final_external_holdout.json").read_text())
    cols = ["id", "language", "label", "fine_label", "primary"]
    fr = {k: pd.read_parquet(SPLITS / f"f006_3_{f}.parquet", columns=cols) for k, f in
          (("VALIDATION", "validation"), ("CALIBRATION", "calibration"), ("FINAL", "final_external_holdout"))}
    tr = pd.read_parquet(SPLITS / "f006_3_train_extra.parquet", columns=["id", "language", "fine_label", "dataset"])
    tr["label"] = (tr["fine_label"] != "HUMAN").astype(int)
    allr = pd.concat([tr.assign(primary="train")[cols]] + list(fr.values()), ignore_index=True)
    mixed_rows = sum(len(pd.read_parquet(MIXED / f"mixed_documents_{s}.parquet", columns=["id"])) for s in ("val", "cal", "final"))
    v = fr["VALIDATION"]
    g = hman["gates"]
    banner = {"PHASE": "F006_3", **gpu(), "BASE_MODEL": a.base_model, "TOTAL_ROWS": int(len(allr)),
              **{f"{l.upper()}_ROWS": int((allr["language"] == l).sum()) for l in LANGS}, "MIXED_LANGUAGE_ROWS": int(mixed_rows),
              "HUMAN_ROWS": int((allr["label"] == 0).sum()), "AI_ROWS": int(((allr["label"] == 1) & (allr["fine_label"] != "MIXED")).sum()),
              "MIXED_ROWS": int((allr["fine_label"] == "MIXED").sum()), "TRAIN_ROWS": int(len(tr)),
              "TRAIN_NEW_ROWS": int(tr["dataset"].astype(str).str.startswith("f0063_").sum()),
              "VALIDATION_ROWS": int(len(v)), "CALIBRATION_ROWS": int(len(fr["CALIBRATION"])),
              "OOD_ROWS": int(v["primary"].isin(["ood", "unseen_generator"]).sum() + (~v["language"].isin(LANGS)).sum()),
              "FINAL_HOLDOUT_ROWS": int(len(fr["FINAL"])), "CROSS_SPLIT_LEAKAGE": g["CROSS_SPLIT_LEAKAGE"], "PARENT_LEAKAGE": g["PARENT_LEAKAGE"],
              "SOURCE_LEAKAGE": g["SOURCE_LEAKAGE"], "GROUP_LEAKAGE": g["GROUP_LEAKAGE"], "FINAL_CLAUDE_ROWS": hman["leakage"]["FINAL_claude_rows"],
              "DRIVE_OUTPUT": str(CKPT / "runs" / a.run)}
    for k, val in banner.items():
        print(f"{k} = {val}")
    write_json(REPO / "reports" / "f006_3" / f"preflight_{a.run}.json", banner)
    if any(g[k] != 0 for k in g) or hman["leakage"]["result"] != "PASS" or banner["FINAL_CLAUDE_ROWS"] != 0:
        print("STOP_BEFORE_TRAINING")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
