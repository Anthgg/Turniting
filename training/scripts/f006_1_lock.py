"""F006.1: calibration (global vs Spanish) on F006_1 VALIDATION, references re-fitted the same way, F006_1_MODEL_LOCK.

    python scripts/f006_1_lock.py --run F0061_FULL --parent B1_v3
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_1_calib import study  # noqa: E402
from f006_lib import log, sha256_file, write_json  # noqa: E402
from f006_lock import model_hash  # noqa: E402

D6 = Path("/content/drive/MyDrive/turniting/f006")
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
REPO = Path(__file__).resolve().parents[1]


def slim(st: dict) -> dict:
    return {"chosen": st["chosen"], "eligible": st["eligible"], "config": st["options"][st["chosen"]]["final_fit"],
            "oof": {o: {k: {m: v.get(m) for m in ("n", "n_human", "fpr", "fpr_ci95", "recall", "macro_f1", "ece", "brier")}
                        for k, v in r["oof"].items()} for o, r in st["options"].items()}}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="F0061_FULL")
    ap.add_argument("--parent", required=True)
    a = ap.parse_args()
    lock_path = D61 / "manifests" / "F006_1_MODEL_LOCK.json"
    if lock_path.exists():
        lock = json.loads(lock_path.read_text())
        assert model_hash(Path(lock["modelPath"])) == lock["modelSha256"], "locked model changed"
        log("F006_1_MODEL_LOCK exists and verifies")
        return 0
    run_dir = D61 / "runs" / a.run
    run = json.loads((run_dir / "run.json").read_text())
    val = pd.read_parquet(D61 / "datasets" / "f006_1_validation.parquet")
    lg = pd.read_parquet(run_dir / "validation_doc_logits.parquet").set_index("id").loc[val["id"], "logit"].values
    st = study(val, lg)
    refs = {}
    for name in ("CANDIDATE_MODEL_V3", "EXPERIMENTAL_F006_MODEL"):
        rl = pd.read_parquet(D61 / "runs" / f"{name}_validation_logits.parquet").set_index("id").loc[val["id"], "logit"].values
        refs[name] = slim(study(val, rl))
    mine = slim(st)
    log(f"F006_1 calibration chosen {st['chosen']}; references " + json.dumps({k: v['chosen'] for k, v in refs.items()}))
    mdir = D61 / "models" / "f006_1_locked"
    if mdir.exists():
        shutil.rmtree(mdir)
    shutil.copytree(run_dir / "best", mdir)
    cfg = mine["config"]
    write_json(mdir / "calibration.json", {"selected": cfg["global"], "spanish": cfg.get("spanish"), "option": cfg["option"],
                                           "selection": "F006_1 validation, group 2-fold out-of-fold (f006_1_calib.py)"})
    write_json(mdir / "thresholds.json", {"BALANCED": {"threshold": cfg["threshold_global"]}, "GLOBAL_THRESHOLD": cfg["threshold_global"],
                                          "SPANISH_THRESHOLD": cfg["threshold_spanish"], "space": "calibrated", "chosen_on": "F006_1_VALIDATION",
                                          "language_profile": {"spanish": "language == 'es'", "fallback": "GLOBAL_THRESHOLD",
                                                               "requirement": "local reproducible language detection, versioned; dataset metadata in evaluation"}})
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    write_json(mdir / "model_manifest.json", {"modelVersion": "F006_1_SPANISH_GENERALIZATION", "parentModel": a.parent, "status": "LOCKED_PENDING_EVALUATION",
                                              "architecture": "microsoft/mdeberta-v3-base + V3 multi-task heads", "datasetVersion": "TURNITING_DATASET_V2 + F006_1 additions",
                                              "gitCommit": commit, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                              "notTurnitin": "Independent research detector; never a Turnitin score.", "commercialEligibility": "RESEARCH_ONLY"})
    icfg = json.loads((mdir / "inference_config.json").read_text())
    lock = {"name": "F006_1_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "modelPath": str(mdir), "modelSha256": model_hash(mdir), "checkpoint": str(run_dir / "best"), "checkpointStep": run["best"]["step"],
            "parent": a.parent, "initFrom": run["init"],
            "datasetManifestSha256": {"holdout": sha256_file(D61 / "manifests" / "f006_1_final_holdout.json"),
                                      "validation": sha256_file(D61 / "manifests" / "f006_1_validation.json"),
                                      "train_extra": sha256_file(D61 / "manifests" / "f006_1_train_extra.json")},
            "trainingConfig": run["config"], "sampling": run["sampleAudit"], "loss": {"type": run["config"]["loss"], "human_weight": run["config"]["human_weight"]},
            "calibration": {"option": cfg["option"], "global": cfg["global"]["method"], "spanish": (cfg.get("spanish") or {}).get("method")},
            "thresholdGlobal": cfg["threshold_global"], "thresholdSpanish": cfg["threshold_spanish"],
            "preprocessing": {"profile": "V3_CANONICALIZED_V1", "view": icfg.get("view"), "aggregation": icfg.get("aggregation"), "max_length": 512, "stride": 128},
            "seed": run["config"]["seed"], "trainingCodeCommit": run["gitCommit"], "lockCodeCommit": commit, "references": refs,
            "rule": "F006_1 final holdout, historical F006 Spanish holdout and V1 historical sets are read only after this lock, once."}
    write_json(lock_path, lock)
    write_json(REPO / "reports" / "f006_1" / "model_lock.json", lock)
    calrep = {"set": "F006_1_VALIDATION", "F006_1_MODEL": mine, **refs}
    write_json(D61 / "reports" / "calibration.json", calrep)
    write_json(REPO / "reports" / "f006_1" / "calibration.json", calrep)
    vrep = {"set": "F006_1_VALIDATION (out-of-fold metrics at each model's chosen calibration option)",
            "models": {k: v["oof"][v["chosen"]] | {"calibration_option": v["chosen"]} for k, v in calrep.items() if isinstance(v, dict) and "oof" in v},
            "training_history": run["history"]}
    write_json(D61 / "reports" / "validation.json", vrep)
    write_json(REPO / "reports" / "f006_1" / "validation.json", vrep)
    log(f"LOCKED {mdir.name} sha256 {lock['modelSha256'][:16]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
