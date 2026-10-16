"""Group-aware split assignment (pure functions, unit-tested)."""

from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd

TRAIN, VALIDATION, TEST = "train", "validation", "test"
OOD_TEST = "ood_test"
ADVERSARIAL_TEST = "adversarial_test"
ADVERSARIAL_VALIDATION = "adversarial_validation"
UNSEEN_GENERATOR_TEST = "unseen_generator_test"
UNSEEN_DOMAIN_TEST = "unseen_domain_test"
MIXED = "mixed"
EVAL_SIDE = {VALIDATION, TEST, OOD_TEST, ADVERSARIAL_TEST, ADVERSARIAL_VALIDATION,
             UNSEEN_GENERATOR_TEST, UNSEEN_DOMAIN_TEST}


def unit_hash(key: str, seed: int) -> float:
    digest = hashlib.sha256(f"{seed}:{key}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def component_splits(df: pd.DataFrame, seed: int, ratios: dict) -> pd.Series:
    """One base split per component (`group_id`).

    Groups holding an official test / OOD row go to the evaluation side as a whole so that
    no relative of an official test item can be trained on.
    """
    forced = df.groupby("group_id")["role"].agg(
        lambda r: bool(r.isin(["official_test", "ood", "ood_paraphrase"]).any()))
    keys = df.groupby("group_id")["id"].min()
    u = np.array([unit_hash(k, seed) for k in keys.values])
    base = np.where(u < ratios["train"], TRAIN,
                    np.where(u < ratios["train"] + ratios["validation"], VALIDATION, TEST))
    base = pd.Series(base, index=keys.index)
    base[forced.reindex(base.index).values] = TEST
    return base


def row_split(row_base: pd.Series, df: pd.DataFrame, holdout_families: set[str],
              holdout_domains: set[str]) -> tuple[pd.Series, pd.Series]:
    """Final split per row + exclusion reason (None when kept)."""
    split = row_base.copy()
    reason = pd.Series([None] * len(df), index=df.index, dtype=object)
    train_side = row_base == TRAIN

    mixed = df["is_mixed"]
    split[mixed] = MIXED

    ood = df["role"] == "ood"
    split[ood & ~mixed] = OOD_TEST
    para = df["role"] == "ood_paraphrase"
    split[para] = ADVERSARIAL_TEST

    gen_hold = (df["label"] == 1) & df["generator_family"].isin(holdout_families) & ~mixed
    dom_hold = df["domain"].isin(holdout_domains) & ~mixed & ~gen_hold
    for mask, target, why in ((gen_hold, UNSEEN_GENERATOR_TEST, "HOLDOUT_GENERATOR_IN_TRAIN_GROUP"),
                              (dom_hold, UNSEEN_DOMAIN_TEST, "HOLDOUT_DOMAIN_IN_TRAIN_GROUP")):
        split[mask & ~train_side] = target
        reason[mask & train_side] = why

    adv = df["is_adversarial"] & ~para & ~gen_hold & ~dom_hold & ~mixed & ~ood
    split[adv & (row_base == VALIDATION)] = ADVERSARIAL_VALIDATION
    split[adv & (row_base == TEST)] = ADVERSARIAL_TEST
    split[reason.notna()] = None
    return split, reason


def leakage_report(df: pd.DataFrame) -> dict:
    """Counts of groups / hashes present on both the train side and the evaluation side."""
    kept = df[df["split"].notna() & (df["split"] != MIXED)]
    side = np.where(kept["split"] == TRAIN, "train", "eval")
    tmp = pd.DataFrame({"g": kept["group_id"].values, "h": kept["normalized_text_hash"].values, "side": side})
    g = tmp.groupby("g")["side"].nunique()
    h = tmp.groupby("h")["side"].nunique()
    return {
        "groups_spanning_train_and_eval": int((g > 1).sum()),
        "exact_hashes_spanning_train_and_eval": int((h > 1).sum()),
    }
