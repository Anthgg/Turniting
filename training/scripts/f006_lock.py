"""F006: calibration, thresholds, reference re-thresholding and ensembles on F006 VALIDATION, then F006_MODEL_LOCK.

    python scripts/f006_lock.py --run F006_FULL --v2 <CANDIDATE_MODEL_V2 dir> --v3 <CANDIDATE_MODEL_V3 dir> --out <drive>/f006

Only F006 VALIDATION is read. The lock is written once; afterwards nothing it names may change.
* V4: calibrator chosen by 3-fold CV ECE (tie-break Brier) on validation doc logits; F005-compatible
  threshold profiles BALANCED / LOW_FALSE_POSITIVE / VERY_LOW_FALSE_POSITIVE (f006_lib.profile_thresholds).
* references (same rule, same validation, so every model is compared at its own validation operating point):
  CANDIDATE_MODEL_V2, CANDIDATE_MODEL_V3, ENSEMBLE_V2_V3 (0.5/0.5 weighted probability, as in F005).
* ensembles with V4 (validation only, step 0.1): V2+V4, V3+V4, V2+V3+V4. An ensemble is preferred over
  V4_ONLY only if its BALANCED F006_SELECTION_SCORE is higher by > 0.01 (inference cost, section 46).
"""

from __future__ import annotations

import argparse
import itertools
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import log, profile_thresholds, selection_score, sha256_file, subset_report, write_json  # noqa: E402
from turniting_train.calibration import Calibrator, select_calibrator  # noqa: E402

METHODS = ["temperature", "platt", "isotonic"]
ENSEMBLE_MARGIN = 0.01


def calibrate(logits, y) -> tuple[Calibrator, dict]:
    cal, cv = select_calibrator(np.asarray(logits), np.asarray(y), METHODS, seed=42)
    return cal, cv


