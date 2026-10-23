"""F006.2: calibrate (CALIBRATION), compare candidates (VALIDATION), MODEL_LOCK, and the single FINAL_EXTERNAL_HOLDOUT evaluation.

    python scripts/f0062_lockeval.py compare --runs F0062_A F0062_B
    python scripts/f0062_lockeval.py lock
    python scripts/f0062_lockeval.py final

* Every model (baseline EXPERIMENTAL_F006_1_1_MODEL and each candidate) gets the same treatment: calibration + thresholds fitted
  on F006_2 CALIBRATION only (f006_1_calib.study, group 2-fold OOF), then measured on F006_2 VALIDATION.
* Selection on VALIDATION with F006_2_SELECTION_SCORE (f006_lib, fixed before training). Catastrophic-forgetting check on the
  historical part of VALIDATION (F006.1.1 validation groups): a candidate whose historical macro F1 drops > 1 pp or whose historical
  human FPR rises > 1 pp vs the baseline is not selectable. Candidate B (replay) wins ties within 0.005.
* FINAL_EXTERNAL_HOLDOUT is read only by `final`, once, after the lock; a second call refuses. The REGRESSION_HOLDOUT
  (F006.1.1 final holdout, already observed) is reported for continuity only.
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

from f0062_common import CKPT, D, D611, F611_MODEL, FINAL, MANI, REPO, SPLITS, write_json  # noqa: E402
from f006_1_calib import apply, decide, study  # noqa: E402
from f006_1_final_eval import Model, full, report  # noqa: E402
from f006_lib import evaluate_scores, log, selection_score, set_score, sha256_file  # noqa: E402
from f006_lock import model_hash  # noqa: E402

RUNS = CKPT / "runs"
LOCK = MANI / "F006_2_MODEL_LOCK.json"
DONE = MANI / "F006_2_FINAL_EVAL_DONE.json"


def logits(path: Path, frame: pd.DataFrame) -> np.ndarray:
    import torch
    from transformers import AutoTokenizer

    from f006_score import doc_logits
    from turniting_train.v3model import V3Detector

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = V3Detector.load(path, dev)
    tok = AutoTokenizer.from_pretrained(path / "backbone")
    icfg = json.loads((path / "inference_config.json").read_text())
    lg = doc_logits(m, tok, frame["text_original"].tolist(), icfg.get("view", "canonical"), icfg.get("aggregation", "mean"), 8, device=dev)
    del m
    torch.cuda.empty_cache()
    return lg


def calibrated_eval(name: str, path: Path, cal: pd.DataFrame, val: pd.DataFrame) -> dict:
    lc, lv = logits(path, cal), logits(path, val)
    st = study(cal, lc)
    cfg = st["options"][st["chosen"]]["final_fit"]
    es = (val["language"] == "es").values
    p = apply(cfg, lv, es)
    pred = decide(cfg, p, es)
    rep = report(val, p, pred)  # decision metrics from `pred` (calibrated thresholds fitted on CALIBRATION)
    sel = selection_score({k: v for k, v in rep.items() if isinstance(v, dict)})
    hist = (val["origin"] == "f006_1_1_validation").values
    newm = ~hist
    y = val["label"].values
    out = {"name": name, "path": str(path), "calibration": {"chosen": st["chosen"], "eligible": st["eligible"], "config": cfg},
           "validation": rep, "selection": sel, "uncalibrated_operating_point": evaluate_scores(val, 1 / (1 + np.exp(-lv)))["selection"],
           "historical_part": full(y[hist], p[hist], pred[hist]), "new_part": full(y[newm], p[newm], pred[newm]),
           "by_dataset": {ds: full(y[(val["dataset"] == ds).values], p[(val["dataset"] == ds).values], pred[(val["dataset"] == ds).values])
                          for ds in sorted(val["dataset"].astype(str).unique()) if (val["dataset"] == ds).sum() >= 50}}
    pd.DataFrame({"id": val["id"], "logit": lv, "p": p, "pred": pred}).to_parquet(D / "reports" / f"{name}_validation_scores.parquet", index=False)
    return out


def compare(runs: list[str]) -> int:
    set_score("f006_2")
    cal = pd.read_parquet(SPLITS / "f006_2_calibration.parquet")
    val = pd.read_parquet(SPLITS / "f006_2_validation.parquet")
    res = {"EXPERIMENTAL_F006_1_1_MODEL": calibrated_eval("EXPERIMENTAL_F006_1_1_MODEL", F611_MODEL, cal, val)}
    for r in runs:
        rd = RUNS / r
        if not (rd / "run.json").exists():
            log(f"{r}: not finished; skipped")
            continue
        res[r] = calibrated_eval(r, rd / "best", cal, val)
        res[r]["run"] = {k: v for k, v in json.loads((rd / "run.json").read_text()).items() if k in ("config", "best", "stoppedAtStep", "totalSteps", "trainSeconds",
                                                                                                 "microBatch", "accumulation", "hardware", "init", "gitCommit")}
    b = res["EXPERIMENTAL_F006_1_1_MODEL"]
    for k, v in res.items():
        if k == "EXPERIMENTAL_F006_1_1_MODEL":
            continue
        hb, hv = b["historical_part"], v["historical_part"]
        v["forgetting"] = {"historical_macro_f1_drop": (hb.get("macro_f1") or 0) - (hv.get("macro_f1") or 0),
                           "historical_fpr_rise": (hv.get("fpr") or 0) - (hb.get("fpr") or 0)}
        v["selectable"] = bool(v["selection"]["eligible"] and v["forgetting"]["historical_macro_f1_drop"] <= 0.01 and v["forgetting"]["historical_fpr_rise"] <= 0.01)
    cands = {k: v for k, v in res.items() if k != "EXPERIMENTAL_F006_1_1_MODEL" and v.get("selectable")}
    chosen = None
    if cands:
        best = max(cands, key=lambda k: cands[k]["selection"]["score"])
        bs = [k for k in cands if k.endswith("_B")]
        chosen = bs[0] if bs and cands[bs[0]]["selection"]["score"] >= cands[best]["selection"]["score"] - 0.005 else best
    improves = bool(chosen and res[chosen]["selection"]["score"] > b["selection"]["score"])
    summary = {"chosen": chosen, "improves_over_baseline_on_validation": improves, "rule": "max F006_2_SELECTION_SCORE among eligible, no-forgetting candidates; "
               "replay candidate B preferred within 0.005", "scores": {k: {"score": v["selection"]["score"], "eligible": v["selection"]["eligible"],
                                                                            "selectable": v.get("selectable"), "forgetting": v.get("forgetting")} for k, v in res.items()}}
    write_json(D / "reports" / "validation_comparison.json", {"summary": summary, "models": res})
    write_json(REPO / "reports" / "f006_2" / "validation_comparison.json", {"summary": summary, "models": res})
    log("compare: " + json.dumps(summary["scores"]))
    log(f"chosen: {chosen} (improves over F006.1.1 on validation: {improves})")
    return 0


def lock() -> int:
    if LOCK.exists():
        lk = json.loads(LOCK.read_text())
        assert model_hash(Path(lk["modelPath"])) == lk["modelSha256"]
        log("lock exists and verifies")
        return 0
    comp = json.loads((D / "reports" / "validation_comparison.json").read_text())
    chosen = comp["summary"]["chosen"]
    if not chosen:
        write_json(LOCK.with_name("F006_2_NO_MODEL_LOCK.json"), {"reason": "no eligible, no-forgetting candidate on VALIDATION", "summary": comp["summary"]})
        raise SystemExit("STOP: no candidate is eligible; nothing locked")
    r = comp["models"][chosen]
    mdir = FINAL / "f006_2_locked"
    if mdir.exists():
        shutil.rmtree(mdir)
    shutil.copytree(RUNS / chosen / "best", mdir)
    cfg = r["calibration"]["config"]
    write_json(mdir / "calibration.json", {"selected": cfg["global"], "spanish": cfg.get("spanish"), "option": cfg["option"]})
    write_json(mdir / "thresholds.json", {"GLOBAL_THRESHOLD": cfg["threshold_global"], "SPANISH_THRESHOLD": cfg["threshold_spanish"], "space": "calibrated",
                                          "chosen_on": "F006_2_CALIBRATION"})
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    write_json(mdir / "model_manifest.json", {"modelVersion": "F006_2_MODERN_SPANISH_ACADEMIC_HARDENING", "parentModel": "EXPERIMENTAL_F006_1_1_MODEL",
                                              "status": "LOCKED_PENDING_EVALUATION", "gitCommit": commit, "notTurnitin": "Independent research detector; never a Turnitin score."})
    run = json.loads((RUNS / chosen / "run.json").read_text())
    lk = {"name": "F006_2_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "modelPath": str(mdir),
          "modelSha256": model_hash(mdir), "candidate": chosen, "checkpointStep": run["best"]["step"], "initFrom": run["init"], "calibration": cfg,
          "datasetManifestSha256": {k: sha256_file(MANI / f) for k, f in (("final", "f006_2_final_external_holdout.json"), ("validation", "f006_2_validation.json"),
                                                                           ("calibration", "f006_2_calibration.json"), ("train_extra", "f006_2_train_extra.json"))},
          "trainingConfig": run["config"], "trainingConfigSha256": hashlib.sha256(json.dumps(run["config"], sort_keys=True, default=str).encode()).hexdigest(),
          "seed": run["config"]["seed"], "trainingCodeCommit": run["gitCommit"], "lockCodeCommit": commit}
    write_json(LOCK, lk)
    write_json(REPO / "reports" / "f006_2" / "model_lock.json", lk)
    log(f"MODEL_LOCK {chosen} {lk['modelSha256'][:16]}")
    return 0


def dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def final() -> int:
    if DONE.exists():
        log("FINAL_EXTERNAL_HOLDOUT already evaluated once; refusing")
        return 0
    lk = json.loads(LOCK.read_text())
    hman = json.loads((MANI / "f006_2_final_external_holdout.json").read_text())
    assert model_hash(Path(lk["modelPath"])) == lk["modelSha256"], "locked model changed"
    hp = SPLITS / "f006_2_final_external_holdout.parquet"
    assert sha256_file(hp) == hman["holdout_file_sha256"], "holdout changed"
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    assert lk["lockedAt"] < started
    hold = pd.read_parquet(hp)
    hard = pd.read_parquet(SPLITS / "f006_2_hard_independent.parquet")
    reg = pd.read_parquet(D611 / "datasets" / "f006_1_1_final_holdout.parquet")
    comp = json.loads((D / "reports" / "validation_comparison.json").read_text())
    models = {"EXPERIMENTAL_F006_2_MODEL": (Path(lk["modelPath"]), lk["calibration"]),
              "EXPERIMENTAL_F006_1_1_MODEL": (F611_MODEL, comp["models"]["EXPERIMENTAL_F006_1_1_MODEL"]["calibration"]["config"])}
    y = hold["label"].values
    es = (hold["language"] == "es").values
    hum = y == 0
    ugen = (hold["primary"] == "unseen_generator").values
    a3 = (hold["dataset"] == "spanish_synthetic_2026").values
    out = {"set": "F006_2_FINAL_EXTERNAL_HOLDOUT", "evaluatedAt": started, "lockedAt": lk["lockedAt"], "docs": int(len(hold)), "models": {},
           "definitions": {"SPANISH": "all Spanish FINAL rows (TDX human theses + spanish_synthetic_2026 machines)",
                           "ACADEMIC": "TDX human theses only (FINAL has no non-Claude academic machine text: FPR is measurable, F1 is not)",
                           "OOD": "spanish_synthetic_2026 (unseen domain + unseen generators) + Spanish FINAL humans",
                           "UNSEEN_GENERATOR": "unseen-generator machines (Ministral-3B / Qwen-2.5-0.5B / Llama-3.2-1B news) + all FINAL humans"}}
    for name, (path, cfg) in models.items():
        m = Model(path, cfg)
        p, pred = m.run(hold)
        sub = report(hold, p, pred)
        spec = {"ALL": np.ones(len(y), bool), "SPANISH": es, "ACADEMIC": hum & (hold["dataset"] == "tdx_thesis_es").values,
                "OOD": a3 | (hum & es), "UNSEEN_GENERATOR": ugen | hum, "MIXED": (hold["fine_label"] == "MIXED").values,
                "AI_EDITED": hold["fine_label"].isin(["AI_EDITED", "PARAPHRASED_AI"]).values}
        sets = {k: full(y[v], p[v], pred[v]) for k, v in spec.items() if v.sum()}
        hp_, hpred = m.run(hard)
        rp, rpred = m.run(reg)
        out["models"][name] = {"calibration_option": cfg["option"], "threshold_global": cfg["threshold_global"], "sets": sets, "subsets": sub,
                               "hard_independent": {"all": full(hard["label"].values, hp_, hpred),
                                                    "hard_only": full(hard.loc[hard["primary"] == "hard_independent", "label"].values,
                                                                      hp_[(hard["primary"] == "hard_independent").values], hpred[(hard["primary"] == "hard_independent").values])},
                               "regression_holdout_f006_1_1": {s: v for s, v in report(reg, rp, rpred).items() if s in ("all", "spanish", "academic", "mixed", "unseen_generator", "ood")}}
        log(f"{name}: FINAL FPR all {sets['ALL'].get('fpr')} academic FPR {sets.get('ACADEMIC', {}).get('fpr')} macro F1 {sets['ALL'].get('macro_f1')}")
        del m
    mdl = FINAL / "experimental_f006_2"
    if mdl.exists():
        shutil.rmtree(mdl)
    shutil.copytree(Path(lk["modelPath"]), mdl)
    mm = json.loads((mdl / "model_manifest.json").read_text())
    mm.update({"status": "EXPERIMENTAL", "modelVersion": "EXPERIMENTAL_F006_2_MODEL", "active": False, "promoted": False})
    write_json(mdl / "model_manifest.json", mm)
    regy = {"name": "EXPERIMENTAL_F006_2_MODEL", "status": "EXPERIMENTAL", "active": False, "promoted": False, "storage_provider": "GOOGLE_DRIVE",
            "logical_path": "MyDrive/turniting/f006_2/models/final/experimental_f006_2", "SHA256": lk["modelSha256"], "size_bytes": dir_size(mdl),
            "training_phase": "F006_2", "base_model": "microsoft/mdeberta-v3-base (via EXPERIMENTAL_F006_1_1_MODEL)", "parent_model": "EXPERIMENTAL_F006_1_1_MODEL",
            "candidate": lk["candidate"], "dataset_manifest_hash": lk["datasetManifestSha256"], "training_config_hash": lk["trainingConfigSha256"],
            "calibration": {"option": lk["calibration"]["option"], "threshold_global": lk["calibration"]["threshold_global"]}}
    write_json(D / "reports" / "final_external_holdout.json", out)
    write_json(REPO / "reports" / "f006_2" / "final_external_holdout.json", out)
    write_json(MANI / "model_registry_f006_2.json", regy)
    write_json(REPO / "datasets" / "manifests" / "model_registry_f006_2.json", regy)
    write_json(DONE, {"evaluatedAt": started, "status": "EXPERIMENTAL", "FINAL_HOLDOUT_TUNING": "NO"})
    log("FINAL F006.2 evaluated once; model EXPERIMENTAL")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["compare", "lock", "final"])
    ap.add_argument("--runs", nargs="*", default=["F0062_A", "F0062_B"])
    a = ap.parse_args()
    return {"compare": lambda: compare(a.runs), "lock": lock, "final": final}[a.cmd]()


if __name__ == "__main__":
    raise SystemExit(main())
