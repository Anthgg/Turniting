"""F006.3: calibrate (CALIBRATION), compare candidates against the PRE-REGISTERED GATES (VALIDATION), MODEL_LOCK, single FINAL evaluation.

    python scripts/f0063_lockeval.py compare --runs F0063_B1 F0063_B2 F0063_B3 F0063_B4 F0063_B5
    python scripts/f0063_lockeval.py lock
    python scripts/f0063_lockeval.py final

* Every model (EXPERIMENTAL_F006_1_1_MODEL = primary baseline, F006.2 Candidate A and Candidate B = comparisons, each B1-B5) gets the
  same treatment: calibration + thresholds on F006_3 CALIBRATION only (f006_1_calib.study), then measured on F006_3 VALIDATION.
* Per-language metrics (es / en / pt / fr / de + language OOD it / nl), academic FPR es / en, unseen-generator recall (OLMo-2 proxy),
  MIXED_LANGUAGE metrics on the mixed-language documents (section level, references excluded; HUMAN-document false-flag rate).
* Gates = f0063_common.GATES, fixed before training; selection = F006_3_SELECTION_SCORE among gate-passing candidates.
  If none passes every gate: GATES rule_if_none_pass (lock the best forgetting-safe candidate flagged GATES_FAILED, else NO_MODEL_LOCK).
* F006_3_FINAL_EXTERNAL_HOLDOUT is read only by `final`, once. REGRESSION_HOLDOUTs (F006.2 final, F006.1.1 final) for continuity only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f0063_common import CKPT, D, D611, D62, F611_MODEL, F62_A, F62_B, FINAL, GATES, LANGS, MANI, MIXED, REPO, SPLITS, write_json  # noqa: E402
from f006_1_calib import apply, decide, study  # noqa: E402
from f006_1_final_eval import Model, full, report  # noqa: E402
from f006_lib import log, selection_score, set_score, sha256_file  # noqa: E402
from f006_lock import model_hash  # noqa: E402

RUNS = CKPT / "runs"
LOCK = MANI / "F006_3_MODEL_LOCK.json"
DONE = MANI / "F006_3_FINAL_EVAL_DONE.json"
BASE = "EXPERIMENTAL_F006_1_1_MODEL"
REFS = {BASE: F611_MODEL, "F006_2_CANDIDATE_A": F62_A, "F006_2_CANDIDATE_B": F62_B}


def logits(path: Path, frame: pd.DataFrame) -> np.ndarray:
    import torch
    from transformers import AutoTokenizer

    from f006_score import doc_logits
    from turniting_train.v3model import V3Detector

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = V3Detector.load(path, dev)
    tok = AutoTokenizer.from_pretrained(path / "backbone")
    icfg = json.loads((path / "inference_config.json").read_text()) if (path / "inference_config.json").exists() else \
        json.loads((F611_MODEL / "inference_config.json").read_text())
    lg = doc_logits(m, tok, frame["text_original"].tolist(), icfg.get("view", "canonical"), icfg.get("aggregation", "mean"), 8, device=dev)
    del m
    torch.cuda.empty_cache()
    return lg


def mixed_language(md: pd.DataFrame, p: np.ndarray, pred: np.ndarray) -> dict:
    """Mixed-language documents: section-level metrics (references never scored) + document-level false-flag rate of HUMAN docs.
    A human section in another language must not be flagged: language change is not an AI signal."""
    y = md["label"].astype(int).values
    sec = full(y, p, pred)
    d = md.assign(pred=pred)
    doc = d.groupby("parent_document_id").agg(doc_label=("doc_label", "first"), any_flag=("pred", "max"))
    hum = doc[doc["doc_label"] == "HUMAN"]
    mixd = doc[doc["doc_label"] == "MIXED"]
    foreign = (md["language"] != md["document_language_primary"]).values & (y == 0)
    return {"section": sec, "MIXED_LANGUAGE_F1": sec.get("macro_f1"), "human_documents": int(len(hum)), "mixed_documents": int(len(mixd)),
            "HUMAN_DOC_FALSE_FLAG_RATE": float(hum["any_flag"].mean()) if len(hum) else None,
            "MIXED_DOC_DETECTION_RATE": float(mixd["any_flag"].mean()) if len(mixd) else None,
            "FOREIGN_LANGUAGE_HUMAN_SECTION_FPR": float(pred[foreign].mean()) if foreign.any() else None,
            "QUOTATION_FPR": float(pred[(md["section_type"] == "QUOTATION").values].mean()) if (md["section_type"] == "QUOTATION").any() else None}


def mixed_frame(side: str) -> pd.DataFrame:
    md = pd.read_parquet(MIXED / f"mixed_documents_{side}.parquet")
    md = md[(md["cls"] != "PRESENTATION_EXCLUDED") & md["label"].notna()].copy()
    md["label"] = (md["fine_label"] != "HUMAN").astype(int)
    return md.reset_index(drop=True)


def per_language(rep: dict) -> dict:
    out = {}
    for l in LANGS:
        r = rep.get(f"lang_{l}", {})
        out[l] = {"macro_f1": r.get("macro_f1"), "fpr": r.get("fpr"), "recall": r.get("recall"), "n": r.get("n")}
    out["language_ood"] = {k: rep.get("language_ood", {}).get(k) for k in ("macro_f1", "fpr", "recall", "n")}
    return out


def calibrated_eval(name: str, path: Path, cal: pd.DataFrame, val: pd.DataFrame, mdv: pd.DataFrame) -> dict:
    lc, lv, lm = logits(path, cal), logits(path, val), logits(path, mdv)
    st = study(cal, lc)
    cfg = st["options"][st["chosen"]]["final_fit"]
    es, esm = (val["language"] == "es").values, (mdv["language"] == "es").values
    p = apply(cfg, lv, es)
    pred = decide(cfg, p, es)
    pm = apply(cfg, lm, esm)
    predm = decide(cfg, pm, esm)
    rep = report(val, p, pred)
    sub = {k: v for k, v in rep.items() if isinstance(v, dict)}
    sel = selection_score(sub)
    hist = (val["origin"] == "f006_1_1_validation").values
    y = val["label"].values
    out = {"name": name, "path": str(path), "calibration": {"chosen": st["chosen"], "eligible": st["eligible"], "config": cfg},
           "validation": rep, "selection": sel, "per_language": per_language(sub), "mixed_language": mixed_language(mdv, pm, predm),
           "historical_part": full(y[hist], p[hist], pred[hist]), "new_part": full(y[~hist], p[~hist], pred[~hist]),
           "academic_fpr": {l: sub.get(f"academic_{l}", {}).get("fpr") for l in ("es", "en")},
           "by_dataset": {ds: full(y[(val["dataset"] == ds).values], p[(val["dataset"] == ds).values], pred[(val["dataset"] == ds).values])
                          for ds in sorted(val["dataset"].astype(str).unique()) if (val["dataset"] == ds).sum() >= 50}}
    pd.DataFrame({"id": val["id"], "logit": lv, "p": p, "pred": pred}).to_parquet(D / "reports" / f"{name}_validation_scores.parquet", index=False)
    return out


def gates(b: dict, v: dict) -> dict:
    """F006_3_GATES (f0063_common.GATES), unchanged after training."""
    hb, hv = b["historical_part"], v["historical_part"]
    pp = lambda x: None if x is None else 100.0 * x  # noqa: E731
    f1_drop = pp((hb.get("macro_f1") or 0) - (hv.get("macro_f1") or 0))
    fpr_rise = pp((hv.get("fpr") or 0) - (hb.get("fpr") or 0))
    nv, nb = v["new_part"], b["new_part"]
    ug_b, ug_v = b["validation"].get("unseen_generator", {}).get("recall"), v["validation"].get("unseen_generator", {}).get("recall")
    aca_b, aca_v = b["validation"].get("academic", {}).get("fpr"), v["validation"].get("academic", {}).get("fpr")
    g = {"forgetting_macro_f1": {"drop_pp": f1_drop, "max": GATES["historical_forgetting_macro_f1_pp_max"]},
         "forgetting_fpr": {"rise_pp": fpr_rise, "max": GATES["historical_fpr_rise_pp_max"]},
         "unseen_generator_recall": {"candidate": ug_v, "baseline": ug_b}, "macro_f1": {"candidate": nv.get("macro_f1"), "baseline": nb.get("macro_f1")},
         "academic_fpr": {"candidate": aca_v, "baseline": aca_b}, "per_language": {}, "mixed_language": {}}
    g["forgetting_macro_f1"]["pass"] = f1_drop <= GATES["historical_forgetting_macro_f1_pp_max"]
    g["forgetting_fpr"]["pass"] = fpr_rise <= GATES["historical_fpr_rise_pp_max"]
    g["unseen_generator_recall"]["pass"] = ug_v is not None and ug_b is not None and ug_v >= ug_b
    g["macro_f1"]["pass"] = (nv.get("macro_f1") or 0) >= (nb.get("macro_f1") or 0)
    g["academic_fpr"]["pass"] = aca_v is not None and aca_b is not None and aca_v <= aca_b
    for l, lim in GATES["per_language_f1_drop_pp_max"].items():
        fb, fv = b["per_language"][l]["macro_f1"], v["per_language"][l]["macro_f1"]
        drop = None if fb is None or fv is None else pp(fb - fv)
        g["per_language"][l] = {"drop_pp": drop, "max": lim, "pass": drop is not None and drop <= lim}
    mb, mv = b["mixed_language"]["MIXED_LANGUAGE_F1"], v["mixed_language"]["MIXED_LANGUAGE_F1"]
    mdrop = None if mb is None or mv is None else pp(mb - mv)
    g["mixed_language"] = {"drop_pp": mdrop, "max": GATES["mixed_language_f1_drop_pp_max"], "pass": mdrop is not None and mdrop <= GATES["mixed_language_f1_drop_pp_max"]}
    g["forgetting_pass"] = bool(g["forgetting_macro_f1"]["pass"] and g["forgetting_fpr"]["pass"])
    g["all_pass"] = bool(g["forgetting_pass"] and g["unseen_generator_recall"]["pass"] and g["macro_f1"]["pass"] and g["academic_fpr"]["pass"]
                         and all(x["pass"] for x in g["per_language"].values()) and g["mixed_language"]["pass"])
    return g


def compare(runs: list[str]) -> int:
    set_score("f006_3")
    cal = pd.read_parquet(SPLITS / "f006_3_calibration.parquet")
    val = pd.read_parquet(SPLITS / "f006_3_validation.parquet")
    mdv = mixed_frame("val")
    res = {k: calibrated_eval(k, p, cal, val, mdv) for k, p in REFS.items() if p.exists()}
    for r in runs:
        rd = RUNS / r
        if not (rd / "run.json").exists():
            log(f"{r}: not finished; skipped")
            continue
        res[r] = calibrated_eval(r, rd / "best", cal, val, mdv)
        res[r]["run"] = {k: v for k, v in json.loads((rd / "run.json").read_text()).items() if k in ("config", "best", "stoppedAtStep", "totalSteps",
                                                                                                 "trainSeconds", "microBatch", "accumulation", "hardware", "init", "gitCommit")}
    b = res[BASE]
    for k, v in res.items():
        if k != BASE:
            v["gates"] = gates(b, v)
    cands = {k: v for k, v in res.items() if k in runs}
    passing = {k: v for k, v in cands.items() if v["gates"]["all_pass"] and v["selection"]["eligible"]}
    chosen, status = None, None
    if passing:
        chosen, status = max(passing, key=lambda k: passing[k]["selection"]["score"]), "GATES_PASSED"
    else:
        safe = {k: v for k, v in cands.items() if v["gates"]["forgetting_pass"]}
        if safe:
            chosen, status = max(safe, key=lambda k: safe[k]["selection"]["score"]), "GATES_FAILED"
        else:
            status = "NO_MODEL_LOCK"
    summary = {"chosen": chosen, "status": status, "rule": GATES["rule_if_none_pass"], "gates_definition": GATES,
               "improves_over_baseline_on_validation": bool(chosen and res[chosen]["selection"]["score"] > b["selection"]["score"]),
               "scores": {k: {"score": v["selection"]["score"], "eligible": v["selection"]["eligible"], "gates_all_pass": v.get("gates", {}).get("all_pass"),
                              "forgetting_pass": v.get("gates", {}).get("forgetting_pass")} for k, v in res.items()}}
    write_json(D / "reports" / "validation_comparison.json", {"summary": summary, "models": res})
    write_json(REPO / "reports" / "f006_3" / "validation_comparison.json", {"summary": summary, "models": res})
    log("compare: " + json.dumps(summary["scores"]))
    log(f"chosen: {chosen} ({status})")
    return 0


def lock() -> int:
    if LOCK.exists():
        lk = json.loads(LOCK.read_text())
        assert model_hash(Path(lk["modelPath"])) == lk["modelSha256"]
        log("lock exists and verifies")
        return 0
    comp = json.loads((D / "reports" / "validation_comparison.json").read_text())
    chosen, status = comp["summary"]["chosen"], comp["summary"]["status"]
    if not chosen:
        write_json(MANI / "F006_3_NO_MODEL_LOCK.json", {"reason": "no candidate passes the forgetting gate", "summary": comp["summary"]})
        log("NO_MODEL_LOCK: no candidate passes the forgetting gate; FINAL evaluates the baselines only")
        return 0
    r = comp["models"][chosen]
    mdir = FINAL / "f006_3_locked"
    if mdir.exists():
        shutil.rmtree(mdir)
    shutil.copytree(RUNS / chosen / "best", mdir)
    cfg = r["calibration"]["config"]
    write_json(mdir / "calibration.json", {"selected": cfg["global"], "spanish": cfg.get("spanish"), "option": cfg["option"]})
    write_json(mdir / "thresholds.json", {"BALANCED": {"threshold": cfg["threshold_global"]}, "GLOBAL_THRESHOLD": cfg["threshold_global"],
                                          "SPANISH_THRESHOLD": cfg["threshold_spanish"], "space": "calibrated", "chosen_on": "F006_3_CALIBRATION"})
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    write_json(mdir / "model_manifest.json", {"modelVersion": "F006_3_MULTILINGUAL_ACADEMIC_HARDENING", "parentModel": "F006_2_CANDIDATE_B",
                                              "status": "LOCKED_PENDING_EVALUATION", "gateStatus": status, "gitCommit": commit,
                                              "notTurnitin": "Independent research detector; never a Turnitin score."})
    run = json.loads((RUNS / chosen / "run.json").read_text())
    lk = {"name": "F006_3_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "modelPath": str(mdir),
          "modelSha256": model_hash(mdir), "candidate": chosen, "gateStatus": status, "checkpointStep": run["best"]["step"], "initFrom": run["init"],
          "calibration": cfg, "datasetManifestSha256": {k: sha256_file(MANI / f) for k, f in (("final", "f006_3_final_external_holdout.json"),
                                                                                             ("validation", "f006_3_validation.json"), ("calibration", "f006_3_calibration.json"),
                                                                                             ("train_extra", "f006_3_train_extra.json"))},
          "trainingConfig": run["config"], "trainingConfigSha256": hashlib.sha256(json.dumps(run["config"], sort_keys=True, default=str).encode()).hexdigest(),
          "seed": run["config"]["seed"], "trainingCodeCommit": run["gitCommit"], "lockCodeCommit": commit}
    write_json(LOCK, lk)
    write_json(REPO / "reports" / "f006_3" / "model_lock.json", lk)
    log(f"MODEL_LOCK {chosen} ({status}) {lk['modelSha256'][:16]}")
    return 0


def dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def final() -> int:
    if DONE.exists():
        log("FINAL_EXTERNAL_HOLDOUT already evaluated once; refusing")
        return 0
    hman = json.loads((MANI / "f006_3_final_external_holdout.json").read_text())
    hp = SPLITS / "f006_3_final_external_holdout.parquet"
    assert sha256_file(hp) == hman["holdout_file_sha256"], "holdout changed"
    assert sha256_file(MIXED / "mixed_documents_final.parquet") == hman["mixed_documents_file_sha256"], "mixed final changed"
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    comp = json.loads((D / "reports" / "validation_comparison.json").read_text())
    lk = json.loads(LOCK.read_text()) if LOCK.exists() else None
    models = {k: (p, comp["models"][k]["calibration"]["config"]) for k, p in REFS.items() if k in comp["models"]}
    if lk:
        assert model_hash(Path(lk["modelPath"])) == lk["modelSha256"], "locked model changed"
        assert lk["lockedAt"] < started
        models = {"EXPERIMENTAL_F006_3_MODEL": (Path(lk["modelPath"]), lk["calibration"]), **models}
    hold = pd.read_parquet(hp)
    mdf = mixed_frame("final")
    regs = {"F006_2_FINAL_EXTERNAL_HOLDOUT": pd.read_parquet(D62 / "datasets" / "splits" / "f006_2_final_external_holdout.parquet"),
            "F006_1_1_FINAL_HOLDOUT": pd.read_parquet(D611 / "datasets" / "f006_1_1_final_holdout.parquet")}
    y = hold["label"].values
    hum = y == 0
    aca = (hold["domain"].astype(str) == "academic").values
    out = {"set": "F006_3_FINAL_EXTERNAL_HOLDOUT", "evaluatedAt": started, "lockedAt": lk["lockedAt"] if lk else None, "docs": int(len(hold)),
           "gateStatus": lk["gateStatus"] if lk else "NO_MODEL_LOCK", "models": {}}
    for name, (path, cfg) in models.items():
        m = Model(path, cfg)
        p, pred = m.run(hold)
        sub = report(hold, p, pred)
        lang = hold["language"].astype(str).values
        spec = {"ALL": np.ones(len(y), bool), "UNSEEN_GENERATOR": (hold["primary"] == "unseen_generator").values | hum,
                "LANGUAGE_OOD": ~np.isin(lang, LANGS), **{f"LANG_{l.upper()}": lang == l for l in LANGS},
                "ACADEMIC_ES": aca & (lang == "es"), "ACADEMIC_EN": aca & (lang == "en"),
                "MIXED": (hold["fine_label"] == "MIXED").values, "AI_EDITED": hold["fine_label"].isin(["AI_EDITED", "PARAPHRASED_AI"]).values}
        sets = {k: full(y[v], p[v], pred[v]) for k, v in spec.items() if v.sum()}
        pm, predm = m.run(mdf)
        reg = {}
        for rn, rf in regs.items():
            rp, rpred = m.run(rf)
            reg[rn] = {s: v for s, v in report(rf, rp, rpred).items() if s in ("all", "spanish", "academic", "mixed", "unseen_generator", "ood")}
        out["models"][name] = {"calibration_option": cfg["option"], "threshold_global": cfg["threshold_global"], "sets": sets, "subsets": sub,
                               "mixed_language": mixed_language(mdf, pm, predm), "regression_holdouts": reg}
        log(f"{name}: FINAL macro F1 {sets['ALL'].get('macro_f1')} FPR {sets['ALL'].get('fpr')}")
        del m
    write_json(D / "reports" / "final_external_holdout.json", out)
    write_json(REPO / "reports" / "f006_3" / "final_external_holdout.json", out)
    if lk:
        mdl = FINAL / "experimental_f006_3"
        if mdl.exists():
            shutil.rmtree(mdl)
        shutil.copytree(Path(lk["modelPath"]), mdl)
        mm = json.loads((mdl / "model_manifest.json").read_text())
        mm.update({"status": "EXPERIMENTAL", "modelVersion": "EXPERIMENTAL_F006_3_MODEL", "active": False, "promoted": False})
        write_json(mdl / "model_manifest.json", mm)
        regy = {"name": "EXPERIMENTAL_F006_3_MODEL", "status": "EXPERIMENTAL", "active": False, "promoted": False, "storage_provider": "GOOGLE_DRIVE",
                "logical_path": "MyDrive/turniting/f006_3/models/final/experimental_f006_3", "SHA256": lk["modelSha256"], "size_bytes": dir_size(mdl),
                "training_phase": "F006_3", "parent_model": "F006_2_CANDIDATE_B", "baseline": BASE, "candidate": lk["candidate"],
                "gate_status": lk["gateStatus"], "dataset_manifest_hash": lk["datasetManifestSha256"], "training_config_hash": lk["trainingConfigSha256"]}
        write_json(MANI / "model_registry_f006_3.json", regy)
        write_json(REPO / "datasets" / "manifests" / "model_registry_f006_3.json", regy)
    write_json(DONE, {"evaluatedAt": started, "status": "EXPERIMENTAL", "FINAL_HOLDOUT_TUNING": "NO"})
    log("FINAL F006.3 evaluated once; everything EXPERIMENTAL")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["compare", "lock", "final"])
    ap.add_argument("--runs", nargs="*", default=[f"F0063_B{i}" for i in range(1, 6)])
    a = ap.parse_args()
    return {"compare": lambda: compare(a.runs), "lock": lock, "final": final}[a.cmd]()


if __name__ == "__main__":
    raise SystemExit(main())
