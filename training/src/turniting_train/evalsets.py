"""Fixed, seeded evaluation sets shared by baselines and transformers.

Every set is drawn from evaluation-side splits only; ids are frozen to
models/eval_sets.parquet so all models are compared on identical rows.
"""

from __future__ import annotations

import pandas as pd

from .common import MODELS_DIR
from .data import add_flags, load_split, stratified_cap
from .splits import (
    ADVERSARIAL_TEST, OOD_TEST, TEST, UNSEEN_DOMAIN_TEST, UNSEEN_GENERATOR_TEST, VALIDATION,
)

EVAL_SETS_PATH = MODELS_DIR / "eval_sets.parquet"


def _cap(df, n, seed, by=("dataset", "label")):
    return stratified_cap(df, n, list(by), seed) if len(df) else df


def build_eval_sets(cfg: dict, seed: int) -> pd.DataFrame:
    """Return long table (eval_set, id, split)."""
    if EVAL_SETS_PATH.exists():
        return pd.read_parquet(EVAL_SETS_PATH)
    ev = cfg["evaluation"]
    tf = cfg["transformer"]
    base = cfg["baseline"]
    val = add_flags(load_split(VALIDATION))
    test = add_flags(load_split(TEST))
    ood = add_flags(load_split(OOD_TEST))
    adv = add_flags(load_split(ADVERSARIAL_TEST))
    ugen = add_flags(load_split(UNSEEN_GENERATOR_TEST))
    udom = add_flags(load_split(UNSEEN_DOMAIN_TEST))

    sets = {}
    # --- large sets (baselines)
    sets["validation_large"] = _cap(val, base["eval_cap_per_split"], seed)
    sets["test_large"] = _cap(test, base["eval_cap_per_split"], seed)
    # --- transformer-sized sets (also scored by baselines)
    sets["validation"] = _cap(val, tf["val_docs"], seed, ("dataset", "label", "is_spanish"))
    sets["test"] = _cap(test, ev["test_docs"], seed, ("dataset", "label", "is_spanish"))
    sets["test_spanish"] = _cap(test[test["is_spanish"]], ev["spanish_extra_docs"], seed, ("dataset", "label", "domain"))
    sets["test_academic"] = _cap(test[test["is_academic"]], ev["academic_extra_docs"], seed, ("dataset", "label"))
    sets["validation_spanish"] = _cap(val[val["is_spanish"]], tf["val_docs"] // 2, seed, ("dataset", "label", "domain"))
    sets["validation_academic"] = _cap(val[val["is_academic"]], tf["val_docs"] // 2, seed, ("dataset", "label"))
    sets["ood"] = _cap(ood, ev["ood_docs"], seed, ("dataset", "subset", "label"))
    # adversarial: attacked rows + clean RAID test rows (reference for robustness deltas)
    raid_clean = test[(test["dataset"] == "raid") & (test["attack"] == "none")]
    sets["adversarial"] = _cap(adv, ev["adversarial_docs"], seed, ("dataset", "attack", "label"))
    sets["adversarial_clean_reference"] = _cap(raid_clean, ev["adversarial_docs"] // 4, seed, ("label", "domain"))
    # unseen generator: held-out machine rows + human rows of the same datasets (test split)
    gen_humans = test[(test["label"] == 0) & test["dataset"].isin(ugen["dataset"].unique())]
    ug = _cap(ugen, ev["unseen_generator_docs"], seed, ("dataset", "generator_family"))
    uh = _cap(gen_humans, len(ug), seed, ("dataset",))
    sets["unseen_generator"] = pd.concat([ug, uh])
    sets["unseen_domain"] = _cap(udom, ev["unseen_domain_docs"], seed, ("dataset", "domain", "label"))

    rows = []
    for name, frame in sets.items():
        rows.append(pd.DataFrame({"eval_set": name, "id": frame["id"].values, "split": frame["split"].values}))
    out = pd.concat(rows, ignore_index=True)
    EVAL_SETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(EVAL_SETS_PATH, index=False)
    return out


def load_eval_frame(eval_sets: pd.DataFrame, names: list[str], with_text: bool = True) -> dict[str, pd.DataFrame]:
    """name -> DataFrame with metadata (+ text) for each requested eval set."""
    cols = ["id", "text", "label", "language", "domain", "generator", "generator_family", "dataset",
            "subset", "attack", "is_adversarial", "n_words", "split", "metadata"]
    if not with_text:
        cols = [c for c in cols if c not in ("text", "metadata")]
    wanted = eval_sets[eval_sets["eval_set"].isin(names)]
    frames = []
    for split, g in wanted.groupby("split"):
        frames.append(load_split(split, cols, ids=g["id"].unique()))
    pool = pd.concat(frames, ignore_index=True).drop_duplicates("id").set_index("id")
    out = {}
    for name in names:
        ids = wanted.loc[wanted["eval_set"] == name, "id"]
        out[name] = add_flags(pool.loc[ids].reset_index())
    return out
