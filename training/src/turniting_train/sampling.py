"""Weighted sampling so no dataset/label/language dominates (no naive row duplication).

Per-row weight = dataset_weight / rows(dataset, label) * label_share
                 * language_weight(lang) * domain_weight(domain)
i.e. each dataset contributes mass proportional to its configured weight regardless of size
(RAID's millions of rows do not become 95 % of training), HUMAN/MACHINE are balanced inside
each dataset, and Spanish / academic rows get a configurable boost.

A fixed-size sample without replacement is drawn with Efraimidis-Spirakis keys
(u ** (1 / w)), the without-replacement equivalent of WeightedRandomSampler.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .textnorm import ACADEMIC_DOMAINS


def row_weights(df: pd.DataFrame, cfg: dict, spanish_weight: float | None = None,
                academic_weight: float | None = None) -> np.ndarray:
    ds_w = cfg.get("dataset_weights", {})
    lang_w = dict(cfg.get("language_weights", {}))
    if spanish_weight is not None:
        lang_w["es"] = spanish_weight
    academic = cfg.get("academic_weight", 1.0) if academic_weight is None else academic_weight
    label_share = cfg.get("label_balance", 0.5)
    ds = df["dataset"].astype(str)
    key = ds + "|" + df["label"].astype(int).astype(str)
    counts = key.map(key.value_counts())
    share = np.where(df["label"].astype(int) == 1, label_share, 1 - label_share)
    w = ds.map(lambda d: ds_w.get(d, ds_w.get("default", 1.0))).astype(float).values * share / counts.values
    w = w * df["language"].astype(str).map(lambda l: lang_w.get(l, lang_w.get("default", 1.0))).astype(float).values
    w = w * np.where(df["domain"].astype(str).isin(ACADEMIC_DOMAINS), academic, 1.0)
    return w


def weighted_sample(df: pd.DataFrame, weights: np.ndarray, n: int, seed: int) -> pd.DataFrame:
    if n >= len(df):
        return df
    rng = np.random.default_rng(seed)
    w = np.asarray(weights, dtype=float)
    keys = np.log(rng.random(len(df))) / np.maximum(w, 1e-300)
    idx = np.argpartition(-keys, n)[:n]
    return df.iloc[np.sort(idx)]


def usage_table(pool: pd.DataFrame, used: pd.DataFrame, weights: np.ndarray) -> pd.DataFrame:
    w = pd.Series(weights, index=pool.index)
    total = w.sum()
    rows = []
    for ds, g in pool.groupby("dataset", observed=True):
        rows.append({"dataset": str(ds), "available_rows": int(len(g)),
                     "used_rows": int((used["dataset"] == ds).sum()),
                     "sampling_mass": float(w.loc[g.index].sum() / total)})
    return pd.DataFrame(rows)
