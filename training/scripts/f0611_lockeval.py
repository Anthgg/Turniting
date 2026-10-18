"""F006.1.1: reference calibration on the new validation (calib_pre), MODEL LOCK (lock) and the single final evaluation (final).

    python scripts/f0611_lockeval.py calib_pre
    python scripts/f0611_lockeval.py lock --run F00611_FULL --parent <ablation run name>
    python scripts/f0611_lockeval.py final

Options compared on F006_1_1 VALIDATION (group 2-fold out-of-fold): global isotonic, global Platt, Spanish isotonic,
Spanish Platt, Spanish threshold (f006_1_calib.study). Every reference model (V3, F006, F006.1) gets the same treatment
so all models are compared at their own validation-fitted operating point. The holdout is read only in `final`, once.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_1_calib import study  # noqa: E402
from f006_1_final_eval import Model, full, report  # noqa: E402
from f006_lib import log, sha256_file, write_json  # noqa: E402
from f006_lock import model_hash  # noqa: E402

D = Path("/content/drive/MyDrive/turniting/f006_1_1")
D6 = Path("/content/drive/MyDrive/turniting/f006")
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
V3D = Path("/content/drive/MyDrive/turniting/v3")
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]
REFS = {"CANDIDATE_MODEL_V3": V3D / "models" / "spanish_academic", "EXPERIMENTAL_F006_MODEL": D6 / "models" / "experimental_v4",
        "EXPERIMENTAL_F006_1_MODEL": D61 / "models" / "experimental_f006_1"}
HIST_V1 = ["v1_test", "v1_test_spanish", "v1_test_academic", "v1_ood", "v1_adversarial", "v1_unseen_generator", "v1_unseen_domain"]


def slim(st: dict) -> dict:
    return {"chosen": st["chosen"], "eligible": st["eligible"], "config": st["options"][st["chosen"]]["final_fit"],
            "oof": {o: {k: {m: v.get(m) for m in ("n", "n_human", "fpr", "fpr_ci95", "recall", "macro_f1", "ece", "brier")} for k, v in r["oof"].items()}
                    for o, r in st["options"].items()}}


def logits_for(path: Path, frame: pd.DataFrame):
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


def calib_pre() -> int:
    val = pd.read_parquet(D / "datasets" / "f006_1_1_validation.parquet")
    out = {}
    (D / "runs").mkdir(parents=True, exist_ok=True)
    for name, path in REFS.items():
        lg = logits_for(path, val)
        pd.DataFrame({"id": val["id"], "logit": lg}).to_parquet(D / "runs" / f"{name}_validation_logits.parquet", index=False)
        out[name] = slim(study(val, lg))
        log(f"{name}: chosen {out[name]['chosen']}; OOF " + json.dumps({o: (round(r['all']['fpr'], 4), round(r['spanish']['fpr'], 4)) for o, r in out[name]['oof'].items()}))
    write_json(D / "reports" / "calibration_pretraining.json", out)
    write_json(REPO / "reports" / "f006_1_1" / "calibration_pretraining.json", out)
    return 0


def lock(run: str, parent: str) -> int:
    lp = D / "manifests" / "F006_1_1_MODEL_LOCK.json"
    if lp.exists():
        lk = json.loads(lp.read_text())
        assert model_hash(Path(lk["modelPath"])) == lk["modelSha256"]
        log("lock exists and verifies")
        return 0
    rd = D / "runs" / run
    r = json.loads((rd / "run.json").read_text())
    val = pd.read_parquet(D / "datasets" / "f006_1_1_validation.parquet")
    lg = pd.read_parquet(rd / "validation_doc_logits.parquet").set_index("id").loc[val["id"], "logit"].values
    mine = slim(study(val, lg))
    refs = json.loads((D / "reports" / "calibration_pretraining.json").read_text())
    mdir = D / "models" / "f006_1_1_locked"
    if mdir.exists():
        shutil.rmtree(mdir)
    shutil.copytree(rd / "best", mdir)
    cfg = mine["config"]
    write_json(mdir / "calibration.json", {"selected": cfg["global"], "spanish": cfg.get("spanish"), "option": cfg["option"]})
    write_json(mdir / "thresholds.json", {"BALANCED": {"threshold": cfg["threshold_global"]}, "GLOBAL_THRESHOLD": cfg["threshold_global"],
                                          "SPANISH_THRESHOLD": cfg["threshold_spanish"], "space": "calibrated", "chosen_on": "F006_1_1_VALIDATION"})
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    write_json(mdir / "model_manifest.json", {"modelVersion": "F006_1_1_DETECTOR_HARDENING", "parentModel": parent, "status": "LOCKED_PENDING_EVALUATION",
                                              "gitCommit": commit, "notTurnitin": "Independent research detector; never a Turnitin score."})
    icfg = json.loads((mdir / "inference_config.json").read_text())
    lk = {"name": "F006_1_1_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "modelPath": str(mdir),
          "modelSha256": model_hash(mdir), "checkpoint": str(rd / "best"), "checkpointStep": r["best"]["step"], "parent": parent, "initFrom": r["init"],
          "datasetManifestSha256": {k: sha256_file(D / "manifests" / f) for k, f in (("holdout", "f006_1_1_final_holdout.json"), ("validation", "f006_1_1_validation.json"),
                                                                                    ("train_extra", "f006_1_1_train_extra.json"), ("dataset", "F006_1_1_DATASET_MANIFEST.json"))},
          "trainingConfig": r["config"], "sampling": r["sampleAudit"], "loss": {"type": r["config"]["loss"], "human_weight": r["config"]["human_weight"],
                                                                               "token_weight": r["config"].get("token_weight")},
          "calibration": {"option": cfg["option"], "global": cfg["global"]["method"], "spanish": (cfg.get("spanish") or {}).get("method")},
          "thresholdGlobal": cfg["threshold_global"], "thresholdSpanish": cfg["threshold_spanish"],
          "preprocessing": {"profile": "V3_CANONICALIZED_V1", "view": icfg.get("view"), "aggregation": icfg.get("aggregation"), "max_length": 512, "stride": 128},
          "seed": r["config"]["seed"], "trainingCodeCommit": r["gitCommit"], "lockCodeCommit": commit,
          "references": {k: {"chosen": v["chosen"], "config": v["config"]} for k, v in refs.items()}}
    write_json(lp, lk)
    write_json(REPO / "reports" / "f006_1_1" / "model_lock.json", lk)
    vrep = {"F006_1_1_MODEL": mine, **refs, "training_history": r["history"]}
    write_json(D / "reports" / "validation.json", vrep)
    write_json(REPO / "reports" / "f006_1_1" / "validation.json", vrep)
    log(f"LOCKED {mdir.name} {lk['modelSha256'][:16]} calibration {cfg['option']}")
    return 0


def final() -> int:
    from f0611_span import span_eval

    done = D / "manifests" / "F006_1_1_FINAL_EVAL_DONE.json"
    if done.exists():
        log("already evaluated once; refusing")
        return 0
    lk = json.loads((D / "manifests" / "F006_1_1_MODEL_LOCK.json").read_text())
    hman = json.loads((D / "manifests" / "f006_1_1_final_holdout.json").read_text())
    assert model_hash(Path(lk["modelPath"])) == lk["modelSha256"]
    assert sha256_file(D / "datasets" / "f006_1_1_final_holdout.parquet") == hman["holdout_file_sha256"]
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    hold = pd.read_parquet(D / "datasets" / "f006_1_1_final_holdout.parquet")
    att = pd.read_parquet(D / "datasets" / "f006_1_1_final_holdout_attacks.parquet")
    f61 = pd.read_parquet(D61 / "datasets" / "f006_1_final_holdout.parquet")
    f6 = pd.read_parquet(D6 / "datasets" / "f006_final_holdout.parquet")
    import v3_evaluate as E

    ev = pd.read_parquet(V3D / "datasets" / "eval_sets_v2.parquet")
    ev = ev[ev["eval_set"].isin(HIST_V1)]
    hist = E.load_texts(MASTER.parent, ev).reset_index()
    hist["label"] = (hist["fine_label"] != "HUMAN").astype(int)
    models = {"F006_1_1_MODEL": (Path(lk["modelPath"]), json.loads((D / "reports" / "validation.json").read_text())["F006_1_1_MODEL"]["config"])}
    models.update({k: (REFS[k], v["config"]) for k, v in lk["references"].items()})
    final_r, rob, histr = {"set": "F006_1_1_FINAL_HOLDOUT", "evaluatedAt": started, "lockedAt": lk["lockedAt"], "models": {}}, {"models": {}, "span": {}}, {
        "HISTORICAL_F006_SPANISH": {}, "HISTORICAL_F006_1_HOLDOUT": {}, "HISTORICAL_V1": {}, "note": "historical, observed earlier; continuity only"}
    sp = hold[(hold["primary"] == "span") & hold["span_labels"].notna()].reset_index(drop=True)
    for name, (path, cfg) in models.items():
        m = Model(path, cfg)
        p, pred = m.run(hold)
        final_r["models"][name] = {"calibration_option": cfg["option"], "threshold_global": cfg["threshold_global"], "threshold_spanish": cfg["threshold_spanish"],
                                   "subsets": report(hold, p, pred)}
        rob["models"][name] = {s: full(g["label"].values, *m.run(g.reset_index(drop=True))) for s, g in att.groupby("attack_set")}
        rob["span"][name] = span_eval(m.sc.model, m.sc.tok, sp["text_original"].tolist(), sp["span_labels"].tolist(), device=E.DEVICE)
        for key, fr in (("HISTORICAL_F006_SPANISH", f6[f6["language"] == "es"].reset_index(drop=True)), ("HISTORICAL_F006_1_HOLDOUT", f61)):
            ph, predh = m.run(fr)
            histr[key][name] = {s: v for s, v in report(fr, ph, predh).items() if s in ("all", "spanish", "academic", "mixed", "unseen_generator")}
        pv, predv = m.run(hist)
        histr["HISTORICAL_V1"][name] = {s: full(hist["label"].values[hist["id"].isin(set(g["id"])).values], pv[hist["id"].isin(set(g["id"])).values],
                                                predv[hist["id"].isin(set(g["id"])).values]) for s, g in ev.groupby("eval_set")}
        s_ = final_r["models"][name]["subsets"]
        log(f"{name}: FPR all {s_['all']['fpr']:.4f} es {s_['spanish']['fpr']:.4f} mixed rec {s_.get('mixed', {}).get('recall')} span {rob['span'][name]['token_f1']:.3f}")
        del m
    B = {k: v["subsets"] for k, v in final_r["models"].items()}
    me, par = "F006_1_1_MODEL", "EXPERIMENTAL_F006_1_MODEL"
    g = lambda mo, s, k: (B[mo].get(s) or {}).get(k)  # noqa: E731
    zw = lambda mo, s: rob["models"][mo][s].get("macro_f1") or 0  # noqa: E731
    gates = {
        "A_overall_human_fpr_le_0.05": (g(me, "all", "fpr") or 1) <= 0.05,
        "B_spanish_human_fpr_le_0.08": (g(me, "spanish", "fpr") or 1) <= 0.08,
        "C_academic_human_fpr_le_0.05": (g(me, "academic", "fpr") or 1) <= 0.05,
        "D_unseen_generator_fpr_le_0.10": (g(me, "unseen_generator", "fpr") or 1) <= 0.10,
        "E_ai_edited_f1_ge_0.90": (g(me, "ai_edited", "macro_f1") or 0) >= 0.90,
        "F_ood_f1_ge_0.90": (g(me, "ood", "macro_f1") or 0) >= 0.90,
        "G_leakage_0": hman["leakage"]["result"] == "PASS",
        "H_mixed_recall_ge_0.65": (g(me, "mixed", "recall") or 0) >= 0.65,
        "I_span_token_f1_ge_0.86": (rob["span"][me].get("token_f1") or 0) >= 0.86,
        "J_unicode_no_regression_gt_3pp": all(zw(me, s) >= zw(par, s) - 0.03 for s in ("zero_width", "homoglyph")),
        "K_final_holdout_untouched": lk["lockedAt"] < started and sha256_file(D / "datasets" / "f006_1_1_final_holdout.parquet") == hman["holdout_file_sha256"],
    }
    passed = all(gates.values())
    status, name = ("CANDIDATE", "CANDIDATE_MODEL_V4") if passed else ("EXPERIMENTAL", "EXPERIMENTAL_F006_1_1_MODEL")
    dest = D / "models" / ("candidate_v4" if passed else "experimental_f006_1_1")
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(Path(lk["modelPath"]), dest)
    mm = json.loads((dest / "model_manifest.json").read_text())
    mm.update({"status": status, "modelVersion": name, "gates": gates, "active": False})
    write_json(dest / "model_manifest.json", mm)
    reg = {"name": name, "status": status, "active": False, "parentModel": lk["parent"], "artifactPath": f"MyDrive/turniting/f006_1_1/models/{dest.name}",
           "calibration": lk["calibration"], "thresholdGlobal": lk["thresholdGlobal"], "thresholdSpanish": lk["thresholdSpanish"], "modelSha256": lk["modelSha256"],
           "failedGates": [k for k, v in gates.items() if not v]}
    for fname, obj in (("final_holdout.json", final_r), ("robustness.json", rob), ("historical_benchmarks.json", histr),
                       ("gates.json", {"gates": gates, "passed": passed, "status": status}), ("candidate_model_v4_registry.json", reg)):
        write_json(D / "reports" / fname, obj)
        write_json(REPO / "reports" / "f006_1_1" / fname, obj)
    write_json(done, {"evaluatedAt": started, "status": status})
    log(f"FINAL F006.1.1: {status}; gates {gates}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["calib_pre", "lock", "final"])
    ap.add_argument("--run", default="F00611_FULL")
    ap.add_argument("--parent", default="")
    a = ap.parse_args()
    return {"calib_pre": calib_pre, "lock": lambda: lock(a.run, a.parent), "final": final}[a.cmd]()


if __name__ == "__main__":
    raise SystemExit(main())
