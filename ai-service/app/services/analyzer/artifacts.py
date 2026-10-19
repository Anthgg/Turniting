"""Artifact discovery and manifest validation (never modifies or downloads weights)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from app.services.analyzer.registry import ModelSpec

TOKENIZER_FILES = ("spm.model", "tokenizer.json", "tokenizer_config.json")


@dataclass
class ArtifactCheck:
    present: bool
    valid: bool
    missing: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    manifest: dict = field(default_factory=dict)
    inference_config: dict = field(default_factory=dict)
    thresholds: dict = field(default_factory=dict)
    calibration: dict | None = None


def _read_json(path: Path) -> dict:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} is not a JSON object")
    return data


def validate_artifact(spec: ModelSpec, root: Path | None) -> ArtifactCheck:
    if root is None or not root.is_dir():
        return ArtifactCheck(
            present=False, valid=False, missing=list(spec.required_files)
        )
    missing = [rel for rel in spec.required_files if not (root / rel).is_file()]
    check = ArtifactCheck(present=True, valid=False, missing=missing)
    if spec.kind in ("v2_sequence_classifier", "v3_multitask"):
        tok_dir = root / "backbone" if spec.kind == "v3_multitask" else root
        if not any((tok_dir / name).is_file() for name in TOKENIZER_FILES):
            check.missing.append("tokenizer (spm.model / tokenizer.json)")
    if check.missing:
        return check
    if spec.expected_model_sha256:
        weight_files = sorted(
            [root / "heads.pt", *sorted((root / "backbone").glob("*.safetensors"))]
        )
        digest = hashlib.sha256()
        for path in weight_files:
            digest.update(sha256_file(path).encode("ascii"))
        if digest.hexdigest() != spec.expected_model_sha256:
            check.problems.append("model weights SHA256 does not match the locked digest")
    try:
        if spec.kind != "baseline_joblib":
            check.manifest = _read_json(root / "model_manifest.json")
            check.inference_config = _read_json(root / "inference_config.json")
            check.thresholds = _read_json(root / "thresholds.json")
            if (root / "calibration.json").is_file():
                check.calibration = _read_json(root / "calibration.json")
    except (OSError, ValueError) as exc:
        check.problems.append(f"unreadable metadata: {exc}")
        return check
    icfg = check.inference_config
    for key in ("max_length", "stride", "aggregation"):
        if spec.kind != "baseline_joblib" and key not in icfg:
            check.problems.append(f"inference_config.json lacks '{key}'")
    if spec.kind == "v3_multitask" and icfg.get("view") not in (
        "canonical",
        "raw",
        "avg",
    ):
        check.problems.append("inference_config.json lacks a valid V3 'view'")
    if spec.kind != "baseline_joblib" and "BALANCED" not in check.thresholds:
        check.problems.append("thresholds.json lacks BALANCED")
    if spec.expected_parent_model:
        manifest = check.manifest
        if manifest.get("modelVersion") != spec.name:
            check.problems.append("model_manifest.json modelVersion does not match the registry")
        if manifest.get("parentModel") != spec.expected_parent_model:
            check.problems.append("model_manifest.json parentModel does not match the locked report")
        if manifest.get("gitCommit") != spec.expected_training_commit:
            check.problems.append("model_manifest.json gitCommit does not match the locked artifact")
        if manifest.get("status") != "EXPERIMENTAL" or manifest.get("active") is not False:
            check.problems.append("F006.1.1 must remain EXPERIMENTAL and inactive")

        calibration = check.calibration or {}
        global_curve = calibration.get("selected")
        global_params = global_curve.get("params") if isinstance(global_curve, dict) else None
        if (
            not isinstance(global_params, dict)
            or global_curve.get("method") != "isotonic"
            or not isinstance(global_params.get("x"), list)
            or not isinstance(global_params.get("y"), list)
            or len(global_params["x"]) < 2
            or len(global_params["x"]) != len(global_params["y"])
        ):
            check.problems.append("calibration.json lacks the locked global isotonic curve")

        spanish_curve = calibration.get("spanish")
        spanish_params = spanish_curve.get("params") if isinstance(spanish_curve, dict) else None
        if (
            not isinstance(spanish_params, dict)
            or spanish_curve.get("method") != "platt"
            or not isinstance(spanish_params.get("a"), (int, float))
            or not isinstance(spanish_params.get("b"), (int, float))
        ):
            check.problems.append("calibration.json lacks the locked Spanish Platt curve")

        for key, expected in (
            ("GLOBAL_THRESHOLD", spec.expected_global_threshold),
            ("SPANISH_THRESHOLD", spec.expected_spanish_threshold),
        ):
            actual = check.thresholds.get(key)
            if expected is not None and (
                not isinstance(actual, (int, float)) or abs(float(actual) - expected) > 1e-12
            ):
                check.problems.append(f"thresholds.json {key} does not match the locked artifact")
    check.valid = not check.problems
    return check


def sha256_file(path: Path, chunk: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()
