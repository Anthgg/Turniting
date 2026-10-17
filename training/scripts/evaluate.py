"""Evaluate any saved detector (transformer dir, calibrated package or baseline) on the frozen
evaluation sets. Test-side sets need --final (use only after model selection on VALIDATION).

    python scripts/evaluate.py --model models/transformer/global --name GLOBAL_MULTILINGUAL_TRANSFORMER --final
    python scripts/evaluate.py --model models/baseline/best --name BEST_BASELINE --sets validation
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import (  # noqa: E402
    CONFIG_DIR, MANIFEST_DIR, MODELS_DIR, REPORTS_DIR, git_commit, keep_system_awake, load_yaml, read_json, utc_now, write_json,
)
from turniting_train.detector import Detector  # noqa: E402
from turniting_train.evalsets import build_eval_sets, load_eval_frame  # noqa: E402
from turniting_train.metrics import binary_metrics, brier, ece_score, grouped_metrics, length_bin  # noqa: E402

VALIDATION_SETS = ["validation", "validation_spanish", "validation_academic"]
TEST_SETS = ["test", "test_spanish", "test_academic", "ood", "adversarial", "adversarial_clean_reference",
             "unseen_generator", "unseen_domain"]
SCORES_DIR = MODELS_DIR / "eval_scores"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def doc_scores(det: Detector, df: pd.DataFrame, cache_key: str) -> tuple[np.ndarray, np.ndarray | None]:
    """(probability, raw doc logit) with a per-weights cache so calibrated packages reuse logits."""
    SCORES_DIR.mkdir(parents=True, exist_ok=True)
    if det.kind == "baseline":
        return det.machine_probability(df["text"].tolist()), None
    from turniting_train.transformer import aggregate, score_windows, sigmoid

    cache = SCORES_DIR / f"logits_{cache_key}.parquet"
    known = pd.read_parquet(cache) if cache.exists() else pd.DataFrame(columns=["id", "logit"])
    todo = df[~df["id"].isin(set(known["id"]))]
    if len(todo):
        wl = score_windows(det.model, det.tokenizer, todo["text"].tolist(), det.icfg["max_length"], det.icfg["stride"],
                           det.icfg["max_windows_per_doc"], batch_size=32, progress=True)
        new = pd.DataFrame({"id": todo["id"].values, "logit": aggregate(wl, det.icfg["aggregation"])})
        known = pd.concat([known, new], ignore_index=True)
        known.to_parquet(cache, index=False)
    logit = known.set_index("id").loc[df["id"], "logit"].values.astype(float)
    p = det.calibrator.predict(logit) if det.calibrator else sigmoid(logit)
    return p, logit


def license_text_ok() -> dict:
    lic = read_json(MANIFEST_DIR / "licenses.json")
    ok = {d["dataset"]: bool(d.get("text_allowed_in_reports")) for d in lic["datasets"]}
    ok["hc3_chinese"] = ok.get("hc3", False)
    return ok


def confident_errors(df, thr, kind, text_ok, limit=200):
    if kind == "fp":
        sel = df[(df["label"] == 0) & (df["score"] >= max(thr, 0.9))].sort_values("score", ascending=False)
    else:
        sel = df[(df["label"] == 1) & (df["score"] <= min(thr, 0.1))].sort_values("score")
    rows = []
    for r in sel.head(limit).itertuples(index=False):
        rec = {"dataset": r.dataset, "sample_id": r.id, "score": round(float(r.score), 5), "language": r.language,
               "domain": r.domain, "generator": r.generator, "attack": r.attack, "n_words": int(r.n_words),
               "eval_set": r.eval_set}
        if text_ok.get(r.dataset):
            rec["text_excerpt"] = r.text[:300]
        rows.append(rec)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--sets", nargs="*")
    ap.add_argument("--final", action="store_true", help="allow test-side sets (after model selection)")
    ap.add_argument("--threshold", default="BALANCED")
    args = ap.parse_args()
    keep_system_awake()
    cfg = load_yaml(CONFIG_DIR / "training.yaml")
    sets = args.sets or (VALIDATION_SETS + (TEST_SETS if args.final else []))
    if any(s in TEST_SETS for s in sets) and not args.final:
        raise SystemExit("test-side sets require --final (evaluate TEST only after model selection)")
    det = Detector(args.model, args.threshold)
    weights_id = str(getattr(det, "weights_path", det.path))
    cache_key = hashlib.sha1(weights_id.encode()).hexdigest()[:12]
    thr = det.threshold
    eval_sets = build_eval_sets(cfg, cfg["seed"])
    frames = load_eval_frame(eval_sets, sets)
    text_ok = license_text_ok()
    out = {"model": args.name, "path": str(det.path), "kind": det.kind, "threshold": thr,
           "thresholds": det.thresholds, "evaluatedAt": utc_now(), "gitCommit": git_commit(), "sets": {}}
    scored = []
    t0 = time.time()
    for name in sets:
        df = frames[name].copy()
        p, logit = doc_scores(det, df, cache_key)
        df["score"] = p
        df["eval_set"] = name
        df["length_bin"] = length_bin(df["n_words"]).values
        m = binary_metrics(df["label"], p, thr)
        e, rel = ece_score(df["label"], p)
        m.update(ece=e, brier=brier(df["label"], p), reliability=rel)
        m["groups"] = grouped_metrics(df, "score", thr, ["dataset", "language", "domain", "generator_family",
                                                         "generator", "attack", "length_bin"])
        m["spanish"] = binary_metrics(df.loc[df["is_spanish"], "label"], df.loc[df["is_spanish"], "score"], thr)
        m["academic"] = binary_metrics(df.loc[df["is_academic"], "label"], df.loc[df["is_academic"], "score"], thr)
        out["sets"][name] = m
        scored.append(df.drop(columns=["metadata"], errors="ignore"))
        log(f"{args.name} {name}: n={m['n']} macroF1={m.get('macro_f1')} f1={m.get('f1')} fpr={m.get('fpr')}")

    allscored = pd.concat(scored, ignore_index=True)
    allscored[["eval_set", "id", "label", "score", "dataset", "language", "domain", "generator", "generator_family",
               "attack", "n_words", "is_spanish", "is_academic"]].to_parquet(
        SCORES_DIR / f"{args.name}_scores.parquet", index=False)

    # robustness: same human pool, clean vs attacked machine texts (RAID)
    if "adversarial" in out["sets"] and "adversarial_clean_reference" in out["sets"]:
        clean = frames["adversarial_clean_reference"].assign(score=allscored.loc[allscored["eval_set"] == "adversarial_clean_reference", "score"].values)
        adv = frames["adversarial"].assign(score=allscored.loc[allscored["eval_set"] == "adversarial", "score"].values)
        humans = clean[clean["label"] == 0]
        rob = {"clean": binary_metrics(clean["label"], clean["score"], thr)}
        rob["adversarial_all"] = binary_metrics(pd.concat([humans["label"], adv.loc[adv["label"] == 1, "label"]]),
                                                np.concatenate([humans["score"], adv.loc[adv["label"] == 1, "score"]]), thr)
        for attack, g in adv.groupby("attack"):
            mach = g[g["label"] == 1]
            hum_att = g[g["label"] == 0]
            yy = np.concatenate([humans["label"], mach["label"]])
            ss = np.concatenate([humans["score"], mach["score"]])
            rob[str(attack)] = binary_metrics(yy, ss, thr)
            rob[str(attack)]["machine_recall"] = float((mach["score"] >= thr).mean()) if len(mach) else None
            rob[str(attack)]["attacked_human_fpr"] = float((hum_att["score"] >= thr).mean()) if len(hum_att) else None
        base_f1 = rob["clean"].get("f1")
        for k, v in rob.items():
            if k != "clean" and v.get("f1") is not None and base_f1 is not None:
                v["f1_drop_vs_clean"] = base_f1 - v["f1"]
        out["robustness"] = rob
    write_json(REPORTS_DIR / "eval" / f"{args.name}.json", out)
    uniq = allscored.drop_duplicates("id")
    fp = confident_errors(uniq, thr, "fp", text_ok)
    fn = confident_errors(uniq, thr, "fn", text_ok)
    (REPORTS_DIR / "eval").mkdir(parents=True, exist_ok=True)
    for kind, rows in (("false_positives", fp), ("false_negatives", fn)):
        with open(REPORTS_DIR / "eval" / f"{args.name}_high_confidence_{kind}.jsonl", "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    log(f"done in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
