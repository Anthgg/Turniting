"""Build datasets/manifests/model_registry.json (schemaVersion 1) from the existing training
reports, so the product can register trained models without hardcoding their metrics.

    python training/scripts/make_model_registry.py

Sources: reports/eval/BEST_BASELINE*.json, reports/baseline_metrics.json (CPU run) and
reports/TRAINING_GPU_REPORT.json (Colab A100 run). No weights are read.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
OUT = ROOT / "datasets" / "manifests" / "model_registry.json"
KEYS = ["n", "accuracy", "precision", "recall", "f1", "macro_f1", "roc_auc", "pr_auc", "fpr", "fnr", "mcc", "ece", "brier"]
SETS = {"test": "test", "test_spanish": "spanish_test", "test_academic": "academic_test", "ood": "ood",
        "adversarial": "adversarial", "unseen_generator": "unseen_generator", "unseen_domain": "unseen_domain"}
VAL_SETS = {"validation": "validation", "validation_spanish": "validation_spanish",
            "validation_academic": "validation_academic"}


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def pick(m: dict) -> dict:
    return {k: (round(m[k], 4) if isinstance(m.get(k), float) else m.get(k)) for k in KEYS}


def from_array(values: list) -> dict:
    return {k: v for k, v in zip(KEYS, values)}


def primary(val: dict) -> float:
    return round((val["validation_spanish"]["macro_f1"] + val["validation_academic"]["macro_f1"]) / 2, 4)


def baseline_entry() -> dict:
    final = load(REPORTS / "eval" / "BEST_BASELINE.json")
    val = load(REPORTS / "eval" / "BEST_BASELINE__validation.json")
    summary = load(REPORTS / "baseline_metrics.json")
    best = summary["best"]
    validation = {out: pick(val["sets"][s]) for s, out in VAL_SETS.items()}
    rob = final.get("robustness", {})
    return {
        "name": "BEST_BASELINE",
        "architecture": "stacked TF-IDF LR/SVM + stylometric GBM",
        "variant": best,
        "modelType": "BASELINE",
        "status": "EXPERIMENTAL",
        "trainingEnvironment": "local CPU (AMD Ryzen 7 5700U)",
        "commercialEligibility": "RESEARCH_ONLY",
        "artifact": {"provider": "LOCAL", "path": "training/models/baseline/best", "external": True,
                     "note": "joblib bundle kept on the training workstation; not versioned"},
        "metrics": {
            "selection_primary": primary(validation),
            "validation": validation,
            "final": {out: pick(final["sets"][s]) for s, out in SETS.items()},
            "robustness_f1": {k: v.get("f1") for k, v in rob.items()},
        },
        "thresholds": {k: v.get("threshold") for k, v in summary["summary"][best]["thresholds"].items()},
        "calibration": {"method": "sigmoid (SVM) / stacked LogReg probabilities", "fitted_on": "VALIDATION"},
        "limitations": [
            "OOD FPR high (0.284 at BALANCED)",
            "paraphrase attacks lower recall (F1 0.856)",
            "license restrictions: trained with non-commercial datasets",
        ],
        "metadata": {"reports": ["training/reports/baseline_metrics.json", "training/reports/eval/BEST_BASELINE.json"],
                     "robust_to_character_attacks": True},
    }


def candidate_entry() -> dict:
    gpu = load(REPORTS / "TRAINING_GPU_REPORT.json")
    key = "GPU_CALIBRATED"
    validation = {s: from_array(gpu["val"][key][s]) for s in VAL_SETS}
    final = {out: from_array(gpu["fin"][key][s]) for s, out in SETS.items()}
    exp_global = gpu["ex"]["20261017_0117_mdeberta_gpu_v1"]
    exp_refine = gpu["ex"]["20261017_0117_mdeberta_gpu_es_acad_v1"]
    return {
        "name": "CANDIDATE_MODEL_V2",
        "architecture": "microsoft/mdeberta-v3-base",
        "variant": "CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER_GPU",
        "modelType": "TRANSFORMER",
        "status": "CANDIDATE",
        "trainingEnvironment": f"Google Colab Pro, {exp_global['gpu']}, CUDA {exp_global['cuda']}, bf16",
        "commercialEligibility": "RESEARCH_ONLY",
        "gitCommit": "3415eb2",
        "artifact": {"provider": "GOOGLE_DRIVE", "path": "MyDrive/turniting/workdir/models/gpu/calibrated_spanish_academic",
                     "external": True, "sizeBytes": 1135930811,
                     "note": "logical path only; no credentials or signed URLs are stored"},
        "metrics": {
            "selection_primary": primary(validation),
            "validation": validation,
            "final": final,
            "robustness_f1": {k: v[0] for k, v in gpu["rob"][key].items()},
            "unseen_generator_families": gpu["fam"][key],
        },
        "thresholds": gpu["thr"]["calibrated_spanish_academic"],
        "calibration": {"method": gpu["cal"]["selected"], "fitted_on": "VALIDATION",
                        "cv_report": gpu["cal"]["cv_report"]},
        "limitations": [
            "zero-width-space attack: machine recall 0.066 (F1 0.12)",
            "homoglyph attack: machine recall 0.42 (F1 0.58)",
            "academic test macro F1 slightly below BEST_BASELINE (0.909 vs 0.916)",
            "OOD FPR high (0.261 at BALANCED)",
            "license restrictions: trained with non-commercial datasets (IberAuTexTification, AuTexTification)",
        ],
        "metadata": {
            "experiments": {"global": {k: exp_global[k] for k in ("train_windows", "epochs", "stopped_at_step", "train_seconds")},
                            "refine": {k: exp_refine[k] for k in ("train_windows", "epochs", "stopped_at_step", "train_seconds")}},
            "sample_audit": exp_global["sample_audit"],
            "outputs": ["P(HUMAN)", "P(MACHINE)"],
            "notTurnitin": "Independent detector; not a Turnitin model.",
            "reports": ["training/reports/TRAINING_GPU_REPORT.md", "training/reports/TRAINING_GPU_REPORT.json"],
        },
    }


def main() -> int:
    registry = {
        "modelRegistrySchemaVersion": 1,
        "datasetVersion": "TURNITING_DATASET_V1",
        "models": [baseline_entry(), candidate_entry()],
    }
    OUT.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
