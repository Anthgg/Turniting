"""F006: the ONE evaluation after F006_MODEL_LOCK.

    python scripts/f006_final_eval.py --out <drive>/f006 --v2 <V2 dir> --v3 <V3 dir> --v3-dir <drive>/v3 --master /content/f006work/master_v2

Reads (once): F006_FINAL_HOLDOUT (+ its zero-width / homoglyph copies), the V1 historical sets
(HISTORICAL_V1_BENCHMARK, already observed in F005 -> continuity only), EXTERNAL_HOLDOUT_2026.
Every model is scored at its own operating points from the lock (chosen on F006 VALIDATION).
Nothing here feeds back into training, thresholds or selection. Then the CANDIDATE_MODEL_V4 gates.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import log, metrics, selection_score, sha256_file, subset_report, write_json  # noqa: E402
from f006_lock import model_hash  # noqa: E402
from turniting_train.calibration import Calibrator  # noqa: E402

PROFILES = ["BALANCED", "LOW_FALSE_POSITIVE", "VERY_LOW_FALSE_POSITIVE"]
HIST_SETS = ["v1_test", "v1_test_spanish", "v1_test_academic", "v1_ood", "v1_adversarial", "v1_unseen_generator", "v1_unseen_domain"]


class V3Like:
    """Head-A document probability of a V3-architecture model with a given calibrator (+ head C for spans)."""

    def __init__(self, path: Path, cal: Calibrator):
        from v3_evaluate import V3Scorer

        self.sc = V3Scorer(path)
        self.cal = cal

    def probs(self, texts):
        import v3_evaluate as E

        lgs = []
        for view in self.sc._views(texts):
            s = E.score_texts(self.sc.model, self.sc.tok, view, 512, 128, self.sc.icfg.get("max_windows_per_doc", 8), batch_size=512, device=E.DEVICE)
            lgs.append(np.array([E.aggregate(x["a"], self.sc.icfg["aggregation"]) for x in s]))
        return self.cal.predict(np.mean(lgs, axis=0))


def report_all(frame: pd.DataFrame, p: np.ndarray, th: dict) -> dict:
    out = {}
    for prof in PROFILES:
        rep = subset_report(frame, p, th[prof]["threshold"], ci=True)
        out[prof] = {"threshold": th[prof]["threshold"], "subsets": rep, "selection": selection_score(rep)}
    return out


def flat_metrics(y, p, th: dict) -> dict:
    return {prof: metrics(y, p, th[prof]["threshold"], ci=True) for prof in PROFILES}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/content/drive/MyDrive/turniting/f006")
    ap.add_argument("--v2", required=True)
    ap.add_argument("--v3", required=True)
    ap.add_argument("--v3-dir", default="/content/drive/MyDrive/turniting/v3")
    ap.add_argument("--master", default="/content/f006work/master_v2")
    ap.add_argument("--span-docs", type=int, default=600)
    ap.add_argument("--repo-reports", default=str(Path(__file__).resolve().parents[1] / "reports" / "f006"))
    a = ap.parse_args()
    out, rep_dir = Path(a.out), Path(a.repo_reports)
    done_flag = out / "manifests" / "F006_FINAL_EVAL_DONE.json"
    if done_flag.exists():
        log("final evaluation already ran once; refusing to run again")
        return 0
    lock = json.loads((out / "manifests" / "F006_MODEL_LOCK.json").read_text())
    hman = json.loads((out / "manifests" / "f006_final_holdout_manifest.json").read_text())
    mdir = Path(lock["modelPath"])
    assert lock["LOCKED"] and model_hash(mdir) == lock["modelSha256"], "locked model hash mismatch"
    assert sha256_file(out / "datasets" / "f006_final_holdout.parquet") == hman["holdout_file_sha256"], "holdout changed"
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    hold = pd.read_parquet(out / "datasets" / "f006_final_holdout.parquet")
    att = pd.read_parquet(out / "datasets" / "f006_final_holdout_attacks.parquet")
    import v3_evaluate as E

    ev = pd.read_parquet(Path(a.v3_dir) / "datasets" / "eval_sets_v2.parquet")
    ev = ev[ev["eval_set"].isin(HIST_SETS)]
    hist = E.load_texts(Path(a.master).parent, ev).reset_index()
    hist["label"] = (hist["fine_label"] != "HUMAN").astype(int)
    ext_path = Path(a.v3_dir) / "datasets" / "external_holdout_2026.parquet"
    ext = pd.read_parquet(ext_path) if ext_path.exists() else None
    if ext is not None:
        ext = ext[~ext["negative_control"]].reset_index(drop=True)
    log(f"holdout {len(hold):,} docs, attacks {len(att):,}, historical V1 {len(hist):,}, external {0 if ext is None else len(ext):,}")

    refs = lock["references"]
    th = {"F006_MODEL": {k: {"threshold": v} for k, v in lock["thresholds"].items()},
          "CANDIDATE_MODEL_V3": refs["CANDIDATE_MODEL_V3"]["thresholds"], "CANDIDATE_MODEL_V2": refs["CANDIDATE_MODEL_V2"]["thresholds"],
          "ENSEMBLE_V2_V3": refs["ENSEMBLE_V2_V3"]["thresholds"]}
    cal4 = Calibrator.from_dict(json.loads((mdir / "calibration.json").read_text())["selected"])
    cal3 = Calibrator.from_dict(refs["CANDIDATE_MODEL_V3"]["calibration"])
    texts = {"holdout": hold["text_original"].tolist(), "attacks": att["text_original"].tolist(),
             "hist": hist["text_original"].tolist(), "ext": ext["text"].tolist() if ext is not None else []}
    P, span = {}, {}
    for name, path, cal in (("F006_MODEL", mdir, cal4), ("CANDIDATE_MODEL_V3", Path(a.v3), cal3)):
        m = V3Like(path, cal)
        P[name] = {k: (m.probs(t) if t else np.zeros(0)) for k, t in texts.items()}
        sp = hold[hold["primary"] == "span"].head(a.span_docs).reset_index(drop=True)
        span[name] = E.span_metrics(m.sc, sp)
        log(f"{name}: scored; span token F1 {span[name].get('token_f1')}")
        del m
    v2 = E.LegacyScorer(Path(a.v2))
    P["CANDIDATE_MODEL_V2"] = {k: (np.asarray(v2.doc_probs(t)[0]) if t else np.zeros(0)) for k, t in texts.items()}
    del v2
    P["ENSEMBLE_V2_V3"] = {k: 0.5 * P["CANDIDATE_MODEL_V2"][k] + 0.5 * P["CANDIDATE_MODEL_V3"][k] for k in texts}
    if lock["selectedAnalyzer"] != "V4_ONLY":
        w = lock["ensemble"]["weights"]
        P["F006_VALIDATION_ENSEMBLE"] = {k: w.get("V2", 0) * P["CANDIDATE_MODEL_V2"][k] + w.get("V3", 0) * P["CANDIDATE_MODEL_V3"][k]
                                         + w["V4"] * P["F006_MODEL"][k] for k in texts}
        th["F006_VALIDATION_ENSEMBLE"] = lock["ensemble"]["thresholds"]
    pd.DataFrame({"id": hold["id"], **{m: P[m]["holdout"] for m in P}}).to_parquet(out / "reports" / "holdout_probs.parquet", index=False)

    final = {"set": "F006_FINAL_HOLDOUT", "evaluatedAt": started, "lockedAt": lock["lockedAt"], "evaluated_once": True,
             "holdout_manifest": {k: hman[k] for k in ("docs", "humans", "machine", "ids_sha256", "holdout_file_sha256")},
             "models": {m: report_all(hold, P[m]["holdout"], th[m]) for m in P}}
    rob = {"set": "F006_FINAL_HOLDOUT robustness (synthetic zero-width / homoglyph copies of 1,000 holdout general docs)", "models": {}}
    for m in P:
        rob["models"][m] = {}
        for s, g in att.groupby("attack_set"):
            idx = g.index.values
            clean = pd.Series(P[m]["holdout"], index=hold["id"]).reindex(g["source_id"]).values
            rob["models"][m][s] = {"attacked": flat_metrics(g["label"].values, P[m]["attacks"][idx], th[m]),
                                   "clean_same_docs": flat_metrics(g["label"].values, clean, th[m])}
        rob["models"][m]["adversarial_subset"] = final["models"][m]["BALANCED"]["subsets"].get("adversarial")
    rob["span_detection_head_c"] = span
    mix = {"set": "F006_FINAL_HOLDOUT mixed / AI-edited (real evaluation, not copied)", "models": {
        m: {prof: {s: final["models"][m][prof]["subsets"].get(s) for s in ("mixed", "ai_edited")} for prof in PROFILES} for m in P}}
    histrep = {"set": "HISTORICAL_V1_BENCHMARK", "label": "HISTORICAL_V1_BENCHMARK (observed in F005; continuity only, NOT a final unseen test)",
               "note": "full V1 eval sets from eval_sets_v2 (F005 used 400-doc stratified samples of the same sets)", "models": {}}
    for m in P:
        res = {}
        for s, g in ev.groupby("eval_set"):
            mask = hist["id"].isin(set(g["id"])).values
            res[s] = flat_metrics(hist["label"].values[mask], P[m]["hist"][mask], th[m])
        histrep["models"][m] = res
    extrep = None
    if ext is not None:
        extrep = {"set": "EXTERNAL_HOLDOUT_2026 (after lock, no selection)",
                  "models": {m: flat_metrics(ext["binary_label"].values, P[m]["ext"], th[m]) for m in P}}

    # ---------------- CANDIDATE_MODEL_V4 gates (section 48), each model at its own BALANCED
    B = {m: final["models"][m]["BALANCED"]["subsets"] for m in P}
    g = lambda m, s, k: (B[m].get(s) or {}).get(k)  # noqa: E731
    v4, v3 = "F006_MODEL", "CANDIDATE_MODEL_V3"
    ug_ci4, ug_ci3 = (B[v4].get("unseen_generator") or {}).get("fpr_ci95"), (B[v3].get("unseen_generator") or {}).get("fpr_ci95")
    zw = lambda m, s: rob["models"][m][s]["attacked"]["BALANCED"].get("macro_f1")  # noqa: E731
    split_leak = hman["leakage"]["result"]
    gates = {
        "A_holdout_human_fpr_le_0.05": g(v4, "all", "fpr") is not None and g(v4, "all", "fpr") <= 0.05,
        "B_unseen_generator_fpr_le_0.10_or_clear_gain": (g(v4, "unseen_generator", "fpr") or 1) <= 0.10
        or (ug_ci4 is not None and ug_ci3 is not None and ug_ci4[1] < ug_ci3[0]),
        "C_academic_strong": (g(v4, "academic", "macro_f1") or 0) >= (g(v3, "academic", "macro_f1") or 0) - 0.02 and (g(v4, "academic", "fpr") or 1) <= 0.05,
        "D_spanish_strong": (g(v4, "spanish", "macro_f1") or 0) >= (g(v3, "spanish", "macro_f1") or 0) - 0.02 and (g(v4, "spanish", "fpr") or 1) <= 0.08,
        "E_mixed_recall_drop_le_5pts": (g(v4, "mixed", "recall") or 0) >= (g(v3, "mixed", "recall") or 0) - 0.05,
        "F_ai_edited_f1_drop_le_5pts": (g(v4, "ai_edited", "macro_f1") or 0) >= (g(v3, "ai_edited", "macro_f1") or 0) - 0.05,
        "G_ood_no_severe_drop": (g(v4, "ood", "macro_f1") or 0) >= (g(v3, "ood", "macro_f1") or 0) - 0.05,
        "H_zero_width_homoglyph_robust": all((zw(v4, s) or 0) >= (zw(v3, s) or 0) - 0.05 and (zw(v4, s) or 0) >= 0.80 for s in ("zero_width", "homoglyph")),
        "I_no_leakage": split_leak == "PASS",
        "J_holdout_never_used_for_tuning": lock["lockedAt"] < started and sha256_file(out / "datasets" / "f006_final_holdout.parquet") == hman["holdout_file_sha256"],
    }
    span_ok = (span[v4].get("token_f1") or 0) >= 0.88
    passed = all(gates.values())
    status = "CANDIDATE" if passed else "EXPERIMENTAL"
    name = "CANDIDATE_MODEL_V4" if passed else "EXPERIMENTAL_F006_MODEL"
    dest = out / "models" / ("candidate_v4" if passed else "experimental_v4")
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(mdir, dest)
    man = json.loads((dest / "model_manifest.json").read_text())
    man.update({"status": status, "modelVersion": name, "gates": gates, "spanGate_f1_ge_0.88": span_ok})
    write_json(dest / "model_manifest.json", man)
    registry = {
        "name": name, "architecture": "microsoft/mdeberta-v3-base + V3 multi-task heads (binary / fine / token)",
        "baseModel": "microsoft/mdeberta-v3-base", "parentModel": "CANDIDATE_MODEL_V3 (TURNITING_RESEARCH_V3_SPANISH_ACADEMIC)",
        "datasetVersion": "TURNITING_DATASET_V2", "trainingStrategy": "F006 targeted fine-tune from V3 best: human/machine rebalanced sampling, "
        "TRAIN-only hard-human negatives, paragraph-local samples, loss/weights chosen by ablation on F006 VALIDATION",
        "status": status, "artifactProvider": "GOOGLE_DRIVE_LOCAL_IMPORT", "artifactPath": f"MyDrive/turniting/f006/models/{dest.name}",
        "checkpointPath": "MyDrive/turniting/f006/runs/F006_FULL/best", "preprocessingVersion": "V3_CANONICALIZED_V1",
        "calibrationVersion": f"F006_{cal4.method.upper()}_V1", "thresholds": lock["thresholds"], "selectedAnalyzer": lock["selectedAnalyzer"],
        "metrics": {"validation_balanced": json.loads((out / "reports" / "f006_validation.json").read_text())["models"]["F006_MODEL"]["selection_at_balanced"],
                    "final_holdout_balanced": {s: {k: (B[v4].get(s) or {}).get(k) for k in ("macro_f1", "fpr", "fpr_ci95", "recall")} for s in B[v4]}},
        "warnings": ([] if passed else ["F006_GATES_FAILED: " + ", ".join(k for k, v in gates.items() if not v)])
        + ([] if span_ok else ["SPAN_F1_BELOW_0.88"]), "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "trainingCommit": lock["trainingCodeCommit"], "modelSha256": lock["modelSha256"], "active": False,
        "notTurnitin": "Independent research detector; never a Turnitin score.",
    }
    for path, obj in (("f006_final_holdout.json", final), ("robustness_eval.json", rob), ("mixed_ai_edited_eval.json", mix),
                      ("historical_v1_benchmark.json", histrep), ("external_holdout_2026.json", extrep),
                      ("candidate_model_v4_registry.json", registry), ("gates.json", {"gates": gates, "passed": passed, "status": status,
                                                                                      "span_gate": span_ok})):
        if obj is not None:
            write_json(out / "reports" / path, obj)
            write_json(rep_dir / path, obj)
    write_json(done_flag, {"evaluatedAt": started, "status": status})
    log(f"FINAL: status={status}; gates={gates}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
