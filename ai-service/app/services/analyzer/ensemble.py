"""V2 + V3 combination rules (no retraining): weighted probability, weighted log-odds and
conservative agreement. Weights/thresholds are chosen on VALIDATION by
ai-service/scripts/calibrate_analyzer.py and read from the analyzer profile file."""

from __future__ import annotations

import numpy as np

from app.services.analyzer.calibration import logit, sigmoid

HIGH_CONFIDENCE, REVIEW, LOW_SIGNAL = "HIGH_CONFIDENCE", "REVIEW", "LOW_SIGNAL"


def weighted_probability(p2, p3, w2: float):
    return w2 * np.asarray(p2, dtype=np.float64) + (1 - w2) * np.asarray(
        p3, dtype=np.float64
    )


def weighted_logodds(p2, p3, w2: float):
    return sigmoid(w2 * logit(p2) + (1 - w2) * logit(p3))


def agreement(p2: float, p3: float, t2: float, t3: float) -> str:
    hi2, hi3 = p2 >= t2, p3 >= t3
    if hi2 and hi3:
        return HIGH_CONFIDENCE
    if hi2 or hi3:
        return REVIEW
    return LOW_SIGNAL


def combine(method: str, p2, p3, w2: float):
    if method == "weighted_probability":
        return weighted_probability(p2, p3, w2)
    if method == "weighted_logodds":
        return weighted_logodds(p2, p3, w2)
    raise ValueError(f"unknown ensemble method {method}")
