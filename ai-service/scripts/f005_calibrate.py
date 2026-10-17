"""Choose calibration, threshold profiles and the V2+V3 ensemble on VALIDATION only.

    python ai-service/scripts/f005_calibrate.py

Reads data/eval/CANDIDATE_MODEL_V{2,3}_scores.parquet (rows with role == "validation"; test
rows are ignored here) and writes:
  ai-service/app/services/analyzer/profiles/{CANDIDATE_MODEL_V2,CANDIDATE_MODEL_V3,ENSEMBLE_V2_V3}.json
  training/reports/local_analyzer/{calibration_v2,calibration_v3,threshold_search_v2,threshold_search_v3,
                                   ensemble_validation}.json

Selection rules (fixed before looking at any test result):
  calibration   lowest out-of-fold ECE + Brier (3-fold CV) among none / temperature / platt / isotonic
  BALANCED      maximise validation macro F1
  LOW_FALSE_POSITIVE       largest recall with validation FPR <= 0.05
  VERY_LOW_FALSE_POSITIVE  largest recall with validation FPR <= 0.02
  ensemble/analyzer score S (at each candidate's LOW_FALSE_POSITIVE threshold):
      S = 0.30*macroF1_all + 0.20*macroF1_es + 0.20*macroF1_academic + 0.20*recall_mixed_edited
          + 0.10*recall_adversarial - 2.0*max(0, FPR_all - 0.05) - 1.0*max(0, FPR_es - 0.08)
      (terms without validation rows are dropped and the weights renormalised)
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f005_common import (  # noqa: E402
    EVAL_DIR,
    PROFILE_DIR,
    REPORT_DIR,
    binary_metrics,
    ece,
    ids_hash,
    log,
    write_json,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.analyzer.calibration import Calibrator, sigmoid  # noqa: E402
from app.services.analyzer.ensemble import combine  # noqa: E402

VERSION = "f005-v1"
GRID = np.round(np.arange(0.01, 0.995, 0.005), 3)
FPR_TARGETS = {"LOW_FALSE_POSITIVE": 0.05, "VERY_LOW_FALSE_POSITIVE": 0.02}
ACADEMIC = {"academic"}


def fit(method: str, logits, y) -> Calibrator:
    x = np.asarray(logits, dtype=float)
    if method == "none":
        return Calibrator("none", {})
    if method == "temperature":
        def nll(t):
            p = np.clip(sigmoid(x / t), 1e-7, 1 - 1e-7)
            return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
        return Calibrator("temperature", {"temperature": float(minimize_scalar(nll, bounds=(0.05, 20), method="bounded").x)})
    if method == "platt":
        lr = LogisticRegression(C=1e6).fit(x[:, None], y)
        return Calibrator("platt", {"a": float(lr.coef_[0, 0]), "b": float(lr.intercept_[0])})
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(sigmoid(x), y)
    return Calibrator("isotonic", {"x": iso.X_thresholds_.tolist(), "y": iso.y_thresholds_.tolist()})


def choose_calibration(logits, y) -> tuple[Calibrator, dict]:
    skf = StratifiedKFold(n_splits=3, shuffle=True, random_state=42)
    report = {}
    for method in ("none", "temperature", "platt", "isotonic"):
        oof = np.zeros(len(y))
        for tr, te in skf.split(logits, y):
            oof[te] = fit(method, logits[tr], y[tr]).predict(logits[te])
        bal = max(GRID, key=lambda t: binary_metrics(y, oof, t)["macro_f1"] or 0)
        m = binary_metrics(y, oof, bal)
        report[method] = {"cv_ece": ece(y, oof), "cv_brier": float(np.mean((oof - y) ** 2)),
                          "cv_macro_f1_at_balanced": m["macro_f1"], "cv_fpr_at_balanced": m["fpr"],
                          "cv_recall_at_balanced": m["recall"]}
    best = min(report, key=lambda k: (report[k]["cv_ece"] + report[k]["cv_brier"], -(report[k]["cv_macro_f1_at_balanced"] or 0)))
    return fit(best, logits, y), report


def threshold_profiles(y, p, groups: dict[str, np.ndarray]) -> dict:
    sweep = [(t, binary_metrics(y, p, t)) for t in GRID]
    bal_t, bal = max(sweep, key=lambda r: r[1]["macro_f1"] or 0)
    out = {"BALANCED": {"threshold": float(bal_t), "rule": "max validation macro F1", **_brief(bal)}}
    for name, target in FPR_TARGETS.items():
        ok = [(t, m) for t, m in sweep if m["fpr"] is not None and m["fpr"] <= target]
        if ok:
            t, m = max(ok, key=lambda r: (r[1]["recall"], -r[0]))
            note = None
        else:
            t, m = min(sweep, key=lambda r: (r[1]["fpr"], -r[1]["recall"]))
            note = f"FPR <= {target} not reachable on validation; closest threshold chosen"
        out[name] = {"threshold": float(t), "rule": f"max recall with validation FPR <= {target}", "note": note,
                     "recall_lost_vs_balanced": float(bal["recall"] - m["recall"]), **_brief(m)}
    for prof in out.values():
        t = prof["threshold"]
        prof["by_group_fpr"] = {g: binary_metrics(y[mask], p[mask], t)["fpr"] for g, mask in groups.items() if mask.sum() >= 20}
    return out


def _brief(m: dict) -> dict:
    return {k: m.get(k) for k in ("macro_f1", "precision", "recall", "fpr", "fnr", "roc_auc", "ece", "brier", "n")}


def composite(y, p, t, frame: pd.DataFrame) -> tuple[float, dict]:
    parts, weights = {}, {}

    def add(name, w, value):
        if value is not None and not np.isnan(value):
            parts[name], weights[name] = value, w

    es = (frame["language"] == "es").to_numpy()
    aca = frame["domain"].isin(ACADEMIC).to_numpy()
    mixed = frame["fine_label"].isin(["MIXED", "AI_EDITED", "HUMAN_EDITED_AI"]).to_numpy()
    adv = frame["source"].str.contains("adversarial").to_numpy() & (y == 1)
    add("macro_f1_all", 0.30, binary_metrics(y, p, t)["macro_f1"])
    if es.sum() >= 30:
        add("macro_f1_es", 0.20, binary_metrics(y[es], p[es], t)["macro_f1"])
    if aca.sum() >= 30:
        add("macro_f1_academic", 0.20, binary_metrics(y[aca], p[aca], t)["macro_f1"])
    if mixed.sum() >= 30:
        add("recall_mixed_edited", 0.20, float((p[mixed] >= t).mean()))
    if adv.sum() >= 30:
        add("recall_adversarial", 0.10, float((p[adv] >= t).mean()))
    total_w = sum(weights.values())
    score = sum(parts[k] * weights[k] for k in parts) / total_w
    fpr = binary_metrics(y, p, t)["fpr"] or 0.0
    fpr_es = binary_metrics(y[es], p[es], t)["fpr"] if es.sum() >= 30 else 0.0
    penalty = 2.0 * max(0.0, fpr - 0.05) + 1.0 * max(0.0, (fpr_es or 0.0) - 0.08)
    return score - penalty, {**parts, "weights": {k: v / total_w for k, v in weights.items()}, "fpr": fpr,
                             "fpr_es": fpr_es, "penalty": penalty}


def low_fp_threshold(y, p, target: float = 0.05) -> float:
    ok = [t for t in GRID if (binary_metrics(y, p, t)["fpr"] or 0) <= target]
    return float(min(ok)) if ok else float(GRID[-1])


def main() -> int:
    scores = {}
    for model in ("CANDIDATE_MODEL_V2", "CANDIDATE_MODEL_V3"):
        path = EVAL_DIR / f"{model}_scores.parquet"
        if not path.exists():
            log(f"missing {path}: score the sets first (f005_score_sets.py)")
            return 2
        scores[model] = pd.read_parquet(path)
    key = ["id", "source"]
    merged = scores["CANDIDATE_MODEL_V2"].merge(scores["CANDIDATE_MODEL_V3"][key + ["logit"]], on=key,
                                                 suffixes=("_v2", "_v3"))
    val = merged[merged["role"] == "validation"].reset_index(drop=True)
    y = val["label"].to_numpy().astype(int)
    log(f"validation documents: {len(val):,} ({val['source'].value_counts().to_dict()})")
    groups = {"spanish_human": (val["language"] == "es").to_numpy(), "academic_human": val["domain"].isin(ACADEMIC).to_numpy(),
              "v1_validation": (val["source"] == "v1_validation").to_numpy()}
    vhash = ids_hash(val["id"].astype(str) + "|" + val["source"])
    probs, candidates = {}, {}
    for model, col, slug in (("CANDIDATE_MODEL_V2", "logit_v2", "v2"), ("CANDIDATE_MODEL_V3", "logit_v3", "v3")):
        cal, cv = choose_calibration(val[col].to_numpy(), y)
        p = cal.predict(val[col].to_numpy())
        probs[model] = p
        th = threshold_profiles(y, p, groups)
        write_json(REPORT_DIR / f"calibration_{slug}.json", {"model": model, "selected": cal.method, "cv": cv,
                   "rule": "lowest out-of-fold ECE + Brier", "validationIdsHash": vhash, "n": int(len(y)),
                   "raw_validation": _brief(binary_metrics(y, sigmoid(val[col].to_numpy()), 0.5))})
        write_json(REPORT_DIR / f"threshold_search_{slug}.json", {"model": model, "calibration": cal.method,
                   "profiles": th, "fpr_targets": FPR_TARGETS, "validationIdsHash": vhash})
        prof_path = PROFILE_DIR / f"{model}.json"
        existing = {}
        if prof_path.exists():
            import json
            existing = json.loads(prof_path.read_text(encoding="utf-8"))
        write_json(prof_path, {**existing, "model": model, "calibrationVersion": VERSION, "calibration": cal.to_dict(),
                   "thresholds": {k: v["threshold"] for k, v in th.items()}, "validationIdsHash": vhash,
                   "selectedOn": "VALIDATION only (V1 validation + adversarial validation [+ V2 validation])",
                   "validationMetrics": {k: {kk: v[kk] for kk in ("macro_f1", "recall", "fpr")} for k, v in th.items()}})
        t = low_fp_threshold(y, p)
        candidates[model] = (t, *composite(y, p, t, val))
        log(f"{model}: calibration={cal.method} thresholds={ {k: v['threshold'] for k, v in th.items()} }")
    ens_rows = []
    for method in ("weighted_probability", "weighted_logodds"):
        for w2 in np.round(np.arange(0.0, 1.0001, 0.1), 1):
            p = combine(method, probs["CANDIDATE_MODEL_V2"], probs["CANDIDATE_MODEL_V3"], float(w2))
            t = low_fp_threshold(y, p)
            s, parts = composite(y, p, t, val)
            m = binary_metrics(y, p, t)
            ens_rows.append({"method": method, "w2": float(w2), "w3": float(round(1 - w2, 1)), "threshold_low_fp": t,
                             "score": s, "parts": parts, "macro_f1": m["macro_f1"], "recall": m["recall"], "fpr": m["fpr"]})
    best = max(ens_rows, key=lambda r: r["score"])
    pb = combine(best["method"], probs["CANDIDATE_MODEL_V2"], probs["CANDIDATE_MODEL_V3"], best["w2"])
    ens_th = threshold_profiles(y, pb, groups)
    t2 = low_fp_threshold(y, probs["CANDIDATE_MODEL_V2"])
    t3 = low_fp_threshold(y, probs["CANDIDATE_MODEL_V3"])
    hi2, hi3 = probs["CANDIDATE_MODEL_V2"] >= t2, probs["CANDIDATE_MODEL_V3"] >= t3
    agreement = {
        "HIGH_CONFIDENCE": {"rows": int((hi2 & hi3).sum()), "precision": float(y[hi2 & hi3].mean()) if (hi2 & hi3).any() else None,
                            "fpr": float(((hi2 & hi3) & (y == 0)).sum() / max((y == 0).sum(), 1))},
        "REVIEW": {"rows": int((hi2 ^ hi3).sum()), "machine_share": float(y[hi2 ^ hi3].mean()) if (hi2 ^ hi3).any() else None},
        "LOW_SIGNAL": {"rows": int((~hi2 & ~hi3).sum()), "machine_share": float(y[~hi2 & ~hi3].mean()) if (~hi2 & ~hi3).any() else None},
        "thresholds": {"V2": t2, "V3": t3},
    }
    write_json(PROFILE_DIR / "ENSEMBLE_V2_V3.json", {"model": "ENSEMBLE_V2_V3", "calibrationVersion": VERSION,
               "method": best["method"], "w2": best["w2"], "thresholds": {k: v["threshold"] for k, v in ens_th.items()},
               "validationIdsHash": vhash, "selectedOn": "VALIDATION only", "status": "EXPERIMENTAL (not production)"})
    analyzer_scores = {"V2_ONLY": candidates["CANDIDATE_MODEL_V2"][1], "V3_ONLY": candidates["CANDIDATE_MODEL_V3"][1],
                       "ENSEMBLE": best["score"]}
    recommended = max(analyzer_scores, key=analyzer_scores.get)
    write_json(REPORT_DIR / "ensemble_validation.json", {
        "selection_formula": __doc__.split("ensemble/analyzer score S")[1].split('"""')[0].strip(),
        "validationIdsHash": vhash, "n": int(len(y)), "grid": ens_rows, "best": best, "best_profiles": ens_th,
        "agreement_rule_validation": agreement,
        "analyzer_scores_at_low_false_positive": analyzer_scores,
        "single_model_parts": {k: {"threshold_low_fp": v[0], "parts": v[2]} for k, v in candidates.items()},
        "recommended_analyzer_by_validation": recommended,
    })
    log(f"ensemble best {best['method']} w2={best['w2']} score={best['score']:.4f}; scores {analyzer_scores} -> {recommended}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
