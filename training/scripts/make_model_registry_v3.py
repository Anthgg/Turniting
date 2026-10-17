"""Write training/datasets/manifests/model_registry_v3.json (CANDIDATE_MODEL_V3 metadata for F005).

    python training/scripts/make_model_registry_v3.py [--eval-json <Drive v3/reports/eval/v3_evaluation.json>]

With --eval-json the metrics are copied exactly from the official evaluation JSON produced by
training/scripts/v3_evaluate.py. Without it, the values of the versioned summary report
(training/reports/TRAINING_V3_REPORT.md, 3 decimals) are used and the source says so.
Never sets ACTIVE; commercial eligibility is RESEARCH_ONLY (non-commercial sources in V2).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[1]
OUT = TRAINING / "datasets" / "manifests" / "model_registry_v3.json"
SOURCE_COMMIT = "c09a0dbd47a5d3b648873e62b9c19272d477a0c5"
NAMES = {"CANDIDATE_MODEL_V3": "TURNITING_RESEARCH_V3_SPANISH_ACADEMIC", "CANDIDATE_MODEL_V2_REFERENCE": "CANDIDATE_MODEL_V2"}

# Summary values (TRAINING_V3_REPORT.md, "Results"): split -> metric -> value, never mixed across splits.
REPORT_V3 = {
    "validation_v2": {"primary": 0.932},
    "test_v2": {"macro_f1": 0.879, "roc_auc": 0.953, "fpr": 0.158},
    "test_v2_spanish": {"macro_f1": 0.893},
    "test_v2_academic": {"macro_f1": 0.935, "fpr": 0.069},
    "test_v2_mixed": {"recall": 0.853},
    "test_v2_ai_edited": {"macro_f1": 0.899},
    "test_v2_unseen_generator": {"macro_f1": 0.887},
    "test_v2_unseen_domain": {"macro_f1": 0.806},
    "test_v2_adversarial": {"recall": 0.921},
    "synthetic_zero_width": {"macro_f1": 0.887},
    "synthetic_homoglyph": {"macro_f1": 0.890},
    "dataset_holdout_aigtxt": {"macro_f1": 0.859},
    "external_holdout_2026": {"roc_auc": 0.990, "recall": 1.000, "fpr": 0.160},
    "v1_test": {"macro_f1": 0.844, "fpr": 0.275},
    "v1_test_spanish": {"macro_f1": 0.831, "fpr": 0.269},
    "v1_ood": {"macro_f1": 0.937},
    "v1_adversarial": {"macro_f1": 0.919},
    "span_detection": {"token_f1": 0.916},
}
REPORT_V2_REFERENCE = {"v1_test": {"macro_f1": 0.888, "fpr": 0.135}, "v1_test_spanish": {"macro_f1": 0.869, "fpr": 0.145},
                       "test_v2": {"macro_f1": 0.744, "roc_auc": 0.846, "fpr": 0.162}}
DATASET_V2 = {"rows": 4303857, "human": 1316737, "ai_generated_or_paraphrased": 2261144, "mixed": 221480,
              "ai_edited": 504496, "span_labelled": 227532, "spanish": 126379, "academic": 1701181,
              "generator_families": 39, "languages": 27, "exact_duplicates_removed": 840042,
              "near_duplicates_removed": 82946, "leakage": "0/0/0/0 PASS", "validation_docs": 20000}

KEEP = ("n", "accuracy", "precision", "recall", "f1", "macro_f1", "roc_auc", "pr_auc", "fpr", "fnr", "mcc", "ece", "brier")


def from_eval_json(path: Path) -> tuple[dict, dict, dict]:
    data = json.loads(path.read_text(encoding="utf-8"))["models"]
    m3, m2 = data["TURNITING_RESEARCH_V3_SPANISH_ACADEMIC"], data["CANDIDATE_MODEL_V2"]
    def pick(m):
        return {s: {k: v[k] for k in KEEP if k in v} for s, v in m["sets"].items()}
    metrics = pick(m3)
    metrics["span_detection"] = m3.get("span_detection")
    metrics["version_stability"] = m3.get("version_stability")
    return metrics, pick(m2), {k: v for k, v in m3.get("thresholds", {}).items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval-json", type=Path)
    args = ap.parse_args()
    if args.eval_json:
        metrics, v2ref, thresholds = from_eval_json(args.eval_json)
        source = f"official evaluation JSON ({args.eval_json.name}, V3 source commit {SOURCE_COMMIT[:7]})"
    else:
        metrics, v2ref = REPORT_V3, REPORT_V2_REFERENCE
        thresholds = {}
        source = "training/reports/TRAINING_V3_REPORT.md summary (3 decimals); full JSON in Drive v3/reports/eval"
    registry = {
        "modelRegistrySchemaVersion": 1,
        "datasetVersion": "TURNITING_DATASET_V2",
        "models": [{
            "name": "CANDIDATE_MODEL_V3",
            "architecture": "microsoft/mdeberta-v3-base",
            "variant": "TURNITING_RESEARCH_V3_SPANISH_ACADEMIC",
            "modelType": "TRANSFORMER",
            "status": "CANDIDATE",
            "trainingEnvironment": "Google Colab A100 40GB (bf16), global 1,000,000 windows + 200,000 refinement windows",
            "commercialEligibility": "RESEARCH_ONLY",
            "gitCommit": SOURCE_COMMIT,
            "artifact": {"provider": "GOOGLE_DRIVE", "path": "MyDrive/turniting/v3/models/spanish_academic", "external": True,
                         "note": "checkpoint MyDrive/turniting/v3/checkpoints/20261017_0604_v3_es_acad/best; weights not in Git"},
            "metrics": {"source": source, "byEvalSet": metrics, "candidateModelV2Reference": v2ref, "datasetV2": DATASET_V2},
            **({"thresholds": thresholds} if thresholds else {}),
            "limitations": [
                "Frozen V1 test FPR 0.275 at its BALANCED threshold vs 0.135 for CANDIDATE_MODEL_V2 (V1 Spanish 0.269 vs 0.145).",
                "Document-window scores move for unchanged neighbouring paragraphs; use paragraph-local scoring for versions.",
                "Trained with non-commercial / undeclared-licence sources: research use only.",
                "Independent research detector; not a Turnitin model or score.",
            ],
            "metadata": {"warnings": [
                {"code": "FROZEN_V1_FPR_REGRESSION", "severity": "HIGH", "v3_fpr": 0.275, "v2_fpr": 0.135,
                 "action": "use a validation-selected LOW_FALSE_POSITIVE profile or the V2/V3 ensemble"},
                {"code": "WINDOW_CONTEXT_DRIFT", "severity": "MEDIUM", "action": "paragraph-local scoring (F005)"},
            ], "datasetVersion": "TURNITING_DATASET_V2", "sourceBranch": "claude/project-thread-fm8si4"},
        }],
    }
    OUT.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({source})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
