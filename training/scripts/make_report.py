"""Assemble TRAINING_REPORT.{md,json}, error_analysis.md, calibration CSV and the
high-confidence FP/FN files from the artifacts written by the other scripts.

    python scripts/make_report.py --recommended CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import (  # noqa: E402
    CHECKPOINT_DIR, DATASET_VERSION, MANIFEST_DIR, MODEL_DISPLAY_NAME, MODEL_VERSION, MODELS_DIR, REPORTS_DIR,
    git_commit, read_json, utc_now, write_json,
)

MODELS = {
    "BEST_BASELINE": "models/baseline/best",
    "GLOBAL_MULTILINGUAL_TRANSFORMER": "models/transformer/global",
    "SPANISH_ACADEMIC_TRANSFORMER": "models/transformer/spanish_academic",
    "CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER": "models/calibrated/spanish_academic",
}
KEYS = ("accuracy", "balanced_accuracy", "precision", "recall", "f1", "macro_f1", "roc_auc", "pr_auc", "fpr", "fnr",
        "mcc", "ece", "brier")


def f(v, nd=4):
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def pick(m: dict | None) -> dict:
    return {k: (m or {}).get(k) for k in KEYS + ("n",)}


def dir_bytes(p: Path) -> int:
    return sum(x.stat().st_size for x in p.rglob("*") if x.is_file()) if p.exists() else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--recommended", required=True)
    ap.add_argument("--status", default=None)
    args = ap.parse_args()

    hw = read_json(REPORTS_DIR / "hardware_audit.json", {})
    registry = read_json(MANIFEST_DIR / "datasets.json", {"datasets": {}})
    licenses = read_json(MANIFEST_DIR / "licenses.json", {})
    stats = read_json(REPORTS_DIR / "dataset_statistics.json", {})
    raid = read_json(MANIFEST_DIR / "raid_sampling.json", {})
    base = read_json(REPORTS_DIR / "baseline_metrics.json", {})
    evals = {name: read_json(REPORTS_DIR / "eval" / f"{name}.json") for name in MODELS}
    experiments = {}
    for exp in sorted(CHECKPOINT_DIR.glob("*/experiment.json")):
        e = read_json(exp)
        experiments[e["experimentId"]] = e
    usage_tf = {}
    for exp_id, e in experiments.items():
        p = CHECKPOINT_DIR / exp_id / "train_usage.csv"
        if p.exists():
            usage_tf[exp_id] = pd.read_csv(p).to_dict("records")

    # ------------------------------------------------------------ per-model summary tables
    summary = {}
    for name, ev in evals.items():
        if not ev:
            continue
        sets = ev["sets"]
        test = sets.get("test", {})
        summary[name] = {
            "path": MODELS[name], "threshold": ev["threshold"],
            "validation": pick(sets.get("validation")),
            "test": pick(test),
            "spanish": pick(sets.get("test_spanish")),
            "academic": pick(sets.get("test_academic")),
            "ood": pick(sets.get("ood")),
            "adversarial": pick(sets.get("adversarial")),
            "unseen_generator": pick(sets.get("unseen_generator")),
            "unseen_domain": pick(sets.get("unseen_domain")),
            "robustness": {k: {"f1": v.get("f1"), "macro_f1": v.get("macro_f1"), "f1_drop_vs_clean": v.get("f1_drop_vs_clean"),
                               "machine_recall": v.get("machine_recall")}
                           for k, v in (ev.get("robustness") or {}).items()},
        }

    rec = args.recommended
    rec_eval = evals.get(rec) or {}
    # FP/FN of the recommended model are the canonical files
    for kind in ("false_positives", "false_negatives"):
        src = REPORTS_DIR / "eval" / f"{rec}_high_confidence_{kind}.jsonl"
        if src.exists():
            shutil.copy2(src, REPORTS_DIR / f"high_confidence_{kind}.jsonl")

    # reliability diagram data
    cal = read_json(MODELS_DIR / "calibrated" / "spanish_academic" / "calibration.json", {})
    rows = []
    for phase in ("reliability_before", "reliability_after"):
        for r in cal.get(phase, []):
            rows.append({"phase": phase.replace("reliability_", ""), "set": "validation", **r})
    for name in ("SPANISH_ACADEMIC_TRANSFORMER", "CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER"):
        ev = evals.get(name) or {}
        for set_name in ("test", "test_spanish", "test_academic"):
            for r in (ev.get("sets", {}).get(set_name, {}).get("reliability") or []):
                rows.append({"phase": name, "set": set_name, **r})
    if rows:
        pd.DataFrame(rows).to_csv(REPORTS_DIR / "reliability_diagram.csv", index=False)

    # ------------------------------------------------------------ dataset usage
    usage = {u["dataset"]: u for u in base.get("usage", [])}
    by_ds = stats.get("by_dataset", {})
    dataset_usage = {}
    for ds, d in by_ds.items():
        splits = d.get("by_split", {})
        dataset_usage[ds] = {
            "available_rows": d.get("rows_original"),
            "valid_rows": d.get("rows_valid"),
            "kept_rows": d.get("kept"),
            "train_pool_rows": splits.get("train", 0),
            "used_train_rows_baseline": usage.get(ds, {}).get("used_rows"),
            "used_train_docs_transformer": {k: next((r["used_train_docs"] for r in v if r["dataset"] == ds), 0)
                                            for k, v in usage_tf.items()},
            "used_validation_rows": splits.get("validation", 0),
            "used_test_rows": splits.get("test", 0),
            "other_eval_rows": {k: v for k, v in splits.items() if k not in ("train", "validation", "test")},
            "sampling_weight": usage.get(ds, {}).get("sampling_mass"),
        }

    report = {
        "task": "AI_DETECTOR_TRAINING",
        "generatedAt": utc_now(),
        "gitCommit": git_commit(),
        "datasetVersion": DATASET_VERSION,
        "modelVersion": MODEL_VERSION,
        "modelName": MODEL_DISPLAY_NAME,
        "hardware": hw,
        "datasets": {k: {kk: v.get(kk) for kk in ("status", "source", "version", "license", "rows", "files", "sha256",
                                                 "blocked_reason", "raw_deleted_after_build", "downloadedAt")}
                     for k, v in registry["datasets"].items()},
        "licenses": licenses,
        "raid_sampling": raid,
        "dataset_statistics": {k: stats.get(k) for k in ("rows_original", "rows_invalid", "rows_valid",
                                                          "exact_duplicates_removed", "near_duplicates_removed",
                                                          "label_conflicts", "holdout_exclusions", "kept_rows", "human",
                                                          "machine", "mixed", "spanish", "academic", "splits",
                                                          "groups", "largest_group", "near_dup", "leakage")},
        "dataset_usage": dataset_usage,
        "baselines": {"summary": base.get("summary"), "best": base.get("best"), "lodo": base.get("lodo"),
                      "spanish_train_weight": base.get("spanish_train_weight"),
                      "spanish_weight_selection": base.get("spanish_weight_selection"),
                      "duration_seconds": base.get("duration_seconds")},
        "experiments": {k: {kk: v.get(kk) for kk in ("mode", "smoke", "model", "modelRevision", "trainingConfig", "metrics",
                                                    "overfitting", "duration", "bestCheckpoint", "lastCheckpoint",
                                                    "checkpointBytes", "earlyStopped", "stoppedAtStep", "modelFallbackReason")}
                        for k, v in experiments.items()},
        "final_models": summary,
        "calibration": {k: cal.get(k) for k in ("selected", "cv_report", "validation", "selection")},
        "recommended": rec,
        "artifacts": {name: {"path": p, "bytes": dir_bytes(Path(p))} for name, p in MODELS.items()},
        "status": args.status,
    }
    write_json(REPORTS_DIR / "TRAINING_REPORT.json", report)
    write_markdown(report)
    write_error_analysis(rec, rec_eval)
    print("report written")
    return 0


def table(rows: list[list], header: list[str]) -> list[str]:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    for r in rows:
        out.append("| " + " | ".join(f(x) for x in r) + " |")
    return out


def write_markdown(r: dict) -> None:
    L = [f"# Training report — {r['modelName']} ({r['modelVersion']})", "",
         f"Generated {r['generatedAt']} · commit `{(r['gitCommit'] or '')[:10]}` · dataset `{r['datasetVersion']}`", "",
         "> Independent detector. Not a Turnitin model, not equivalent to Turnitin scores. Outputs P(HUMAN)/P(MACHINE).",
         "", f"**Status:** {r['status']}  ", f"**Recommended model:** `{r['recommended']}`", "", "## Hardware", ""]
    hw = r["hardware"]
    L += [f"- CPU: {hw.get('cpu')} ({hw.get('cpu_physical_cores')} cores / {hw.get('cpu_logical_cores')} threads)",
          f"- RAM: {hw.get('ram_gb')} GB", f"- GPU: {hw.get('gpu') or 'none (no CUDA, no MPS)'}; display adapters: {hw.get('display_adapters')}",
          f"- Disk free before: {hw.get('disk_free_before_gb')} GiB; safe floor: {hw.get('safe_disk_threshold_gb')} GB", ""]
    L += ["## Datasets and licences", ""]
    rows = []
    lic = {d["dataset"]: d for d in r["licenses"].get("datasets", [])}
    for k, v in r["datasets"].items():
        rows.append([k, v.get("status"), lic.get(k, {}).get("license", v.get("license")), v.get("rows"),
                     (v.get("blocked_reason") or "")[:80]])
    L += table(rows, ["dataset", "status", "license", "valid rows", "note"]) + [""]
    rs = r["raid_sampling"]
    if rs:
        L += [f"RAID: {rs.get('available_rows'):,} labelled rows available, stratified sample {rs.get('selected_rows'):,} "
              f"({100 * rs.get('coverage', 0):.2f} %), cap {rs.get('per_stratum_cap')} per stratum over {rs.get('strata')} strata "
              "(model × domain × attack × decoding × repetition penalty); every attack type equally represented.", ""]
    ds = r["dataset_statistics"]
    L += ["## Master dataset", ""]
    L += table([[k, ds.get(k)] for k in ("rows_original", "rows_valid", "exact_duplicates_removed", "near_duplicates_removed",
                                         "label_conflicts", "holdout_exclusions", "kept_rows", "human", "machine", "mixed",
                                         "spanish", "academic", "groups", "largest_group")], ["metric", "value"])
    L += ["", "Splits: `" + json.dumps(ds.get("splits")) + "`", "", "Invalid rows removed: `" + json.dumps(ds.get("rows_invalid")) + "`",
          "", "### Leakage controls", "", "```json", json.dumps(ds.get("leakage"), indent=2), "```", "",
          "### Per-dataset usage", ""]
    rows = []
    for k, u in r["dataset_usage"].items():
        rows.append([k, u["available_rows"], u["kept_rows"], u["train_pool_rows"], u["used_train_rows_baseline"],
                     sum(u["used_train_docs_transformer"].values()) if u["used_train_docs_transformer"] else 0,
                     u["used_validation_rows"], u["used_test_rows"], u["sampling_weight"]])
    L += table(rows, ["dataset", "available", "kept", "train pool", "used train (baseline)", "used train docs (transformers)",
                      "validation", "test", "sampling mass"]) + [""]
    b = r["baselines"]
    L += ["## Baselines", "", f"SPANISH_TRAIN_WEIGHT selected on validation: **{b.get('spanish_train_weight')}**", ""]
    if b.get("spanish_weight_selection"):
        L += table([[k, v["val_macro_f1"], v["val_spanish_macro_f1"], v["objective"]] for k, v in b["spanish_weight_selection"].items()],
                   ["es weight", "val macro F1", "val Spanish macro F1", "objective"]) + [""]
    if b.get("summary"):
        L += table([[k, v["validation"]["macro_f1"], v["validation_spanish_macro_f1"], v["validation_academic_macro_f1"],
                     v["threshold"], v["train_seconds"]] for k, v in b["summary"].items()],
                   ["baseline", "val macro F1", "val ES macro F1", "val academic macro F1", "threshold", "train s"])
        L += ["", f"Best baseline (validation objective): **{b.get('best')}**", ""]
    if b.get("lodo"):
        L += ["### Leave-one-dataset-out (TF-IDF + LR)", ""]
        L += table([[k, v.get("n"), v.get("macro_f1"), v.get("f1"), v.get("fpr")] for k, v in b["lodo"].items()],
                   ["held-out dataset", "n", "macro F1", "F1", "FPR"]) + [""]
    L += ["## Transformer experiments", ""]
    for k, e in r["experiments"].items():
        tc = e.get("trainingConfig") or {}
        m = (e.get("metrics") or {}).get("validation") or {}
        L += [f"### `{k}` ({e.get('mode')}{', smoke' if e.get('smoke') else ''})", "",
              f"- model `{e.get('model')}` @ `{(e.get('modelRevision') or '')[:10]}`; fallback: {e.get('modelFallbackReason')}",
              f"- windows {tc.get('train_windows')}, epochs {tc.get('epochs')}, lr {tc.get('learning_rate')}, max_length {tc.get('max_length')}, "
              f"stride {tc.get('stride')}, batch {tc.get('batch_size')}×{tc.get('gradient_accumulation')}, "
              f"trainable {((tc.get('freeze') or {}).get('trainable_params') or 0):,}/{((tc.get('freeze') or {}).get('total_params') or 0):,} params",
              f"- train time {(e.get('duration') or {}).get('train_seconds')} s, stopped at step {e.get('stoppedAtStep')}, early stopped: {e.get('earlyStopped')}",
              f"- validation macro F1 {f(m.get('macro_f1'))}, ROC-AUC {f(m.get('roc_auc'))}; aggregation {(e.get('metrics') or {}).get('best_aggregation')}",
              f"- overfitting check: `{json.dumps(e.get('overfitting'))}`",
              f"- checkpoints: best `{e.get('bestCheckpoint')}`, last `{e.get('lastCheckpoint')}`, bytes {e.get('checkpointBytes')}", ""]
        hist = (e.get("metrics") or {}).get("history") or []
        if hist:
            L += table([[h["step"], h["epoch"], h["train_loss"], h["val_loss"], h["val_macro_f1"], h["lr"], h["rss_gb"],
                         round(h["elapsed_s"])] for h in hist],
                       ["step", "epoch", "train loss", "val loss", "val macro F1", "lr", "RSS GB", "elapsed s"]) + [""]
    L += ["## Final comparison (TEST-side sets, evaluated once after selection)", ""]
    fm = r["final_models"]
    for section in ("test", "spanish", "academic", "ood", "adversarial", "unseen_generator", "unseen_domain"):
        L += [f"### {section}", ""]
        L += table([[n, v[section].get("n"), v[section].get("accuracy"), v[section].get("precision"), v[section].get("recall"),
                     v[section].get("f1"), v[section].get("macro_f1"), v[section].get("roc_auc"), v[section].get("pr_auc"),
                     v[section].get("fpr"), v[section].get("fnr"), v[section].get("mcc"), v[section].get("ece"),
                     v[section].get("brier")] for n, v in fm.items()],
                   ["model", "n", "acc", "prec", "recall", "F1", "macro F1", "ROC-AUC", "PR-AUC", "FPR", "FNR", "MCC",
                    "ECE", "Brier"]) + [""]
    L += ["### Adversarial robustness (RAID; same human pool, clean vs attacked machine text)", ""]
    for n, v in fm.items():
        rob = v.get("robustness") or {}
        if rob:
            L += [f"**{n}**", ""]
            L += table([[k, x.get("f1"), x.get("macro_f1"), x.get("f1_drop_vs_clean"), x.get("machine_recall")] for k, x in rob.items()],
                       ["attack", "F1", "macro F1", "F1 drop vs clean", "machine recall"]) + [""]
    cal = r["calibration"]
    if cal.get("selected"):
        L += ["## Calibration", "", f"Selected: **{cal['selected']['method']}** ({cal.get('selection')})", "",
              "```json", json.dumps(cal.get("validation"), indent=2), "```", "", "CV report:", "", "```json",
              json.dumps(cal.get("cv_report"), indent=2), "```", "",
              "Reliability-diagram data: `reports/reliability_diagram.csv`.", ""]
    L += ["## Artifacts", ""]
    L += table([[k, v["path"], round(v["bytes"] / 1e6, 1)] for k, v in r["artifacts"].items()], ["model", "path", "MB"]) + [""]
    findings = REPORTS_DIR / "findings.md"
    if findings.exists():  # hand-written interpretation of the numbers above
        L += ["", findings.read_text(encoding="utf-8")]
    (REPORTS_DIR / "TRAINING_REPORT.md").write_text("\n".join(L), encoding="utf-8")


def write_error_analysis(name: str, ev: dict) -> None:
    if not ev:
        return
    L = [f"# Error analysis — {name}", "", f"Threshold (BALANCED, chosen on validation): {f(ev['threshold'])}", ""]
    for set_name in ("test", "test_spanish", "test_academic", "ood", "adversarial", "unseen_generator", "unseen_domain"):
        s = ev["sets"].get(set_name)
        if not s:
            continue
        L += [f"## {set_name} (n={s['n']}, macro F1 {f(s.get('macro_f1'))}, FPR {f(s.get('fpr'))}, FNR {f(s.get('fnr'))})", ""]
        for col in ("language", "domain", "dataset", "generator_family", "length_bin", "attack"):
            groups = s["groups"].get(col, {})
            if len(groups) <= 1 and col == "attack":
                continue
            L += [f"### by {col}", ""]
            L += table([[k, g["n"], g.get("macro_f1"), g.get("f1"), g.get("precision"), g.get("recall"), g.get("fpr"),
                         g.get("fnr"), "yes" if g.get("small_sample") else ""]
                        for k, g in sorted(groups.items(), key=lambda kv: -kv[1]["n"])],
                       [col, "n", "macro F1", "F1", "precision", "recall", "FPR", "FNR", "small n"]) + [""]
    # confidence profile of errors
    scores = MODELS_DIR / "eval_scores" / f"{name}_scores.parquet"
    if scores.exists():
        df = pd.read_parquet(scores)
        df = df[df["eval_set"].isin(["test", "test_spanish", "test_academic"])].drop_duplicates("id")
        thr = ev["threshold"]
        df["pred"] = (df["score"] >= thr).astype(int)
        df["error"] = df["pred"] != df["label"]
        df["confidence"] = pd.cut((df["score"] - 0.5).abs() * 2, [0, 0.2, 0.5, 0.8, 0.95, 1.0001],
                                  labels=["<0.2", "0.2-0.5", "0.5-0.8", "0.8-0.95", ">0.95"], include_lowest=True)
        g = df.groupby("confidence", observed=False).agg(n=("error", "size"), error_rate=("error", "mean"))
        L += ["## Errors by confidence (test sets, deduplicated)", ""]
        L += table([[k, int(v["n"]), float(v["error_rate"]) if v["n"] else None] for k, v in g.iterrows()],
                   ["|p-0.5|×2", "n", "error rate"]) + [""]
    L += ["High-confidence errors: `reports/high_confidence_false_positives.jsonl`, "
          "`reports/high_confidence_false_negatives.jsonl` (text excerpts only for MIT/Apache/CC-BY sources).", ""]
    (REPORTS_DIR / "error_analysis.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
