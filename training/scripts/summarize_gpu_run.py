"""Build TRAINING_GPU_REPORT.{json,md}: GPU run vs CPU provisional run vs BEST_BASELINE.

Run on the GPU host after the notebook finished (reads reports/eval/*.json, checkpoints/*/,
models/gpu/*). Prints the compact JSON so it can be copied from the notebook output.

    python scripts/summarize_gpu_run.py --out-dir /content/drive/MyDrive/turniting/workdir/reports
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import CHECKPOINT_DIR, MODELS_DIR, REPORTS_DIR, read_json, utc_now  # noqa: E402

KEYS = ("n", "accuracy", "precision", "recall", "f1", "macro_f1", "roc_auc", "pr_auc", "fpr", "fnr", "mcc", "ece", "brier")
SETS = ("validation", "validation_spanish", "validation_academic", "test", "test_spanish", "test_academic", "ood",
        "adversarial", "unseen_generator", "unseen_domain")
MODELS = {
    "BEST_BASELINE": "BEST_BASELINE",
    "CPU_GLOBAL": "GLOBAL_MULTILINGUAL_TRANSFORMER",
    "CPU_SPANISH_ACADEMIC": "SPANISH_ACADEMIC_TRANSFORMER",
    "CPU_CALIBRATED": "CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER",
    "GPU_GLOBAL": "GLOBAL_MULTILINGUAL_TRANSFORMER_GPU",
    "GPU_SPANISH_ACADEMIC": "SPANISH_ACADEMIC_TRANSFORMER_GPU",
    "GPU_CALIBRATED": "CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER_GPU",
}


def r(v):
    return None if v is None else (round(v, 4) if isinstance(v, float) else v)


def compact(ev: dict) -> dict:
    out = {"threshold": r(ev.get("threshold")), "sets": {}}
    for s in SETS:
        m = ev["sets"].get(s)
        if m:
            out["sets"][s] = {k: r(m.get(k)) for k in KEYS}
    ug = ev["sets"].get("unseen_generator", {}).get("groups", {}).get("generator_family", {})
    out["unseen_generator_by_family"] = {k: {"n": v["n"], "recall": r(v.get("recall")), "f1": r(v.get("f1"))}
                                         for k, v in ug.items()}
    rob = ev.get("robustness") or {}
    out["robustness"] = {k: {"f1": r(v.get("f1")), "machine_recall": r(v.get("machine_recall")),
                             "f1_drop_vs_clean": r(v.get("f1_drop_vs_clean"))} for k, v in rob.items()}
    return out


def choose(rows: dict) -> str:
    """Same VALIDATION rule as select_model.py (+ baseline as candidate)."""
    prim = {k: (v["sets"]["validation_spanish"]["macro_f1"] + v["sets"]["validation_academic"]["macro_f1"]) / 2
            for k, v in rows.items()}
    fpr = {k: v["sets"]["validation"]["fpr"] for k, v in rows.items()}
    ece = {k: v["sets"]["validation"]["ece"] for k, v in rows.items()}
    eligible = [k for k in rows if fpr[k] <= min(fpr.values()) + 0.02] or list(rows)
    top = max(prim[k] for k in eligible)
    tied = [k for k in eligible if prim[k] >= top - 0.01]
    return min(tied, key=lambda k: (ece[k], fpr[k]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=str(REPORTS_DIR))
    args = ap.parse_args()
    evals, val = {}, {}
    for key, name in MODELS.items():
        final = read_json(REPORTS_DIR / "eval" / f"{name}.json")
        v = read_json(REPORTS_DIR / "eval" / f"{name}__validation.json")
        if final:
            evals[key] = compact(final)
        if v:
            val[key] = compact(v)
    experiments = {}
    for exp in sorted(CHECKPOINT_DIR.glob("*gpu*/experiment.json")):
        e = read_json(exp)
        experiments[e["experimentId"]] = {
            "mode": e["mode"], "model": e["model"], "device": e.get("device"),
            "gpu": (e.get("hardware") or {}).get("gpu"), "vram_gb": (e.get("hardware") or {}).get("vram_gb"),
            "cuda": (e.get("hardware") or {}).get("cuda"),
            "train_windows": e["trainingConfig"]["train_windows"], "epochs": e["trainingConfig"]["epochs"],
            "total_steps": e["trainingConfig"]["total_steps"], "steps_per_epoch": e["trainingConfig"]["steps_per_epoch"],
            "max_length": e["trainingConfig"]["max_length"], "stride": e["trainingConfig"]["stride"],
            "trainable_params": e["trainingConfig"]["freeze"]["trainable_params"],
            "batch": [e["trainingConfig"]["batch_size"], e["trainingConfig"]["gradient_accumulation"]],
            "learning_rate": e["trainingConfig"]["learning_rate"],
            "stopped_at_step": e["stoppedAtStep"], "early_stopped": e["earlyStopped"],
            "train_seconds": e["duration"]["train_seconds"],
            "history": [{k: r(h[k]) for k in ("step", "epoch", "train_loss", "val_loss", "val_macro_f1", "val_fpr",
                                             "gpu_mem_gb")} for h in e["metrics"]["history"]],
            "best_aggregation": e["metrics"]["best_aggregation"],
            "overfitting": {k: r(v) for k, v in e["overfitting"].items()},
            "checkpoint_bytes": e["checkpointBytes"],
            "sample_audit": read_json(exp.parent / "sample_audit.json"),
        }
    cal = read_json(MODELS_DIR / "gpu" / "calibrated_spanish_academic" / "calibration.json", {})
    thr = {k: read_json(MODELS_DIR / "gpu" / k / "thresholds.json", {})
           for k in ("global", "spanish_academic", "calibrated_spanish_academic")}
    candidates = {k: v for k, v in val.items() if k in ("BEST_BASELINE", "GPU_GLOBAL", "GPU_SPANISH_ACADEMIC", "GPU_CALIBRATED")}
    winner_val = choose(candidates) if len(candidates) > 1 else None
    report = {
        "generatedAt": utc_now(), "datasetVersion": "TURNITING_DATASET_V1", "experiments": experiments,
        "validation": val, "final": evals,
        "calibration": {"selected": (cal.get("selected") or {}).get("method"), "validation": cal.get("validation"),
                        "cv_report": cal.get("cv_report")},
        "thresholds": {k: {n: r(t.get(n, {}).get("threshold")) for n in ("BALANCED", "LOW_FALSE_POSITIVE", "HIGH_PRECISION_AI")}
                       for k, t in thr.items()},
        "winner_validation": winner_val,
        "selection_rule": "VALIDATION only: primary mean(Spanish, academic macro F1); FPR guard <= min+0.02; ties within 0.01 -> lower ECE, then FPR",
    }
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "TRAINING_GPU_REPORT.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print("GPU_SUMMARY_JSON_START")
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    print("GPU_SUMMARY_JSON_END")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
