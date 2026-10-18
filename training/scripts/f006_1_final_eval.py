"""F006.1: the ONE evaluation after F006_1_MODEL_LOCK, historical benchmarks after it, then the V4 gates.

    python scripts/f006_1_final_eval.py

Every model is applied with its own calibration option / thresholds fitted on F006_1 VALIDATION (lock references).
Decision metrics use each document's threshold (Spanish or global); ROC-AUC / PR-AUC / ECE / Brier use the
calibrated probability. Nothing here feeds back into any choice.
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_1_calib import apply, decide  # noqa: E402
from f006_lib import ece, log, metrics, sha256_file, subset_masks, write_json  # noqa: E402
from f006_lock import model_hash  # noqa: E402

D6 = Path("/content/drive/MyDrive/turniting/f006")
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
V3D = Path("/content/drive/MyDrive/turniting/v3")
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]
HIST_V1 = ["v1_test", "v1_test_spanish", "v1_test_academic", "v1_ood", "v1_adversarial", "v1_unseen_generator", "v1_unseen_domain"]


def full(y, p, pred, ci=True) -> dict:
    """decision metrics from `pred`, ranking / calibration metrics from `p`."""
    m = metrics(y, pred.astype(float), 0.5, ci=ci)
    for k in ("roc_auc", "pr_auc", "brier", "ece"):
        m.pop(k, None)
    if len(set(y)) == 2:
        from sklearn.metrics import average_precision_score, roc_auc_score
        m["roc_auc"], m["pr_auc"] = float(roc_auc_score(y, p)), float(average_precision_score(y, p))
    if len(y):
        m["ece"], m["brier"] = ece(y, p), float(np.mean((p - y) ** 2))
    return m


def report(frame: pd.DataFrame, p: np.ndarray, pred: np.ndarray) -> dict:
    y = frame["label"].values
    out = {name: full(y[m], p[m], pred[m]) for name, m in subset_masks(frame).items() if m.sum()}
    es = (frame["language"] == "es").values
    if "region" in frame:
        reg = frame["region"].fillna("UNKNOWN").values
        out["spanish_by_region"] = {r: full(y[es & (reg == r)], p[es & (reg == r)], pred[es & (reg == r)])
                                    for r in sorted(set(reg[es])) if (es & (reg == r)).sum() >= 100}
    out["spanish_by_dataset"] = {d: full(y[es & (frame["dataset"].values == d)], p[es & (frame["dataset"].values == d)], pred[es & (frame["dataset"].values == d)])
                                 for d in sorted(set(frame.loc[es, "dataset"])) if (es & (frame["dataset"].values == d)).sum() >= 100}
    return out


class Model:
    def __init__(self, path: Path, cfg: dict):
        from v3_evaluate import V3Scorer

        self.sc, self.cfg = V3Scorer(path), cfg

    def run(self, frame: pd.DataFrame, text_col="text_original"):
        import v3_evaluate as E
        from f006_score import doc_logits

        lg = doc_logits(self.sc.model, self.sc.tok, frame[text_col].tolist(), self.sc.icfg.get("view", "canonical"),
                        self.sc.icfg["aggregation"], 8, device=E.DEVICE)
        es = (frame["language"] == "es").values
        p = apply(self.cfg, lg, es)
        return p, decide(self.cfg, p, es)


def main() -> int:
    done = D61 / "manifests" / "F006_1_FINAL_EVAL_DONE.json"
    if done.exists():
        log("already evaluated once; refusing")
        return 0
    lock = json.loads((D61 / "manifests" / "F006_1_MODEL_LOCK.json").read_text())
    hman = json.loads((D61 / "manifests" / "f006_1_final_holdout.json").read_text())
    mdir = Path(lock["modelPath"])
    assert model_hash(mdir) == lock["modelSha256"], "locked model hash mismatch"
    assert sha256_file(D61 / "datasets" / "f006_1_final_holdout.parquet") == hman["holdout_file_sha256"], "holdout changed"
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    hold = pd.read_parquet(D61 / "datasets" / "f006_1_final_holdout.parquet")
    att = pd.read_parquet(D61 / "datasets" / "f006_1_final_holdout_attacks.parquet")
    f6 = pd.read_parquet(D6 / "datasets" / "f006_final_holdout.parquet")
    f6es = f6[f6["language"] == "es"].reset_index(drop=True)
    import v3_evaluate as E

    ev = pd.read_parquet(V3D / "datasets" / "eval_sets_v2.parquet")
    ev = ev[ev["eval_set"].isin(HIST_V1)]
    hist = E.load_texts(MASTER.parent, ev).reset_index()
    hist["label"] = (hist["fine_label"] != "HUMAN").astype(int)
    my_cfg = json.loads((D61 / "reports" / "calibration.json").read_text())["F006_1_MODEL"]["config"]
    models = {"F006_1_MODEL": (mdir, my_cfg),
              "CANDIDATE_MODEL_V3": (V3D / "models" / "spanish_academic", lock["references"]["CANDIDATE_MODEL_V3"]["config"]),
              "EXPERIMENTAL_F006_MODEL": (D6 / "models" / "experimental_v4", lock["references"]["EXPERIMENTAL_F006_MODEL"]["config"])}
    final, rob, histrep = {"set": "F006_1_FINAL_HOLDOUT", "evaluatedAt": started, "lockedAt": lock["lockedAt"], "models": {}}, {"models": {}, "span": {}}, {
        "HISTORICAL_F006_SPANISH": {}, "HISTORICAL_V1": {}, "note": "historical, observed earlier; continuity only. HISTORICAL_V1 is no longer independent of "
        "F006.1 training (sibling rows of the same official test distributions were re-partitioned into TRAIN_EXTRA)."}
    for name, (path, cfg) in models.items():
        m = Model(path, cfg)
        p, pred = m.run(hold)
        final["models"][name] = {"calibration_option": cfg["option"], "threshold_global": cfg["threshold_global"],
                                 "threshold_spanish": cfg["threshold_spanish"], "subsets": report(hold, p, pred)}
        rob["models"][name] = {}
        for s, g in att.groupby("attack_set"):
            g = g.reset_index(drop=True)
            pa, preda = m.run(g)
            rob["models"][name][s] = full(g["label"].values, pa, preda)
        sp = hold[hold["primary"] == "span"].head(600).reset_index(drop=True)
        rob["span"][name] = E.span_metrics(m.sc, sp)
        ph, predh = m.run(f6es)
        histrep["HISTORICAL_F006_SPANISH"][name] = report(f6es, ph, predh)
        pv, predv = m.run(hist)
        histrep["HISTORICAL_V1"][name] = {s: full(hist["label"].values[hist["id"].isin(set(g["id"])).values], pv[hist["id"].isin(set(g["id"])).values],
                                                  predv[hist["id"].isin(set(g["id"])).values]) for s, g in ev.groupby("eval_set")}
        log(f"{name}: holdout FPR all {final['models'][name]['subsets']['all']['fpr']:.4f} Spanish {final['models'][name]['subsets']['spanish']['fpr']:.4f}")
        del m
    B = {k: v["subsets"] for k, v in final["models"].items()}
    me, v3, f6m = "F006_1_MODEL", "CANDIDATE_MODEL_V3", "EXPERIMENTAL_F006_MODEL"
    g = lambda mo, s, k: (B[mo].get(s) or {}).get(k)  # noqa: E731
    zw = lambda mo, s: rob["models"][mo][s].get("macro_f1") or 0  # noqa: E731
    ref_zw = {s: max(zw(v3, s), zw(f6m, s)) for s in ("zero_width", "homoglyph")}
    gates = {
        "A_overall_human_fpr_le_0.05": (g(me, "all", "fpr") or 1) <= 0.05,
        "B_spanish_human_fpr_le_0.08": (g(me, "spanish", "fpr") or 1) <= 0.08,
        "C_academic_human_fpr_le_0.05": (g(me, "academic", "fpr") or 1) <= 0.05,
        "D_unseen_generator_fpr_le_0.10": (g(me, "unseen_generator", "fpr") or 1) <= 0.10,
        "E_mixed_recall_ge_0.64": (g(me, "mixed", "recall") or 0) >= 0.64,
        "F_ai_edited_f1_ge_0.81": (g(me, "ai_edited", "macro_f1") or 0) >= 0.81,
        "G_ood_f1_ge_0.90_or_drop_le_0.04": (g(me, "ood", "macro_f1") or 0) >= 0.90 or (g(me, "ood", "macro_f1") or 0) >= max(g(v3, "ood", "macro_f1") or 0, g(f6m, "ood", "macro_f1") or 0) - 0.04,
        "H_span_f1_ge_0.86": (rob["span"][me].get("token_f1") or 0) >= 0.86,
        "I_zero_width_homoglyph_no_severe_regression": all(zw(me, s) >= ref_zw[s] - 0.05 for s in ref_zw),
        "J_leakage_0": hman["leakage"]["result"] == "PASS",
        "K_holdout_not_used_for_tuning": lock["lockedAt"] < started and sha256_file(D61 / "datasets" / "f006_1_final_holdout.parquet") == hman["holdout_file_sha256"],
    }
    passed = all(gates.values())
    status, name = ("CANDIDATE", "CANDIDATE_MODEL_V4") if passed else ("EXPERIMENTAL", "EXPERIMENTAL_F006_1_MODEL")
    dest = D61 / "models" / ("candidate_v4" if passed else "experimental_f006_1")
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(mdir, dest)
    man = json.loads((dest / "model_manifest.json").read_text())
    man.update({"status": status, "modelVersion": name, "gates": gates, "active": False})
    write_json(dest / "model_manifest.json", man)
    registry = {"name": name, "status": status, "active": False, "parentModel": lock["parent"], "architecture": "microsoft/mdeberta-v3-base + V3 multi-task heads",
                "artifactPath": f"MyDrive/turniting/f006_1/models/{dest.name}", "checkpointPath": lock["checkpoint"].replace("/content/drive/", ""),
                "calibration": lock["calibration"], "thresholdGlobal": lock["thresholdGlobal"], "thresholdSpanish": lock["thresholdSpanish"],
                "languageProfile": "Spanish threshold/calibrator applies when language == 'es' (reproducible local detector required); global fallback",
                "metrics_final_holdout": {s: {k: (B[me].get(s) or {}).get(k) for k in ("macro_f1", "fpr", "fpr_ci95", "recall")}
                                          for s in ("all", "spanish", "spanish_academic", "spanish_non_academic", "academic", "mixed", "ai_edited", "ood",
                                                    "unseen_generator", "unseen_domain", "adversarial")},
                "warnings": [] if passed else ["F006_1_GATES_FAILED: " + ", ".join(k for k, v in gates.items() if not v)],
                "modelSha256": lock["modelSha256"], "trainingCommit": lock["trainingCodeCommit"], "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for fname, obj in (("final_holdout.json", final), ("robustness.json", rob), ("historical_benchmarks.json", histrep),
                       ("gates.json", {"gates": gates, "passed": passed, "status": status}), ("candidate_model_v4_registry.json", registry)):
        write_json(D61 / "reports" / fname, obj)
        write_json(REPO / "reports" / "f006_1" / fname, obj)
    write_json(done, {"evaluatedAt": started, "status": status})
    log(f"FINAL F006.1: {status}; gates {gates}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
