"""F006.1: global vs Spanish-specific calibration / thresholds, chosen on F006_1 VALIDATION only (group 2-fold OOF).

    python scripts/f006_1_calib.py                     # pre-training study for V3 and EXPERIMENTAL_F006_MODEL
    (study() is reused by f006_1_lock.py for the F006.1 checkpoint)

Options compared (Spanish = dataset language metadata 'es'; at inference a reproducible local language detector
must supply it, with the global profile as fallback):
  A  GLOBAL     : one isotonic calibrator + one threshold for every document
  B  ES_ISO     : global isotonic for non-Spanish, Spanish-only isotonic for Spanish, one threshold
  C  ES_PLATT   : global isotonic for non-Spanish, Spanish-only Platt for Spanish, one threshold
  D  ES_THRESH  : global isotonic, plus a Spanish-specific threshold (lowest with Spanish human FPR <= 0.05)
Thresholds: global = lowest with FPR(all validation humans) <= 0.05; Spanish (D only) = lowest with Spanish human FPR <= 0.05.
Metrics are out-of-fold (fit on one half of the validation groups, measured on the other), so the comparison
does not reward over-fitting the validation itself. Selection: lowest out-of-fold Spanish FPR among options with
FPR_all <= 0.05, Spanish FPR <= 0.08 and Spanish recall within 0.05 of the best option; ties -> simpler option.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import ece, log, metrics, threshold_for_fpr, write_json  # noqa: E402
from turniting_train.calibration import Calibrator  # noqa: E402
from turniting_train.splits import unit_hash  # noqa: E402

D6 = Path("/content/drive/MyDrive/turniting/f006")
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
V3D = Path("/content/drive/MyDrive/turniting/v3")
REPO = Path(__file__).resolve().parents[1]
OPTIONS = ["GLOBAL", "GLOBAL_PLATT", "ES_ISO", "ES_PLATT", "ES_THRESH"]
COMPLEXITY = {"GLOBAL": 0, "GLOBAL_PLATT": 0, "ES_THRESH": 1, "ES_PLATT": 2, "ES_ISO": 3}


def fit(option: str, lg: np.ndarray, y: np.ndarray, es: np.ndarray) -> dict:
    g = Calibrator("platt" if option == "GLOBAL_PLATT" else "isotonic").fit(lg, y)
    cfg = {"option": option, "global": g.to_dict()}
    if option in ("ES_ISO", "ES_PLATT") and es.sum() > 50 and len(set(y[es])) == 2:
        cfg["spanish"] = Calibrator("isotonic" if option == "ES_ISO" else "platt").fit(lg[es], y[es]).to_dict()
    p = apply(cfg, lg, es)
    hs_all, hs_es = p[(y == 0)], p[(y == 0) & es]
    cfg["threshold_global"] = threshold_for_fpr(hs_all, 0.05)
    cfg["threshold_spanish"] = threshold_for_fpr(hs_es, 0.05) if option == "ES_THRESH" else cfg["threshold_global"]
    return cfg


def apply(cfg: dict, lg: np.ndarray, es: np.ndarray) -> np.ndarray:
    p = Calibrator.from_dict(cfg["global"]).predict(lg)
    if "spanish" in cfg:
        p = p.copy()
        p[es] = Calibrator.from_dict(cfg["spanish"]).predict(lg[es])
    return p


def decide(cfg: dict, p: np.ndarray, es: np.ndarray) -> np.ndarray:
    thr = np.where(es, cfg["threshold_spanish"], cfg["threshold_global"])
    return (p >= thr).astype(int)


def evaluate(frame: pd.DataFrame, p: np.ndarray, pred: np.ndarray) -> dict:
    y, es = frame["label"].values, (frame["language"] == "es").values
    out = {}
    for name, m in (("all", np.ones(len(y), bool)), ("spanish", es), ("non_spanish", ~es),
                    ("spanish_academic", es & (frame["domain"] == "academic").values)):
        if m.sum() == 0:
            continue
        # metrics() thresholds a score; feed the decision as a 0/1 score with threshold 0.5
        r = metrics(y[m], pred[m].astype(float), 0.5, ci=True)
        r["ece"] = ece(y[m], p[m]) if len(set(y[m])) else None
        r["brier"] = float(np.mean((p[m] - y[m]) ** 2))
        out[name] = r
    return out


def study(frame: pd.DataFrame, lg: np.ndarray) -> dict:
    y, es = frame["label"].values, (frame["language"] == "es").values
    fold = np.array([unit_hash(str(g), 616) < 0.5 for g in frame["group_id"]])
    res = {}
    for opt in OPTIONS:
        p_oof, pred_oof = np.zeros(len(y)), np.zeros(len(y), int)
        for k in (True, False):
            tr, te = fold == k, fold != k
            cfg = fit(opt, lg[tr], y[tr], es[tr])
            p_oof[te] = apply(cfg, lg[te], es[te])
            pred_oof[te] = decide(cfg, p_oof[te], es[te])
        res[opt] = {"oof": evaluate(frame, p_oof, pred_oof), "final_fit": fit(opt, lg, y, es)}
    ok = {o: r for o, r in res.items() if (r["oof"]["all"]["fpr"] or 1) <= 0.05 and (r["oof"]["spanish"]["fpr"] or 1) <= 0.08}
    pool = ok or res
    best_rec = max(r["oof"]["spanish"]["recall"] or 0 for r in pool.values())
    near = {o: r for o, r in pool.items() if (r["oof"]["spanish"]["recall"] or 0) >= best_rec - 0.05}
    chosen = min(near, key=lambda o: (round(near[o]["oof"]["spanish"]["fpr"], 3), COMPLEXITY[o]))
    return {"options": res, "eligible": sorted(ok), "chosen": chosen, "rule": __doc__.split("Selection:")[1].strip().split("\n")[0]}


def main() -> int:
    import torch
    from transformers import AutoTokenizer

    from f006_score import doc_logits
    from turniting_train.v3model import V3Detector

    lock = json.loads((D6 / "manifests" / "F006_MODEL_LOCK.json").read_text())
    val = pd.read_parquet(D61 / "datasets" / "f006_1_validation.parquet")
    out = {"set": "F006_1_VALIDATION (out-of-fold, group 2-fold)", "models": {}}
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    for name, mdir in (("CANDIDATE_MODEL_V3", V3D / "models" / "spanish_academic"), ("EXPERIMENTAL_F006_MODEL", Path(lock["modelPath"]))):
        m = V3Detector.load(mdir, dev)
        tok = AutoTokenizer.from_pretrained(mdir / "backbone")
        icfg = json.loads((mdir / "inference_config.json").read_text())
        lg = doc_logits(m, tok, val["text_original"].tolist(), icfg.get("view", "canonical"), icfg.get("aggregation", "mean"), 8, device=dev)
        del m
        torch.cuda.empty_cache()
        (D61 / "runs").mkdir(parents=True, exist_ok=True)
        pd.DataFrame({"id": val["id"], "logit": lg}).to_parquet(D61 / "runs" / f"{name}_validation_logits.parquet", index=False)
        st = study(val, lg)
        out["models"][name] = {o: {"oof": {k: {m_: v.get(m_) for m_ in ("n", "n_human", "fpr", "fpr_ci95", "recall", "macro_f1", "ece", "brier")}
                                          for k, v in r["oof"].items()},
                                   "thresholds": {"global": r["final_fit"]["threshold_global"], "spanish": r["final_fit"]["threshold_spanish"]}}
                               for o, r in st["options"].items()}
        out["models"][name]["chosen"] = st["chosen"]
        out["models"][name]["eligible"] = st["eligible"]
        log(f"{name}: chosen {st['chosen']}; Spanish OOF FPR " + json.dumps({o: round(r['oof']['spanish']['fpr'], 4) for o, r in st['options'].items()}))
    write_json(D61 / "reports" / "calibration_pretraining.json", out)
    write_json(REPO / "reports" / "f006_1" / "calibration_pretraining.json", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
