"""Shared helpers for the F005 local analyzer evaluation scripts (inference only).

Run with a Python that has torch + transformers (e.g. the training venv); only the
dependency-light analyzer modules are imported (no FastAPI / settings).
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

AI_SERVICE = Path(__file__).resolve().parents[1]
REPO = AI_SERVICE.parent
sys.path.insert(0, str(AI_SERVICE))

from app.services.analyzer.backends import V2Backend, V3Backend  # noqa: E402
from app.services.analyzer.preprocessing import (  # noqa: E402
    V2_PREPROCESSING_V1,
    profile_for_view,
)
from app.services.analyzer.scoring import score_document  # noqa: E402

REPORT_DIR = REPO / "training" / "reports" / "local_analyzer"
PROFILE_DIR = AI_SERVICE / "app" / "services" / "analyzer" / "profiles"
EVAL_DIR = REPO / "data" / "eval"  # Git-ignored: per-document scores
HUMAN_FINE = "HUMAN"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=float) + "\n", encoding="utf-8")


def ids_hash(ids) -> str:
    return hashlib.sha256("\n".join(sorted(map(str, ids))).encode()).hexdigest()


def load_backend(model: str, path: Path, device: str = "cpu", threads: int = 8):
    cls = V3Backend if model == "CANDIDATE_MODEL_V3" else V2Backend
    backend = cls(path, device, threads)
    backend.load()
    icfg = json.loads((path / "inference_config.json").read_text(encoding="utf-8"))
    profiles = profile_for_view(icfg.get("view", "canonical")) if model == "CANDIDATE_MODEL_V3" else [V2_PREPROCESSING_V1]
    return backend, icfg, profiles


def score_frame(backend, icfg, profiles, texts: list[str], every: int = 200) -> np.ndarray:
    out = np.zeros(len(texts), dtype=np.float64)
    t0 = time.time()
    for i, text in enumerate(texts):
        out[i] = score_document(backend, text, profiles, icfg.get("aggregation", "mean")).logit
        if (i + 1) % every == 0:
            log(f"  scored {i + 1}/{len(texts)} ({(i + 1) / (time.time() - t0):.2f} docs/s)")
    return out


def stratified(df: pd.DataFrame, n: int, by: list[str], seed: int = 42) -> pd.DataFrame:
    if len(df) <= n:
        return df
    groups = df.groupby(by, observed=True)
    k = max(1, n // max(groups.ngroups, 1))
    while groups.size().clip(upper=k).sum() < n and k < len(df):
        k = int(k * 1.3) + 1
    out = pd.concat([g.sample(min(len(g), k), random_state=seed) for _, g in groups])
    return out.sample(n, random_state=seed) if len(out) > n else out


def binary_metrics(y, p, thr: float) -> dict:
    y = np.asarray(y).astype(int)
    p = np.asarray(p, dtype=float)
    pred = (p >= thr).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    rec0 = tn / (tn + fp) if tn + fp else 0.0
    prec0 = tn / (tn + fn) if tn + fn else 0.0
    f10 = 2 * prec0 * rec0 / (prec0 + rec0) if prec0 + rec0 else 0.0
    out = {"n": int(len(y)), "n_human": int((y == 0).sum()), "n_machine": int((y == 1).sum()), "threshold": thr,
           "accuracy": (tp + tn) / len(y) if len(y) else None, "precision": prec, "recall": rec, "f1": f1,
           "macro_f1": (f1 + f10) / 2 if (y == 0).any() and (y == 1).any() else None,
           "fpr": fp / (fp + tn) if fp + tn else None, "fnr": fn / (fn + tp) if fn + tp else None}
    try:
        from sklearn.metrics import (
            average_precision_score,
            matthews_corrcoef,
            roc_auc_score,
        )

        if len(set(y)) > 1:
            out["roc_auc"] = float(roc_auc_score(y, p))
            out["pr_auc"] = float(average_precision_score(y, p))
            out["mcc"] = float(matthews_corrcoef(y, pred))
    except ImportError:  # pragma: no cover
        pass
    out["brier"] = float(np.mean((p - y) ** 2)) if len(y) else None
    out["ece"] = ece(y, p)
    return out


def ece(y, p, bins: int = 15) -> float | None:
    if not len(y):
        return None
    y, p = np.asarray(y, dtype=float), np.asarray(p, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for i in range(bins):
        m = (p >= edges[i]) & ((p < edges[i + 1]) if i < bins - 1 else (p <= edges[i + 1]))
        if m.any():
            total += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(total)
