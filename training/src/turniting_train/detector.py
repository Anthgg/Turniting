"""Unified loader for saved detectors (transformer dir or baseline joblib) used by
predict.py, predict_batch.py and evaluate.py. Outputs P(HUMAN) / P(MACHINE) only."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .calibration import Calibrator
from .common import read_json


class Detector:
    def __init__(self, path: str | Path, threshold_name: str = "BALANCED"):
        self.path = Path(path)
        self.manifest = read_json(self.path / "model_manifest.json", {})
        self.kind = "baseline" if (self.path / "model.joblib").exists() else "transformer"
        thresholds = read_json(self.path / "thresholds.json", None)
        if self.kind == "baseline":
            import joblib

            self.bundle = joblib.load(self.path / "model.joblib")
            thresholds = thresholds or self.bundle.get("thresholds")
            self.calibrator = None
        else:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            from .common import TRAINING_DIR

            link = read_json(self.path / "base_model.json", None)
            weights = TRAINING_DIR / link["path"] if link else self.path
            self.weights_path = weights
            self.tokenizer = AutoTokenizer.from_pretrained(weights)
            self.model = AutoModelForSequenceClassification.from_pretrained(weights)
            if torch.cuda.is_available():
                self.model.to("cuda")
            self.model.eval()
            torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
            self.icfg = read_json(self.path / "inference_config.json")
            cal = read_json(self.path / "calibration.json", None)
            self.calibrator = Calibrator.from_dict(cal["selected"]) if cal else None
        self.thresholds = thresholds or {"BALANCED": {"threshold": 0.5}}
        self.threshold_name = threshold_name
        self.threshold = float(self.thresholds[threshold_name]["threshold"])
        self.version = self.manifest.get("modelVersion", self.path.name)

    def machine_probability(self, texts: list[str], batch_size: int = 32) -> np.ndarray:
        if self.kind == "baseline":
            return self._baseline_scores(texts)
        from .transformer import aggregate, score_windows, sigmoid

        wl = score_windows(self.model, self.tokenizer, texts, self.icfg["max_length"], self.icfg["stride"],
                           self.icfg["max_windows_per_doc"], batch_size=batch_size)
        logits = aggregate(wl, self.icfg["aggregation"])
        return self.calibrator.predict(logits) if self.calibrator else sigmoid(logits)

    def _baseline_scores(self, texts):
        from .features import stylometric_matrix

        b = self.bundle
        kind = b["kind"]
        if kind == "stylometric_gbm":
            return b["model"].predict_proba(stylometric_matrix(texts))[:, 1]
        X = b["vectorizer"].transform(texts)
        if kind == "ensemble_tfidf_stylometric":
            S = stylometric_matrix(texts)
            base = b["base_models"]

            def logit(p):
                p = np.clip(p, 1e-6, 1 - 1e-6)
                return np.log(p / (1 - p))
            X = np.column_stack([logit(base["lr"].predict_proba(X)[:, 1]), base["svm"].decision_function(X),
                                 logit(base["gbm"].predict_proba(S)[:, 1]), b["scaler"].transform(S)])
        return b["model"].predict_proba(X)[:, 1]

    def predict(self, texts: list[str]) -> list[dict]:
        p = self.machine_probability(texts)
        return [{
            "machineProbability": round(float(x), 6),
            "humanProbability": round(float(1 - x), 6),
            "label": "MACHINE" if x >= self.threshold else "HUMAN",
            "threshold": self.threshold,
            "thresholdName": self.threshold_name,
            "modelVersion": self.version,
        } for x in p]
