"""Read the master dataset (parquet shards) without materialising text unless needed."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

from .common import NORMALIZED_DIR
from .textnorm import ACADEMIC_DOMAINS

MASTER = NORMALIZED_DIR / "master"
META_COLS = ["id", "label", "language", "domain", "generator", "generator_family", "dataset", "subset",
             "attack", "is_adversarial", "is_mixed", "group_id", "split", "n_words", "n_chars", "role"]


def split_dir(split: str) -> Path:
    return MASTER / split


def load_split(split: str, columns: list[str] | None = None, ids=None) -> pd.DataFrame:
    path = split_dir(split)
    if not path.exists():
        return pd.DataFrame(columns=columns or META_COLS)
    dataset = pads.dataset(str(path), format="parquet")
    flt = pc.field("id").isin(pd.Index(ids).astype(str).tolist()) if ids is not None else None
    table = dataset.to_table(columns=columns or META_COLS, filter=flt)
    df = table.to_pandas()
    if "label" in df:
        df = df[df["label"].notna()].copy()
        df["label"] = df["label"].astype(int)
    return df


def add_flags(df: pd.DataFrame) -> pd.DataFrame:
    df["is_spanish"] = df["language"] == "es"
    df["is_academic"] = df["domain"].isin(ACADEMIC_DOMAINS)
    return df


def stratified_cap(df: pd.DataFrame, n: int, by: list[str], seed: int) -> pd.DataFrame:
    """Up to n rows, spread evenly across strata (smaller strata kept whole)."""
    if len(df) <= n:
        return df
    groups = df.groupby(by, observed=True)
    k = max(1, n // max(groups.ngroups, 1))
    while True:
        total = groups.size().clip(upper=k).sum()
        if total >= n or k > len(df):
            break
        k = int(k * 1.25) + 1
    parts = [g.sample(min(len(g), k), random_state=seed) for _, g in groups]
    out = pd.concat(parts)
    return out.sample(min(n, len(out)), random_state=seed) if len(out) > n else out
