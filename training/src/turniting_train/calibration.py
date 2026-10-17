"""Post-hoc probability calibration on VALIDATION: temperature, Platt, isotonic."""

from __future__ import annotations

import numpy as np
from scipy.optimize import minimize_scalar
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

from .metrics import brier, ece_score


def _sig(x):
    return 1.0 / (1.0 + np.exp(-x))


class Calibrator:
    def __init__(self, method: str):
        self.method = method
        self.params: dict = {}
        self._iso = None

    def fit(self, logits, y):
        logits = np.asarray(logits, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        if self.method == "none":
            pass
        elif self.method == "temperature":
            def nll(t):
                p = np.clip(_sig(logits / t), 1e-7, 1 - 1e-7)
                return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
            self.params["temperature"] = float(minimize_scalar(nll, bounds=(0.05, 20), method="bounded").x)
        elif self.method == "platt":
            lr = LogisticRegression(C=1e6).fit(logits[:, None], y)
            self.params = {"a": float(lr.coef_[0, 0]), "b": float(lr.intercept_[0])}
        elif self.method == "isotonic":
            self._iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(_sig(logits), y)
            self.params = {"x": self._iso.X_thresholds_.tolist(), "y": self._iso.y_thresholds_.tolist()}
        else:
            raise ValueError(self.method)
        return self

    def predict(self, logits):
        logits = np.asarray(logits, dtype=np.float64)
        if self.method == "none":
            return _sig(logits)
        if self.method == "temperature":
            return _sig(logits / self.params["temperature"])
        if self.method == "platt":
            return _sig(self.params["a"] * logits + self.params["b"])
        x = np.asarray(self.params["x"])
        yv = np.asarray(self.params["y"])
        return np.interp(_sig(logits), x, yv)

    def to_dict(self):
        return {"method": self.method, "params": self.params}

    @classmethod
    def from_dict(cls, d):
        c = cls(d["method"])
        c.params = d["params"]
        return c


def select_calibrator(logits, y, methods, seed: int = 42, folds: int = 3) -> tuple[Calibrator, dict]:
    """Choose by cross-validated ECE (tie-break Brier) on VALIDATION, then refit on all of it."""
    logits = np.asarray(logits, dtype=np.float64)
    y = np.asarray(y).astype(int)
    report = {}
    skf = StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed)
    for method in ["none", *methods]:
        oof = np.zeros(len(y))
        for tr, te in skf.split(logits, y):
            oof[te] = Calibrator(method).fit(logits[tr], y[tr]).predict(logits[te])
        e, _ = ece_score(y, oof)
        report[method] = {"cv_ece": e, "cv_brier": brier(y, oof)}
    best = min(methods, key=lambda m: (round(report[m]["cv_ece"], 4), report[m]["cv_brier"]))
    return Calibrator(best).fit(logits, y), report
