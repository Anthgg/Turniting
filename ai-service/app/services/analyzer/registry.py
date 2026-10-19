"""Static registry of the analyzer models (metadata only, no weights).

Artifact locations come from server-side settings (AI_MODEL_V2_PATH, AI_MODEL_V3_PATH,
AI_BASELINE_MODEL_PATH); the logical Drive paths below are provenance, never read.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from app.core.config import Settings

V2, V3, BASELINE = "CANDIDATE_MODEL_V2", "CANDIDATE_MODEL_V3", "BEST_BASELINE"
F006 = "EXPERIMENTAL_F006_MODEL"
F006_1 = "EXPERIMENTAL_F006_1_MODEL"
F006_1_1 = "EXPERIMENTAL_F006_1_1_MODEL"


@dataclass(frozen=True)
class ModelSpec:
    name: str
    kind: str  # "v2_sequence_classifier" | "v3_multitask" | "baseline_joblib"
    architecture: str
    variant: str
    dataset: str
    status: str
    artifact_provider: str
    artifact_logical_path: str
    preprocessing: str
    required_files: tuple[str, ...]
    setting: str
    expected_model_sha256: str | None = None
    expected_parent_model: str | None = None
    expected_training_commit: str | None = None
    expected_global_threshold: float | None = None
    expected_spanish_threshold: float | None = None
    checkpoint_logical_path: str | None = None
    approx_memory_mb: int = 0
    warnings: tuple[str, ...] = field(default_factory=tuple)
    active: bool = False
    candidate: bool = False


MODELS: dict[str, ModelSpec] = {
    V2: ModelSpec(
        name=V2,
        kind="v2_sequence_classifier",
        architecture="microsoft/mdeberta-v3-base",
        variant="CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER_GPU",
        dataset="TURNITING_DATASET_V1",
        status="CANDIDATE",
        artifact_provider="GOOGLE_DRIVE",
        artifact_logical_path="MyDrive/turniting/workdir/models/gpu/calibrated_spanish_academic",
        preprocessing="V2_PREPROCESSING_V1",
        required_files=(
            "config.json",
            "model.safetensors",
            "inference_config.json",
            "thresholds.json",
            "model_manifest.json",
        ),
        setting="ai_model_v2_path",
        approx_memory_mb=1200,
        warnings=(
            "Reference model; weak on zero-width/homoglyph attacks and on mixed or AI-edited text.",
        ),
    ),
    V3: ModelSpec(
        name=V3,
        kind="v3_multitask",
        architecture="microsoft/mdeberta-v3-base",
        variant="TURNITING_RESEARCH_V3_SPANISH_ACADEMIC",
        dataset="TURNITING_DATASET_V2",
        status="CANDIDATE",
        artifact_provider="GOOGLE_DRIVE",
        artifact_logical_path="MyDrive/turniting/v3/models/spanish_academic",
        checkpoint_logical_path="MyDrive/turniting/v3/checkpoints/20261017_0604_v3_es_acad/best",
        preprocessing="V3_CANONICALIZED_V1",
        required_files=(
            "backbone/config.json",
            "backbone/model.safetensors",
            "heads.pt",
            "v3_config.json",
            "inference_config.json",
            "thresholds.json",
            "model_manifest.json",
        ),
        setting="ai_model_v3_path",
        approx_memory_mb=1250,
        warnings=(
            "Frozen V1 test FPR at its BALANCED threshold is 0.275 vs 0.135 for CANDIDATE_MODEL_V2: "
            "use a validation-selected low false-positive profile.",
            "Context windows span several paragraphs; use paragraph-local scoring for version comparison.",
        ),
    ),
    F006: ModelSpec(
        name=F006,
        kind="v3_multitask",
        architecture="microsoft/mdeberta-v3-base + V3 multi-task heads (binary / fine / token)",
        variant="F006_TRANSFORMER_EXPERIMENTAL",
        dataset="TURNITING_DATASET_V2",
        status="EXPERIMENTAL",
        artifact_provider="GOOGLE_DRIVE",
        artifact_logical_path="MyDrive/turniting/f006/models/experimental_v4",
        checkpoint_logical_path="MyDrive/turniting/f006/runs/F006_FULL/best",
        preprocessing="V3_CANONICALIZED_V1",
        required_files=(
            "backbone/config.json",
            "backbone/model.safetensors",
            "heads.pt",
            "v3_config.json",
            "inference_config.json",
            "thresholds.json",
            "calibration.json",
            "model_manifest.json",
        ),
        setting="ai_model_f006_path",
        approx_memory_mb=1300,
        warnings=(
            "SPANISH_FPR_REGRESSION",
            "SPANISH_VALIDATION_SHIFT",
            "Spanish human false-positive rate is elevated.",
        ),
    ),
    F006_1: ModelSpec(
        name=F006_1,
        kind="v3_multitask",
        architecture="microsoft/mdeberta-v3-base + V3 multi-task heads",
        variant="F006_1_SPANISH_GENERALIZATION_EXPERIMENTAL",
        dataset="F006_1",
        status="EXPERIMENTAL",
        artifact_provider="GOOGLE_DRIVE",
        artifact_logical_path="MyDrive/turniting/f006_1/models/experimental_f006_1",
        checkpoint_logical_path="MyDrive/turniting/f006_1/runs/F0061_FULL/best",
        preprocessing="V3_CANONICALIZED_V1",
        required_files=(
            "backbone/config.json",
            "backbone/model.safetensors",
            "heads.pt",
            "v3_config.json",
            "inference_config.json",
            "thresholds.json",
            "calibration.json",
            "model_manifest.json",
        ),
        setting="ai_model_f006_1_path",
        expected_model_sha256="c451a0062321189f026a1cc3779f50aa1b398a580d4cedfb9365a9486c835a90",
        warnings=(
            "F006_1_GATES_FAILED: A_overall_human_fpr_le_0.05, D_unseen_generator_fpr_le_0.10, "
            "E_mixed_recall_ge_0.64, H_span_f1_ge_0.86",
            "Paragraph stability was not evaluated.",
        ),
        active=False,
        candidate=False,
    ),
    F006_1_1: ModelSpec(
        name=F006_1_1,
        kind="v3_multitask",
        architecture="microsoft/mdeberta-v3-base + F006.1.1 detector-hardening heads",
        variant="F006_1_1_C8_TOK06_ES_PLATT_EXPERIMENTAL",
        dataset="F006_1_1",
        status="EXPERIMENTAL",
        artifact_provider="GOOGLE_DRIVE",
        artifact_logical_path="MyDrive/turniting/f006_1_1/models/experimental_f006_1_1",
        checkpoint_logical_path="MyDrive/turniting/f006_1_1/runs/F00611_FULL/best",
        preprocessing="V3_CANONICALIZED_V1",
        required_files=(
            "backbone/config.json",
            "backbone/model.safetensors",
            "heads.pt",
            "v3_config.json",
            "inference_config.json",
            "thresholds.json",
            "calibration.json",
            "model_manifest.json",
        ),
        setting="ai_model_f006_1_1_path",
        expected_parent_model="C3_f006",
        expected_training_commit="632dc6f7a852ee9c1dfc511a35a76cd1ce63428e",
        expected_global_threshold=0.767241379310345,
        expected_spanish_threshold=0.767241379310345,
        approx_memory_mb=1400,
        warnings=(
            "F006_1_1_GATES_FAILED: A_overall_human_fpr_le_0.05, H_mixed_recall_ge_0.65, "
            "I_span_token_f1_ge_0.86",
            "Paragraph stability was not evaluated.",
            "No expected SHA-256 for the F006.1.1 weight files is locked in the available report.",
            "Experimental research model; it is neither active nor a candidate.",
        ),
        active=False,
        candidate=False,
    ),
    BASELINE: ModelSpec(
        name=BASELINE,
        kind="baseline_joblib",
        architecture="stacked TF-IDF LR/SVM + stylometric GBM",
        variant="ENSEMBLE_TFIDF_STYLOMETRIC",
        dataset="TURNITING_DATASET_V1",
        status="EXPERIMENTAL",
        artifact_provider="LOCAL",
        artifact_logical_path="training/models/baseline/best",
        preprocessing="V2_PREPROCESSING_V1",
        required_files=("model.joblib",),
        setting="ai_baseline_model_path",
        approx_memory_mb=300,
        warnings=("Registered for reference only; not served by the analyzer API.",),
    ),
}


def artifact_path(spec: ModelSpec, settings: Settings) -> Path | None:
    value = getattr(settings, spec.setting, None)
    return Path(value) if value else None
