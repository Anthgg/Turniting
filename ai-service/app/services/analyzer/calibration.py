"""Probability calibration and threshold profiles (numpy only at inference time).

Calibrators map document log-odds to probabilities. Their parameters are fitted on
VALIDATION data by ai-service/scripts/calibrate_analyzer.py and stored as JSON; the
same format is used by the training pipeline (training/src/turniting_train/calibration.py).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

PROFILES = ("BALANCED", "LOW_FALSE_POSITIVE", "VERY_LOW_FALSE_POSITIVE", "CUSTOM")


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.asarray(x, dtype=np.float64)))


def logit(p, eps: float = 1e-6):
    p = np.clip(np.asarray(p, dtype=np.float64), eps, 1 - eps)
    return np.log(p / (1 - p))


@dataclass
class Calibrator:
    method: str
    params: dict

    @classmethod
    def from_dict(cls, data: dict | None) -> Calibrator:
        if not data:
            return cls("none", {})
        return cls(data.get("method", "none"), dict(data.get("params", {})))

    def to_dict(self) -> dict:
        return {"method": self.method, "params": self.params}

    def predict(self, logits) -> np.ndarray:
        x = np.asarray(logits, dtype=np.float64)
        if self.method == "none":
            return sigmoid(x)
        if self.method == "temperature":
            return sigmoid(x / float(self.params["temperature"]))
        if self.method == "platt":
            return sigmoid(float(self.params["a"]) * x + float(self.params["b"]))
        if self.method == "isotonic":
            return np.interp(
                sigmoid(x), np.asarray(self.params["x"]), np.asarray(self.params["y"])
            )
        raise ValueError(f"unknown calibration method {self.method}")


def thresholds_from_model(data: dict) -> dict[str, float]:
    """Threshold profiles packaged with a model (training-time, validation-chosen)."""
    out = {}
    for name, value in data.items():
        if isinstance(value, dict) and value.get("threshold") is not None:
            out[name] = float(value["threshold"])
    return out


def signal_level(p: float) -> str:
    """Neutral display bands of the calibrated AI signal probability."""
    if p < 0.35:
        return "LOW"
    if p < 0.65:
        return "MODERATE"
    return "HIGH"


def confidence(p: float, threshold: float) -> str:
    """How far the probability sits from the decision threshold (not a guarantee)."""
    margin = abs(p - threshold)
    if margin < 0.10:
        return "LOW"
    if margin < 0.25:
        return "MODERATE"
    return "HIGH"


def safe_float(x) -> float | None:
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) else x