def model_hash(d: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    for f in sorted([d / "heads.pt", *sorted((d / "backbone").glob("*.safetensors"))]):
        h.update(sha256_file(f).encode())
    return h.hexdigest()


def v2_probs(path: Path, texts: list[str]) -> np.ndarray:
    from v3_evaluate import LegacyScorer

    sc = LegacyScorer(path)
    p, _ = sc.doc_probs(texts)
    del sc
    return np.asarray(p)


def bal_report(frame, p, th):
    rep = subset_report(frame, p, th["BALANCED"]["threshold"], ci=True)
    return {"thresholds": th, "balanced": rep, "selection_at_balanced": selection_score(rep)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="F006_FULL")
    ap.add_argument("--v2", required=True)
    ap.add_argument("--v3", required=True)
    ap.add_argument("--out", default="/content/drive/MyDrive/turniting/f006")
    ap.add_argument("--repo-reports", default=str(Path(__file__).resolve().parents[1] / "reports" / "f006"))
    a = ap.parse_args()
    out = Path(a.out)
    lock_path = out / "manifests" / "F006_MODEL_LOCK.json"
    if lock_path.exists():
        lock = json.loads(lock_path.read_text())
        if model_hash(Path(lock["modelPath"])) != lock["modelSha256"]:
            raise SystemExit("ABORT: locked model changed after F006_MODEL_LOCK")
        log("F006_MODEL_LOCK exists and verifies; nothing changed")
        return 0
    run_dir = out / "runs" / a.run
    run = json.loads((run_dir / "run.json").read_text())
    val = pd.read_parquet(out / "datasets" / "f006_validation.parquet")
    y = val["label"].values
    v4 = pd.read_parquet(run_dir / "validation_doc_logits.parquet").set_index("id").loc[val["id"]]
    v3 = pd.read_parquet(out / "runs" / "V3_INIT_validation.parquet").set_index("id").loc[val["id"]]

    # ---------------- V4
    cal4, cv4 = calibrate(v4["logit"].values, y)
    p4 = cal4.predict(v4["logit"].values)
    th4 = profile_thresholds(val, p4)
    log(f"V4 calibration {cal4.method}; thresholds { {k: round(v['threshold'], 4) for k, v in th4.items()} }")
    # ---------------- references re-thresholded on the same validation
    cal3, cv3 = calibrate(v3["logit"].values, y)
    p3 = cal3.predict(v3["logit"].values)
    th3 = profile_thresholds(val, p3)
    log("scoring CANDIDATE_MODEL_V2 on F006 validation")
    p2 = v2_probs(Path(a.v2), val["text_original"].tolist())
    th2 = profile_thresholds(val, p2)
    p23 = 0.5 * p2 + 0.5 * p3
    th23 = profile_thresholds(val, p23)
    pd.DataFrame({"id": val["id"].values, "p_v2": p2, "p_v3": p3, "p_v4": p4}).to_parquet(out / "runs" / "validation_reference_probs.parquet", index=False)

    # ---------------- ensembles with V4 (validation only)
    grid = np.round(np.arange(0.0, 1.0001, 0.1), 1)
    ens = {}
    for name, parts in (("V2+V4", (p2, p4)), ("V3+V4", (p3, p4))):
        best = None
        for w in grid[1:-1]:
            pe = w * parts[0] + (1 - w) * parts[1]
            th = profile_thresholds(val, pe)
            s = th["BALANCED"]["selection_score"]
            if best is None or s > best["score"]:
                best = {"weights": {name.split("+")[0]: float(w), "V4": float(1 - w)}, "score": s, "thresholds": th}
        ens[name] = best
    best = None
    for w2, w3 in itertools.product(grid, grid):
        w4 = round(1 - w2 - w3, 1)
        if w2 == 0 or w3 == 0 or w4 <= 0:
            continue
        pe = w2 * p2 + w3 * p3 + w4 * p4
        th = profile_thresholds(val, pe)
        s = th["BALANCED"]["selection_score"]
        if best is None or s > best["score"]:
            best = {"weights": {"V2": float(w2), "V3": float(w3), "V4": float(w4)}, "score": s, "thresholds": th}
    ens["V2+V3+V4"] = best
    v4_score = th4["BALANCED"]["selection_score"]
    top = max(ens, key=lambda k: ens[k]["score"])
    chosen = top if ens[top]["score"] > v4_score + ENSEMBLE_MARGIN else "V4_ONLY"
    log(f"ensembles: { {k: round(v['score'], 4) for k, v in ens.items()} } vs V4_ONLY {v4_score:.4f} -> {chosen}")

    # ---------------- package the locked model (F005-compatible layout)
    mdir = out / "models" / "f006_v4_locked"
    if mdir.exists():
        shutil.rmtree(mdir)
    shutil.copytree(run_dir / "best", mdir)
    write_json(mdir / "calibration.json", {"selected": cal4.to_dict(), "selection": "lowest 3-fold CV ECE on F006 VALIDATION (tie-break Brier)",
                                           "cv_report": cv4, "fitted_on": "F006 VALIDATION document logits"})
    write_json(mdir / "thresholds.json", {**th4, "chosen_on": "F006_VALIDATION", "space": "calibrated"})
    icfg = json.loads((mdir / "inference_config.json").read_text())
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    write_json(mdir / "model_manifest.json", {
        "modelVersion": "F006_TRANSFORMER_AI_DETECTOR", "displayName": "Turniting Research F006 (V4 candidate)",
        "architecture": "microsoft/mdeberta-v3-base + V3 multi-task heads", "parentModel": "CANDIDATE_MODEL_V3",
        "datasetVersion": "TURNITING_DATASET_V2", "status": "LOCKED_PENDING_EVALUATION", "gitCommit": commit,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "calibrated": True,
        "notTurnitin": "Independent research detector; not a Turnitin model and not equivalent to Turnitin scores.",
        "commercialEligibility": "RESEARCH_ONLY"})
    vman = out / "manifests" / "f006_validation_manifest.json"
    hman = out / "manifests" / "f006_final_holdout_manifest.json"
    lock = {
        "name": "F006_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "modelPath": str(mdir), "modelSha256": model_hash(mdir), "checkpoint": str(run_dir / "best"),
        "checkpointStep": run["best"]["step"], "initFrom": run["init"],
        "datasetManifests": {"validation_manifest_sha256": sha256_file(vman), "holdout_manifest_sha256": sha256_file(hman),
                             "holdout_file_sha256": json.loads(hman.read_text())["holdout_file_sha256"],
                             "master_v2_manifest_sha256": sha256_file(Path(a.v3).parents[1] / "manifests" / "master_v2_manifest.json")
                             if (Path(a.v3).parents[1] / "manifests" / "master_v2_manifest.json").exists() else None},
        "loss": {"type": run["config"]["loss"], "human_weight": run["config"]["human_weight"], "focal_gamma": run["config"]["focal_gamma"]},
        "sampling": {k: run["config"][k] for k in ("human_share", "hard_ratio", "es_w", "aca_w", "para_frac", "emphasis", "windows", "hard_pool")},
        "preprocessing": {"profile": "V3_CANONICALIZED_V1", "view": icfg.get("view"), "aggregation": icfg.get("aggregation"),
                          "max_length": 512, "stride": 128, "max_windows_per_doc": icfg.get("max_windows_per_doc", 8)},
        "calibration": cal4.to_dict() | {"params": "see calibration.json"}, "thresholds": {k: v["threshold"] for k, v in th4.items()},
        "selectedAnalyzer": chosen, "ensemble": ens[chosen] if chosen != "V4_ONLY" else None,
        "references": {
            "CANDIDATE_MODEL_V3": {"calibration": cal3.to_dict(), "thresholds": th3},
            "CANDIDATE_MODEL_V2": {"calibration": "model's own (V1 era)", "thresholds": th2},
            "ENSEMBLE_V2_V3": {"weights": {"V2": 0.5, "V3": 0.5}, "thresholds": th23},
        },
        "seed": run["config"]["seed"], "trainingCodeCommit": run["gitCommit"], "lockCodeCommit": commit,
        "rule": "F006 final holdout, V1 historical sets and external 2026 are read only after this lock, once.",
    }
    write_json(lock_path, lock)
    write_json(Path(a.repo_reports) / "model_lock.json", lock)
    valrep = {
        "set": "F006_VALIDATION", "note": "all selection / calibration / thresholds happen here; operating point = each model's own BALANCED",
        "models": {"F006_MODEL": bal_report(val, p4, th4), "CANDIDATE_MODEL_V3": bal_report(val, p3, th3),
                   "CANDIDATE_MODEL_V2": bal_report(val, p2, th2), "ENSEMBLE_V2_V3": bal_report(val, p23, th23)},
        "calibration": {"F006_MODEL": cv4, "CANDIDATE_MODEL_V3": cv3},
        "ensembles_with_v4": {k: {"weights": v["weights"], "balanced_selection_score": v["score"],
                                  "thresholds": v["thresholds"]} for k, v in ens.items()},
        "selected_analyzer": chosen, "v4_only_balanced_selection_score": v4_score,
    }
    if chosen != "V4_ONLY":
        w = ens[chosen]["weights"]
        pe = w.get("V2", 0) * p2 + w.get("V3", 0) * p3 + w["V4"] * p4
        valrep["models"]["F006_VALIDATION_ENSEMBLE"] = bal_report(val, pe, ens[chosen]["thresholds"])
    write_json(out / "reports" / "f006_validation.json", valrep)
    write_json(Path(a.repo_reports) / "f006_validation.json", valrep)
    log(f"LOCKED {mdir.name}: sha256 {lock['modelSha256'][:16]}..., analyzer {chosen}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
