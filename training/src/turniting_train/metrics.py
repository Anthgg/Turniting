"""Binary detection metrics (MACHINE = positive class), grouped metrics, calibration, thresholds."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score, average_precision_score, balanced_accuracy_score, confusion_matrix, f1_score,
    matthews_corrcoef, precision_score, recall_score, roc_auc_score,
)

LENGTH_BINS = [(0, 50, "<50"), (50, 100, "50-100"), (100, 250, "100-250"), (250, 500, "250-500"),
               (500, 10**9, "500+")]


def _safe(fn, *args, **kw):
    try:
        v = fn(*args, **kw)
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    except ValueError:
        return None


def binary_metrics(y_true, score, threshold: float = 0.5) -> dict:
    y = np.asarray(y_true).astype(int)
    s = np.asarray(score, dtype=float)
    pred = (s >= threshold).astype(int)
    n = len(y)
    out: dict = {"n": int(n), "n_human": int((y == 0).sum()), "n_machine": int((y == 1).sum()),
                 "threshold": float(threshold)}
    if n == 0:
        return out
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    out.update({
        "accuracy": float(accuracy_score(y, pred)),
        "balanced_accuracy": _safe(balanced_accuracy_score, y, pred) if len(set(y)) > 1 else None,
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "f1": float(f1_score(y, pred, zero_division=0)),
        "macro_f1": float(f1_score(y, pred, average="macro", labels=[0, 1], zero_division=0)),
        "roc_auc": _safe(roc_auc_score, y, s) if len(set(y)) > 1 else None,
        "pr_auc": _safe(average_precision_score, y, s) if (y == 1).any() else None,
        "fpr": float(fp / (fp + tn)) if (fp + tn) else None,
        "fnr": float(fn / (fn + tp)) if (fn + tp) else None,
        "mcc": _safe(matthews_corrcoef, y, pred) if len(set(y)) > 1 else None,
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    })
    return out


def length_bin(n_words) -> pd.Series:
    n = pd.Series(n_words)
    out = pd.Series(["500+"] * len(n), index=n.index, dtype=object)
    for lo, hi, name in LENGTH_BINS:
        out[(n >= lo) & (n < hi)] = name
    return out


def grouped_metrics(df: pd.DataFrame, score_col: str, threshold: float, by: list[str],
                    min_n: int = 30) -> dict:
    """Metrics per value of each column in `by` (groups smaller than min_n are flagged)."""
    out = {}
    for col in by:
        res = {}
        for key, g in df.groupby(col, observed=True):
            m = binary_metrics(g["label"], g[score_col], threshold)
            m["small_sample"] = len(g) < min_n
            res[str(key)] = m
        out[col] = res
    return out


def ece_score(y, p, bins: int = 15) -> tuple[float, list[dict]]:
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    ece, table = 0.0, []
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (p >= lo) & (p < hi) if i < bins - 1 else (p >= lo) & (p <= hi)
        if mask.sum() == 0:
            table.append({"bin_low": lo, "bin_high": hi, "count": 0, "mean_pred": None, "frac_pos": None})
            continue
        conf, acc = p[mask].mean(), y[mask].mean()
        ece += mask.mean() * abs(conf - acc)
        table.append({"bin_low": float(lo), "bin_high": float(hi), "count": int(mask.sum()),
                      "mean_pred": float(conf), "frac_pos": float(acc)})
    return float(ece), table


def brier(y, p) -> float:
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    return float(np.mean((p - y) ** 2))


def threshold_sweep(y, p, grid=None) -> pd.DataFrame:
    grid = np.linspace(0.02, 0.98, 97) if grid is None else grid
    rows = []
    for t in grid:
        m = binary_metrics(y, p, t)
        rows.append({k: m.get(k) for k in ("threshold", "precision", "recall", "f1", "macro_f1", "fpr", "fnr")})
    return pd.DataFrame(rows)


def select_thresholds(y, p, max_fpr_low: float = 0.01, target_precision: float = 0.95) -> dict:
    """Three operating points chosen on VALIDATION only.

    balanced:            maximise macro F1
    low_false_positive:  lowest threshold whose FPR <= max_fpr_low (largest recall under FP cap)
    high_precision_ai:   lowest threshold with precision >= target_precision
    """
    sweep = threshold_sweep(y, p, np.linspace(0.01, 0.99, 197))
    balanced = sweep.loc[sweep["macro_f1"].idxmax()]
    low_fp = sweep[sweep["fpr"].fillna(1) <= max_fpr_low]
    low_fp = low_fp.iloc[0] if len(low_fp) else sweep.iloc[-1]
    hp = sweep[sweep["precision"].fillna(0) >= target_precision]
    hp = hp.iloc[0] if len(hp) else sweep.iloc[-1]
    pack = lambda r: {k: (None if pd.isna(v) else float(v)) for k, v in r.items()}  # noqa: E731
    return {
        "BALANCED": pack(balanced),
        "LOW_FALSE_POSITIVE": {**pack(low_fp), "constraint": f"fpr<={max_fpr_low}"},
        "HIGH_PRECISION_AI": {**pack(hp), "constraint": f"precision>={target_precision}"},
    }
