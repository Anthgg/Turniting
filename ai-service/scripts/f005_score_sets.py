"""Score VALIDATION and TEST documents with CANDIDATE_MODEL_V2 and CANDIDATE_MODEL_V3 (CPU).

    python ai-service/scripts/f005_score_sets.py --model CANDIDATE_MODEL_V3 --model-path data/models/candidate-v3 \
        --v1-dir ../Turniting-training/training --cap-validation 3000 --cap-test 1000 [--v2-dir data/v2]

Sets (provenance kept in the `source` column; frozen tests are never moved to validation):
  validation: V1 `validation` + V1 `adversarial_validation` split rows (+ V2 validation_v2[_spanish|_academic])
  test:       V1 frozen eval sets (test, test_spanish, test_academic, ood, adversarial, unseen_generator,
              unseen_domain) + V2 test families, synthetic attacks and external holdout 2026 when --v2-dir has them.
Output: data/eval/<model>_scores.parquet (Git-ignored), one logit per document.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as pads

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f005_common import EVAL_DIR, load_backend, log, score_frame, stratified  # noqa: E402

V1_TEST_SETS = ["test", "test_spanish", "test_academic", "ood", "adversarial", "unseen_generator", "unseen_domain"]
V2_SETS = ["validation_v2", "validation_v2_spanish", "validation_v2_academic", "test_v2", "test_v2_spanish",
           "test_v2_academic", "test_v2_mixed", "test_v2_ai_edited", "test_v2_adversarial", "test_v2_unseen_generator",
           "test_v2_unseen_domain", "test_v2_ood", "dataset_holdout_aigtxt"]


def v1_frame(v1_dir: Path, cap_val: int, cap_test: int) -> pd.DataFrame:
    master = v1_dir / "datasets" / "normalized" / "master"
    cols = ["id", "text", "label", "language", "domain", "dataset", "attack", "generator_family", "is_mixed"]
    frames = []
    for split, name in (("validation", "v1_validation"), ("adversarial_validation", "v1_adversarial_validation")):
        if not (master / split).exists():
            continue
        df = pads.dataset(str(master / split), format="parquet").to_table(columns=cols).to_pandas()
        df = df[df["label"].notna() & ~df["is_mixed"]]
        df["is_es"] = df["language"] == "es"
        df = stratified(df, cap_val if split == "validation" else cap_val // 4, ["dataset", "label", "is_es"])
        df["source"], df["role"] = name, "validation"
        frames.append(df.drop(columns=["is_es"]))
    ev = pd.read_parquet(v1_dir / "datasets" / "manifests" / "eval_sets.parquet")
    ev = ev[ev["eval_set"].isin(V1_TEST_SETS)]
    for name, g in ev.groupby("eval_set"):
        g = g.sample(min(len(g), cap_test), random_state=42)
        parts = []
        for split, gg in g.groupby("split"):
            ds = pads.dataset(str(master / split), format="parquet")
            parts.append(ds.to_table(columns=cols, filter=pc.field("id").isin(gg["id"].tolist())).to_pandas())
        df = pd.concat(parts)
        df["source"], df["role"] = f"v1_{name}", "test"
        frames.append(df)
    out = pd.concat(frames, ignore_index=True)
    out["fine_label"] = out["label"].map({0: "HUMAN", 1: "AI_GENERATED"})
    out["label"] = out["label"].astype(int)
    return out


def v2_frame(v2_dir: Path, cap_val: int, cap_test: int) -> pd.DataFrame:
    frames = []
    ev_path = v2_dir / "eval_sets_v2.parquet"
    if ev_path.exists() and (v2_dir / "master_v2").exists():
        ev = pd.read_parquet(ev_path)
        ev = ev[ev["eval_set"].isin(V2_SETS)]
        cols = ["id", "text_original", "fine_label", "language", "domain", "dataset", "attack", "generator_family"]
        for name, g in ev.groupby("eval_set"):
            g = g.sample(min(len(g), cap_val if name.startswith("validation") else cap_test), random_state=42)
            parts = []
            for split, gg in g.groupby("split"):
                ds = pads.dataset(str(v2_dir / "master_v2" / split), format="parquet")
                parts.append(ds.to_table(columns=cols, filter=pc.field("id").isin(gg["id"].tolist())).to_pandas())
            df = pd.concat(parts).rename(columns={"text_original": "text"})
            df["source"], df["role"] = name, "validation" if name.startswith("validation") else "test"
            frames.append(df)
    att = v2_dir / "synthetic_attacks.parquet"
    if att.exists():
        a = pd.read_parquet(att)
        a = a.groupby("eval_set", group_keys=False).apply(lambda x: x.sample(min(len(x), cap_test), random_state=42))
        a = a.rename(columns={"eval_set": "source"})
        a["fine_label"] = a["binary_label"].map({0: "HUMAN", 1: "AI_GENERATED"})
        a["role"] = "test"
        frames.append(a[["id", "text", "fine_label", "language", "domain", "dataset", "attack", "source", "role"]])
    ext = v2_dir / "external_holdout_2026.parquet"
    if ext.exists():
        e = pd.read_parquet(ext)
        e = e[~e["negative_control"]]
        e["source"], e["role"], e["language"], e["dataset"], e["attack"] = "external_holdout_2026", "test", "en", "ext2026", "none"
        frames.append(e[["id", "text", "fine_label", "language", "domain", "dataset", "attack", "source", "role", "generator"]])
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    out["label"] = (out["fine_label"] != "HUMAN").astype(int)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=["CANDIDATE_MODEL_V2", "CANDIDATE_MODEL_V3"])
    ap.add_argument("--model-path", required=True, type=Path)
    ap.add_argument("--v1-dir", required=True, type=Path, help="training directory holding the V1 master + eval sets")
    ap.add_argument("--v2-dir", type=Path, help="optional copy of MyDrive/turniting/v3/datasets (small files)")
    ap.add_argument("--cap-validation", type=int, default=3000)
    ap.add_argument("--cap-test", type=int, default=1000)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()
    frame = v1_frame(args.v1_dir, args.cap_validation, args.cap_test)
    if args.v2_dir:
        v2 = v2_frame(args.v2_dir, args.cap_validation, args.cap_test)
        frame = pd.concat([frame, v2], ignore_index=True) if len(v2) else frame
    frame = frame[frame["text"].notna() & (frame["text"].str.len() > 0)].reset_index(drop=True)
    log(f"{args.model}: {len(frame):,} documents; by source {frame['source'].value_counts().to_dict()}")
    out_path = EVAL_DIR / f"{args.model}_scores.parquet"
    done = pd.read_parquet(out_path) if out_path.exists() else pd.DataFrame(columns=["id", "source", "logit"])
    key = frame["id"].astype(str) + "|" + frame["source"]
    seen = set(done["id"].astype(str) + "|" + done["source"]) if len(done) else set()
    todo = frame[~key.isin(seen)]
    backend, icfg, profiles = load_backend(args.model, args.model_path, args.device, args.threads)
    log(f"loaded {args.model} on {backend.device}; view profiles {[p.name for p in profiles]}; {len(todo):,} to score")
    chunk = 500
    for start in range(0, len(todo), chunk):
        part = todo.iloc[start:start + chunk].copy()
        part["logit"] = score_frame(backend, icfg, profiles, part["text"].tolist())
        keep = part.drop(columns=["text"])
        done = pd.concat([done, keep], ignore_index=True) if len(done) else keep
        EVAL_DIR.mkdir(parents=True, exist_ok=True)
        done.to_parquet(out_path, index=False)  # checkpoint: the run can be resumed
        log(f"  saved {len(done):,} scores")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
