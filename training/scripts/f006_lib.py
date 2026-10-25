"""Shared helpers for F006 (low-FPR targeted fine-tuning of TURNITING_RESEARCH_V3).

Everything here is metadata / metric logic; no text is ever written to logs.

F006_SELECTION_SCORE (fixed BEFORE any F006 training; used for ablation choice and checkpoint selection):

  operating point: threshold t_g = lowest threshold whose FPR on GENERAL validation humans is <= 0.04
  at t_g (all metrics on F006 VALIDATION only):
    S = 0.20*macroF1_general + 0.15*macroF1_spanish + 0.15*macroF1_academic + 0.15*recall_mixed
      + 0.10*macroF1_ai_edited + 0.10*macroF1_ood + 0.15*recall_unseen_generator_proxy
      - 2*max(0, FPR_all_humans - 0.05) - 2*max(0, FPR_spanish - 0.08) - 2*max(0, FPR_academic - 0.05)
      - 2*max(0, FPR_unseen_generator_proxy_humans - 0.10) - 1*max(0, FPR_ood_humans - 0.10)
      - 1*max(0, FPR_unseen_domain_proxy_humans - 0.10)
  (amendment, 2026-10-17, made before any F006-trained checkpoint was evaluated, after seeing only the V3
   reference on F006 validation: the unseen-domain proxy (reports) human FPR term was added because V3 shows
   FPR 0.43 there, i.e. it is the clearest human-shift failure the validation exposes)
  Configurations are eligible only when FPR_all_humans <= 0.05 at t_g; terms with no data are dropped and
  the positive weights renormalised.

Comparing configurations at a fixed general-human FPR removes the trivial effect of class weights /
sampling on the decision threshold: what is compared is recall / F1 at a low-FPR operating point and how
well that FPR holds on the SHIFTED human subsets (Spanish, academic, unseen-generator proxy, OOD).
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd

HUMAN = "HUMAN"
GENERAL_FPR_TARGET = 0.04
SCORE_WEIGHTS = {"general_macro_f1": 0.20, "spanish_macro_f1": 0.15, "academic_macro_f1": 0.15,
                 "mixed_recall": 0.15, "ai_edited_macro_f1": 0.10, "ood_macro_f1": 0.10,
                 "unseen_generator_recall": 0.15}
PENALTIES = [("fpr_all_humans", 0.05, 2.0), ("spanish_fpr", 0.08, 2.0), ("academic_fpr", 0.05, 2.0),
             ("unseen_generator_fpr", 0.10, 2.0), ("ood_fpr", 0.10, 1.0), ("unseen_domain_fpr", 0.10, 1.0)]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def categorical_to_str(df: pd.DataFrame) -> pd.DataFrame:
    for c in df.columns:
        if str(df[c].dtype) == "category":
            df[c] = df[c].astype(str)
    return df


def sha256_ids(ids) -> str:
    h = hashlib.sha256()
    for i in sorted(map(str, ids)):
        h.update(i.encode())
        h.update(b"\n")
    return h.hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=_jdefault))


def _jdefault(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if math.isnan(o) else float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return str(o)


# ------------------------------------------------------------------ intervals

def wilson(k: int, n: int, z: float = 1.96) -> list[float] | None:
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [max(0.0, c - h), min(1.0, c + h)]


def bootstrap_macro_f1(y, pred, n_boot: int = 1000, seed: int = 0) -> list[float] | None:
    y, pred = np.asarray(y), np.asarray(pred)
    if len(y) < 30 or len(set(y)) < 2:
        return None
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(n_boot):
        i = rng.integers(0, len(y), len(y))
        vals.append(_macro_f1(y[i], pred[i]))
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


def _macro_f1(y, pred) -> float:
    out = []
    for c in (0, 1):
        tp = int(((pred == c) & (y == c)).sum())
        fp = int(((pred == c) & (y != c)).sum())
        fn = int(((pred != c) & (y == c)).sum())
        out.append(2 * tp / max(2 * tp + fp + fn, 1))
    return float(np.mean(out))


def metrics(y, p, thr: float, ci: bool = False) -> dict:
    """MACHINE_SIGNAL = positive. Works for single-class subsets (FPR-only / recall-only)."""
    y = np.asarray(y).astype(int)
    p = np.asarray(p, dtype=float)
    pred = (p >= thr).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum()); fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum()); tn = int(((pred == 0) & (y == 0)).sum())
    nh, nm = tn + fp, tp + fn
    out = {"n": int(len(y)), "n_human": nh, "n_machine": nm, "threshold": float(thr),
           "fpr": fp / nh if nh else None, "fnr": fn / nm if nm else None,
           "recall": tp / nm if nm else None, "precision": tp / (tp + fp) if (tp + fp) else None,
           "confusion": {"tn": tn, "fp": fp, "fn": fn, "tp": tp}}
    if nh and nm:
        from sklearn.metrics import average_precision_score, matthews_corrcoef, roc_auc_score
        out["macro_f1"] = _macro_f1(y, pred)
        out["f1"] = 2 * tp / max(2 * tp + fp + fn, 1)
        out["accuracy"] = (tp + tn) / len(y)
        out["roc_auc"] = float(roc_auc_score(y, p))
        out["pr_auc"] = float(average_precision_score(y, p))
        out["mcc"] = float(matthews_corrcoef(y, pred))
        out["brier"] = float(np.mean((p - y) ** 2))
        out["ece"] = ece(y, p)
    else:
        out["macro_f1"] = None
    if ci:
        out["fpr_ci95"] = wilson(fp, nh)
        out["fnr_ci95"] = wilson(fn, nm)
        out["recall_ci95"] = wilson(tp, nm)
        out["macro_f1_ci95"] = bootstrap_macro_f1(y, pred) if nh and nm else None
    return out


def ece(y, p, bins: int = 15) -> float:
    y = np.asarray(y, dtype=float); p = np.asarray(p, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    e = 0.0
    for i in range(bins):
        m = (p >= edges[i]) & ((p < edges[i + 1]) if i < bins - 1 else (p <= edges[i + 1]))
        if m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(e)


# ------------------------------------------------------------------ F006 validation subsets / selection score

def subset_masks(frame: pd.DataFrame) -> dict[str, np.ndarray]:
    """Reporting subsets of an F006 evaluation frame (columns: primary, label, language, domain, hard_human)."""
    pr = frame["primary"].astype(str).values
    es = (frame["language"].astype(str) == "es").values
    aca = (frame["domain"].astype(str) == "academic").values
    human = frame["label"].values == 0
    core = np.isin(pr, ["general", "spanish", "academic"])
    m = {
        "all": np.ones(len(frame), bool),
        "general": pr == "general",
        "spanish": core & es,
        "academic": core & aca,
        "mixed": pr == "mixed",
        "ai_edited": pr == "ai_edited",
        "ood": pr == "ood",
        "unseen_generator": pr == "unseen_generator",
        "unseen_domain": pr == "unseen_domain",
        "adversarial": pr == "adversarial",
        "span": pr == "span",
    }
    m["spanish_academic"] = m["spanish"] & aca
    m["spanish_non_academic"] = m["spanish"] & ~aca
    if "hard_human" in frame:
        m["hard_human"] = frame["hard_human"].fillna(False).values.astype(bool) & human
    lang = frame["language"].astype(str).values
    for l in ("es", "en", "pt", "fr", "de"):  # F006.3 per-language slices (reporting only for older modes)
        m[f"lang_{l}"] = (lang == l) & (pr != "presentation_excluded")
        m[f"academic_{l}"] = core & aca & (lang == l)
    m["language_ood"] = ~np.isin(lang, ["es", "en", "pt", "fr", "de"]) & (pr != "presentation_excluded")
    return m


def threshold_for_fpr(y_h_scores: np.ndarray, target: float) -> float:
    """Exact threshold: the lowest value with FPR (share of these human scores >= t) <= target."""
    s = np.sort(np.asarray(y_h_scores, dtype=float))[::-1]
    if len(s) == 0:
        return 0.5
    k = int(math.floor(target * len(s)))
    if k >= len(s):
        return float(s[-1])
    return float(np.nextafter(s[k], np.inf))


def subset_report(frame: pd.DataFrame, p: np.ndarray, thr: float, ci: bool = False) -> dict:
    y = frame["label"].values
    out = {}
    for name, m in subset_masks(frame).items():
        if m.sum() == 0:
            continue
        out[name] = metrics(y[m], p[m], thr, ci=ci)
    return out


SCORE_MODE = {"mode": "f006"}
F0061_WEIGHTS = {"general_macro_f1": 0.10, "spanish_macro_f1": 0.20, "spanish_recall": 0.10, "academic_macro_f1": 0.10,
                 "mixed_recall": 0.10, "ai_edited_macro_f1": 0.10, "ood_macro_f1": 0.10, "unseen_generator_recall": 0.10,
                 "adversarial_recall": 0.10}
F0061_PENALTIES = [("spanish_fpr", 0.05, 4.0), ("fpr_all_humans", 0.05, 2.0), ("academic_fpr", 0.05, 2.0),
                   ("unseen_generator_fpr", 0.10, 2.0), ("ood_fpr", 0.10, 1.0), ("unseen_domain_fpr", 0.10, 1.0)]


def set_score(mode: str) -> None:
    """'f006' (F006_SELECTION_SCORE) or 'f006_1' (F006_1_SELECTION_SCORE, fixed before any F006.1 training):

    F006_1_SELECTION_SCORE at the same operating point (general-human FPR <= 0.04):
      + 0.10 macroF1 general + 0.20 macroF1 Spanish + 0.10 recall Spanish + 0.10 macroF1 academic + 0.10 recall mixed
      + 0.10 macroF1 AI-edited + 0.10 macroF1 OOD + 0.10 recall unseen-generator proxy + 0.10 recall adversarial
      - 4*max(0, FPR_spanish - 0.05) - 2*max(0, FPR_all - 0.05) - 2*max(0, FPR_academic - 0.05)
      - 2*max(0, FPR_unseen_generator - 0.10) - 1*max(0, FPR_ood - 0.10) - 1*max(0, FPR_unseen_domain - 0.10)
      eligible only if FPR_all <= 0.05 and FPR_spanish <= 0.08.
    """
    SCORE_MODE["mode"] = mode


F00611_WEIGHTS = {"general_macro_f1": 0.10, "spanish_macro_f1": 0.15, "academic_macro_f1": 0.05, "mixed_recall": 0.15,
                  "ai_edited_macro_f1": 0.10, "ood_macro_f1": 0.10, "unseen_generator_recall": 0.10, "adversarial_recall": 0.05,
                  "span_token_f1": 0.20}
F00611_PENALTIES = [("fpr_all_humans", 0.05, 3.0), ("spanish_fpr", 0.05, 3.0), ("academic_fpr", 0.05, 2.0),
                    ("unseen_generator_fpr", 0.10, 2.0), ("ood_fpr", 0.10, 1.0), ("unseen_domain_fpr", 0.10, 1.0)]


def _score_f00611(rep: dict) -> dict:
    """F006_1_1_SELECTION_SCORE (fixed before any F006.1.1 training), same operating point as F006/F006.1:
    + 0.10 F1 general + 0.15 F1 Spanish + 0.05 F1 academic + 0.15 recall mixed + 0.10 F1 AI-edited + 0.10 F1 OOD
    + 0.10 recall unseen-generator proxy + 0.05 recall adversarial + 0.20 span token F1 (head C, span subset)
    - 3*max(0, FPR_all - 0.05) - 3*max(0, FPR_es - 0.05) - 2*max(0, FPR_aca - 0.05) - 2*max(0, FPR_ugen - 0.10)
    - 1*max(0, FPR_ood - 0.10) - 1*max(0, FPR_udom - 0.10); eligible iff FPR_all <= 0.05 and FPR_es <= 0.08."""
    def g(sub, key):
        v = rep.get(sub, {}).get(key)
        return None if v is None else float(v)

    terms = {"general_macro_f1": g("general", "macro_f1"), "spanish_macro_f1": g("spanish", "macro_f1"), "academic_macro_f1": g("academic", "macro_f1"),
             "mixed_recall": g("mixed", "recall"), "ai_edited_macro_f1": g("ai_edited", "macro_f1"), "ood_macro_f1": g("ood", "macro_f1"),
             "unseen_generator_recall": g("unseen_generator", "recall"), "adversarial_recall": g("adversarial", "recall"),
             "span_token_f1": g("span_head", "token_f1")}
    fprs = {"fpr_all_humans": g("all", "fpr"), "spanish_fpr": g("spanish", "fpr"), "academic_fpr": g("academic", "fpr"),
            "unseen_generator_fpr": g("unseen_generator", "fpr"), "ood_fpr": g("ood", "fpr"), "unseen_domain_fpr": g("unseen_domain", "fpr")}
    avail = {k: v for k, v in terms.items() if v is not None}
    wsum = sum(F00611_WEIGHTS[k] for k in avail) or 1.0
    pos = sum(F00611_WEIGHTS[k] * v for k, v in avail.items()) / wsum
    pen = sum(w * max(0.0, fprs[k] - lim) for k, lim, w in F00611_PENALTIES if fprs.get(k) is not None)
    eligible = (fprs["fpr_all_humans"] is not None and fprs["fpr_all_humans"] <= 0.05 and fprs["spanish_fpr"] is not None and fprs["spanish_fpr"] <= 0.08)
    return {"score": pos - pen, "positive": pos, "penalty": pen, "eligible": bool(eligible), "terms": terms, "fprs": fprs, "mode": "f006_1_1"}


F0062_WEIGHTS = {"general_macro_f1": 0.10, "spanish_macro_f1": 0.15, "academic_macro_f1": 0.20, "academic_recall": 0.10, "mixed_recall": 0.10,
                 "ai_edited_macro_f1": 0.05, "ood_recall": 0.10, "unseen_generator_recall": 0.10, "span_token_f1": 0.10}
F0062_PENALTIES = [("academic_fpr", 0.03, 4.0), ("spanish_fpr", 0.05, 3.0), ("fpr_all_humans", 0.05, 3.0), ("unseen_generator_fpr", 0.10, 2.0),
                   ("hard_human_fpr", 0.30, 1.0)]


def _score_f0062(rep: dict) -> dict:
    """F006_2_SELECTION_SCORE (fixed before any F006.2 training), same operating point (general-human FPR <= 0.04):
    + 0.10 F1 general + 0.15 F1 Spanish + 0.20 F1 academic + 0.10 recall academic + 0.10 recall mixed + 0.05 F1 AI-edited
    + 0.10 recall OOD (machine-only) + 0.10 recall unseen-generator proxy + 0.10 span token F1
    - 4*max(0, FPR_aca - 0.03) - 3*max(0, FPR_es - 0.05) - 3*max(0, FPR_all - 0.05) - 2*max(0, FPR_ugen - 0.10) - 1*max(0, FPR_hard - 0.30)
    - 3*max(0, 0.85 - recall_all_machines)   (academic false positives must fall WITHOUT destroying AI recall)
    eligible iff FPR_all <= 0.05, FPR_aca <= 0.05 and FPR_es <= 0.08."""
    def g(sub, key):
        v = rep.get(sub, {}).get(key)
        return None if v is None else float(v)

    terms = {"general_macro_f1": g("general", "macro_f1"), "spanish_macro_f1": g("spanish", "macro_f1"), "academic_macro_f1": g("academic", "macro_f1"),
             "academic_recall": g("academic", "recall"), "mixed_recall": g("mixed", "recall"), "ai_edited_macro_f1": g("ai_edited", "macro_f1"),
             "ood_recall": g("ood", "recall"), "unseen_generator_recall": g("unseen_generator", "recall"), "span_token_f1": g("span_head", "token_f1")}
    fprs = {"fpr_all_humans": g("all", "fpr"), "spanish_fpr": g("spanish", "fpr"), "academic_fpr": g("academic", "fpr"),
            "unseen_generator_fpr": g("unseen_generator", "fpr"), "hard_human_fpr": g("hard_human", "fpr")}
    avail = {k: v for k, v in terms.items() if v is not None}
    wsum = sum(F0062_WEIGHTS[k] for k in avail) or 1.0
    pos = sum(F0062_WEIGHTS[k] * v for k, v in avail.items()) / wsum
    pen = sum(w * max(0.0, fprs[k] - lim) for k, lim, w in F0062_PENALTIES if fprs.get(k) is not None)
    rec = g("all", "recall")
    pen += 3.0 * max(0.0, 0.85 - rec) if rec is not None else 0.0
    eligible = all(fprs[k] is not None and fprs[k] <= lim for k, lim in (("fpr_all_humans", 0.05), ("academic_fpr", 0.05), ("spanish_fpr", 0.08)))
    return {"score": pos - pen, "positive": pos, "penalty": pen, "eligible": bool(eligible), "terms": terms, "fprs": fprs, "recall_all": rec, "mode": "f006_2"}


F0063_WEIGHTS = {"es_macro_f1": 0.14, "en_macro_f1": 0.10, "pt_macro_f1": 0.05, "fr_macro_f1": 0.05, "de_macro_f1": 0.05,
                 "academic_macro_f1": 0.15, "mixed_recall": 0.10, "ai_edited_macro_f1": 0.05, "unseen_generator_recall": 0.15,
                 "ood_recall": 0.06, "span_token_f1": 0.10}
F0063_PENALTIES = [("academic_fpr_es", 0.03, 4.0), ("academic_fpr_en", 0.03, 3.0), ("fpr_all_humans", 0.05, 3.0),
                   ("unseen_generator_fpr", 0.10, 2.0), ("hard_human_fpr", 0.30, 1.0)]


def _score_f0063(rep: dict) -> dict:
    """F006_3_SELECTION_SCORE (fixed before any F006.3 training), same operating point (general-human FPR <= 0.04):
    + 0.14 F1 es + 0.10 F1 en + 0.05 F1 pt/fr/de each + 0.15 F1 academic + 0.10 recall mixed + 0.05 F1 AI-edited
    + 0.15 recall unseen generator + 0.06 recall OOD + 0.10 span token F1
    - 4*max(0, FPR_aca_es - 0.03) - 3*max(0, FPR_aca_en - 0.03) - 3*max(0, FPR_all - 0.05) - 2*max(0, FPR_ugen - 0.10)
    - 1*max(0, FPR_hard - 0.30) - 3*max(0, 0.85 - recall_all_machines)
    eligible iff FPR_all <= 0.05 and academic FPR es / en <= 0.05. The F006.3 GATES (f0063_common.GATES) apply on top."""
    def g(sub, key):
        v = rep.get(sub, {}).get(key)
        return None if v is None else float(v)

    terms = {**{f"{l}_macro_f1": g(f"lang_{l}", "macro_f1") for l in ("es", "en", "pt", "fr", "de")},
             "academic_macro_f1": g("academic", "macro_f1"), "mixed_recall": g("mixed", "recall"), "ai_edited_macro_f1": g("ai_edited", "macro_f1"),
             "unseen_generator_recall": g("unseen_generator", "recall"), "ood_recall": g("ood", "recall"), "span_token_f1": g("span_head", "token_f1")}
    fprs = {"fpr_all_humans": g("all", "fpr"), "academic_fpr_es": g("academic_es", "fpr"), "academic_fpr_en": g("academic_en", "fpr"),
            "unseen_generator_fpr": g("unseen_generator", "fpr"), "hard_human_fpr": g("hard_human", "fpr")}
    avail = {k: v for k, v in terms.items() if v is not None}
    wsum = sum(F0063_WEIGHTS[k] for k in avail) or 1.0
    pos = sum(F0063_WEIGHTS[k] * v for k, v in avail.items()) / wsum
    pen = sum(w * max(0.0, fprs[k] - lim) for k, lim, w in F0063_PENALTIES if fprs.get(k) is not None)
    rec = g("all", "recall")
    pen += 3.0 * max(0.0, 0.85 - rec) if rec is not None else 0.0
    eligible = all(fprs[k] is None or fprs[k] <= lim for k, lim in (("academic_fpr_es", 0.05), ("academic_fpr_en", 0.05))) and \
        fprs["fpr_all_humans"] is not None and fprs["fpr_all_humans"] <= 0.05
    return {"score": pos - pen, "positive": pos, "penalty": pen, "eligible": bool(eligible), "terms": terms, "fprs": fprs, "recall_all": rec, "mode": "f006_3"}


def selection_score(rep: dict) -> dict:
    """F006 / F006_1 / F006_1_1 / F006_2 / F006_3 selection score (see set_score) from a subset_report."""
    if SCORE_MODE["mode"] == "f006_3":
        return _score_f0063(rep)
    if SCORE_MODE["mode"] == "f006_2":
        return _score_f0062(rep)
    if SCORE_MODE["mode"] == "f006_1_1":
        return _score_f00611(rep)
    if SCORE_MODE["mode"] == "f006_1":
        return _score_f0061(rep)
    def g(sub, key):
        v = rep.get(sub, {}).get(key)
        return None if v is None else float(v)

    terms = {"general_macro_f1": g("general", "macro_f1"), "spanish_macro_f1": g("spanish", "macro_f1"),
             "academic_macro_f1": g("academic", "macro_f1"), "mixed_recall": g("mixed", "recall"),
             "ai_edited_macro_f1": g("ai_edited", "macro_f1"), "ood_macro_f1": g("ood", "macro_f1"),
             "unseen_generator_recall": g("unseen_generator", "recall")}
    fprs = {"fpr_all_humans": g("all", "fpr"), "spanish_fpr": g("spanish", "fpr"), "academic_fpr": g("academic", "fpr"),
            "unseen_generator_fpr": g("unseen_generator", "fpr"), "ood_fpr": g("ood", "fpr"),
            "unseen_domain_fpr": g("unseen_domain", "fpr")}
    avail = {k: v for k, v in terms.items() if v is not None}
    wsum = sum(SCORE_WEIGHTS[k] for k in avail) or 1.0
    pos = sum(SCORE_WEIGHTS[k] * v for k, v in avail.items()) / wsum
    pen = sum(w * max(0.0, fprs[k] - lim) for k, lim, w in PENALTIES if fprs.get(k) is not None)
    eligible = fprs["fpr_all_humans"] is not None and fprs["fpr_all_humans"] <= 0.05
    return {"score": pos - pen, "positive": pos, "penalty": pen, "eligible": bool(eligible), "terms": terms, "fprs": fprs}


def _score_f0061(rep: dict) -> dict:
    def g(sub, key):
        v = rep.get(sub, {}).get(key)
        return None if v is None else float(v)

    terms = {"general_macro_f1": g("general", "macro_f1"), "spanish_macro_f1": g("spanish", "macro_f1"), "spanish_recall": g("spanish", "recall"),
             "academic_macro_f1": g("academic", "macro_f1"), "mixed_recall": g("mixed", "recall"), "ai_edited_macro_f1": g("ai_edited", "macro_f1"),
             "ood_macro_f1": g("ood", "macro_f1"), "unseen_generator_recall": g("unseen_generator", "recall"), "adversarial_recall": g("adversarial", "recall")}
    fprs = {"fpr_all_humans": g("all", "fpr"), "spanish_fpr": g("spanish", "fpr"), "academic_fpr": g("academic", "fpr"),
            "unseen_generator_fpr": g("unseen_generator", "fpr"), "ood_fpr": g("ood", "fpr"), "unseen_domain_fpr": g("unseen_domain", "fpr")}
    avail = {k: v for k, v in terms.items() if v is not None}
    wsum = sum(F0061_WEIGHTS[k] for k in avail) or 1.0
    pos = sum(F0061_WEIGHTS[k] * v for k, v in avail.items()) / wsum
    pen = sum(w * max(0.0, fprs[k] - lim) for k, lim, w in F0061_PENALTIES if fprs.get(k) is not None)
    eligible = (fprs["fpr_all_humans"] is not None and fprs["fpr_all_humans"] <= 0.05
                and fprs["spanish_fpr"] is not None and fprs["spanish_fpr"] <= 0.08)
    return {"score": pos - pen, "positive": pos, "penalty": pen, "eligible": bool(eligible), "terms": terms, "fprs": fprs, "mode": "f006_1"}


def evaluate_scores(frame: pd.DataFrame, p: np.ndarray, ci: bool = False) -> dict:
    """Operating point at GENERAL human FPR <= 0.04, subset metrics and the selection score."""
    m = subset_masks(frame)
    gh = m["general"] & (frame["label"].values == 0)
    thr = threshold_for_fpr(p[gh], GENERAL_FPR_TARGET)
    rep = subset_report(frame, p, thr, ci=ci)
    return {"threshold_general_fpr_0.04": thr, "subsets": rep, "selection": selection_score(rep)}


def profile_thresholds(frame: pd.DataFrame, p: np.ndarray) -> dict:
    """F005-compatible threshold profiles chosen on F006 VALIDATION only (any score space).

    BALANCED: best F006_SELECTION_SCORE among operating points whose FPR on ALL validation humans <= 0.05
              (candidates: exact thresholds for FPR = 0.000, 0.001, ..., 0.050).
    LOW_FALSE_POSITIVE: FPR(all validation humans) <= 0.03.
    VERY_LOW_FALSE_POSITIVE: FPR(all validation humans) <= 0.02.
    """
    y = frame["label"].values
    hs = p[y == 0]
    best, best_s = None, -1e9
    for f in np.round(np.arange(0.0, 0.0501, 0.001), 3):
        t = threshold_for_fpr(hs, float(f))
        s = selection_score(subset_report(frame, p, t))["score"]
        if s > best_s:
            best, best_s = t, s
    out = {}
    for name, t in (("BALANCED", best), ("LOW_FALSE_POSITIVE", threshold_for_fpr(hs, 0.03)),
                    ("VERY_LOW_FALSE_POSITIVE", threshold_for_fpr(hs, 0.02))):
        rep = subset_report(frame, p, t)
        out[name] = {"threshold": float(t), "fpr": rep["all"]["fpr"], "recall": rep["all"]["recall"],
                     "macro_f1": rep["all"].get("macro_f1"), "selection_score": selection_score(rep)["score"]}
    out["BALANCED"]["constraint"] = "max F006_SELECTION_SCORE s.t. FPR(all validation humans)<=0.05"
    out["LOW_FALSE_POSITIVE"]["constraint"] = "FPR(all validation humans)<=0.03"
    out["VERY_LOW_FALSE_POSITIVE"]["constraint"] = "FPR(all validation humans)<=0.02"
    return out
