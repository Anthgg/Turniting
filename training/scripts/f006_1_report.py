"""F006.1: build training/reports/F006_1_SPANISH_REPORT.{md,json} from the small JSON reports (training/reports/f006_1/)
and print the key numbers. Also copies run summaries and compacts large JSONs for Git.

    python scripts/f006_1_report.py
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
R = ROOT / "reports" / "f006_1"
D61 = Path("/content/drive/MyDrive/turniting/f006_1")
MODELS = ["CANDIDATE_MODEL_V3", "EXPERIMENTAL_F006_MODEL", "F006_1_MODEL"]
SUBSETS = ["all", "general", "spanish", "spanish_academic", "spanish_non_academic", "hard_human", "academic", "mixed", "ai_edited", "ood",
           "unseen_generator", "unseen_domain", "adversarial"]


def load(name):
    p = R / name
    if not p.exists() and (D61 / "reports" / name).exists():
        shutil.copy(D61 / "reports" / name, p)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def f(x, nd=3):
    return "n/a" if x is None else f"{x:.{nd}f}"


def cell(m):
    if not m:
        return "n/a"
    out = []
    if m.get("macro_f1") is not None:
        out.append(f"F1 {f(m['macro_f1'])}")
    if m.get("fpr") is not None:
        ci = m.get("fpr_ci95")
        out.append(f"FPR {f(m['fpr'])}" + (f" [{f(ci[0])}-{f(ci[1])}]" if ci else ""))
    if m.get("recall") is not None:
        out.append(f"rec {f(m['recall'])}")
    return " / ".join(out)


def rnd(o):
    if isinstance(o, float):
        return round(o, 4)
    if isinstance(o, dict):
        return {k: rnd(v) for k, v in o.items() if k != "confusion"}
    if isinstance(o, list):
        return [rnd(v) for v in o]
    return o


def main() -> int:
    R.mkdir(parents=True, exist_ok=True)
    names = ["spanish_distribution_audit.json", "new_spanish_sources.json", "split_distribution.json", "spanish_train_pool.json",
             "spanish_hard_human_pool.json", "v3_f006_disagreement.json", "calibration_pretraining.json", "ablations.json",
             "ablation_gate_check.json", "calibration.json", "validation.json", "model_lock.json", "final_holdout.json", "robustness.json",
             "historical_benchmarks.json", "gates.json", "candidate_model_v4_registry.json"]
    J = {n: load(n) for n in names}
    run = json.loads((D61 / "runs" / "F0061_FULL" / "run.json").read_text()) if (D61 / "runs" / "F0061_FULL" / "run.json").exists() else None
    if run:
        run["history"] = [{k: v for k, v in h.items() if k in ("step", "epoch", "selection", "elapsed_s")} for h in run["history"]]
        run.pop("v3_init_validation", None)
        (R / "F0061_FULL_run.json").write_text(json.dumps(rnd(run), indent=1, default=str))
    for n in ("final_holdout.json", "historical_benchmarks.json", "robustness.json", "ablations.json", "calibration.json", "validation.json",
              "spanish_distribution_audit.json", "v3_f006_disagreement.json", "model_lock.json"):
        if (R / n).exists():
            (R / n).write_text(json.dumps(rnd(json.loads((R / n).read_text())), indent=1))
    fh, rob, hist, gates, lock = J["final_holdout.json"], J["robustness.json"], J["historical_benchmarks.json"], J["gates.json"], J["model_lock.json"]
    md = ["# F006.1 — Spanish generalization hardening", "", "Research use only; never a Turnitin score.", ""]
    if gates:
        md += [f"**Result:** `{gates['status']}`; CANDIDATE_MODEL_V4 created: **{'YES' if gates['passed'] else 'NO'}**; ACTIVE: NO.", "",
               "Failed gates: " + (", ".join(k for k, v in gates["gates"].items() if not v) or "none"), ""]
    md += ["## Diagnosis", "", "See `f006_1/SPANISH_DISTRIBUTION_AUDIT.md`: the F006 Spanish holdout humans came from the official TEST splits "
           "of AuTexTification / IberAuTexTification (chat, how-to, news domains) that never occur in TRAIN or the F006 validation.", ""]
    sd = J["split_distribution.json"]
    if sd:
        v, h = sd["validation"], sd["holdout_metadata_only"]
        md += ["## Data", "", f"- F006_1 VALIDATION: {v['docs']:,} docs, {v['humans']:,} humans; Spanish {v['spanish_docs']:,} ({v['spanish_humans']:,} humans).",
               f"- F006_1 FINAL HOLDOUT (LOCKED): {h['docs']:,} docs, {h['humans']:,} humans; Spanish {h['spanish_docs']:,} ({h['spanish_humans']:,} humans).",
               f"- TRAIN_EXTRA: {sd['train_extra']['rows']:,} rows ({sd['train_extra']['humans']:,} humans). Leakage: {sd['leakage']['result']}.", ""]
    ns = J["new_spanish_sources.json"]
    if ns:
        md += [f"- New public Spanish human rows: {ns['rows_final']:,} ({ns['by_dataset']}), exact dup vs V2 removed {ns['exact_dup_vs_v2_removed']}, near dup removed {ns['near_dup_removed']}.", ""]
    ab = J["ablations.json"]
    if ab:
        md += ["## Stage A (F006_1 validation, proxy operating point general-human FPR 0.04)", "", "| run | score | elig | FPR all | FPR es | F1 es | mixed rec |", "|---|---|---|---|---|---|---|"]
        for r in sorted(ab["runs"], key=lambda x: x["selection"]["score"], reverse=True):
            s, sub = r["selection"], r["subsets"]
            md.append(f"| {r['run']} | {f(s['score'], 4)} | {s['eligible']} | {f(s['fprs']['fpr_all_humans'])} | {f(s['fprs']['spanish_fpr'])} | "
                      f"{f(sub.get('spanish', {}).get('macro_f1'))} | {f(sub.get('mixed', {}).get('recall'))} |")
        md.append("")
    if lock:
        md += ["## Lock", "", f"- parent {lock['parent']}; calibration {lock['calibration']}; global threshold {f(lock['thresholdGlobal'], 4)}, Spanish threshold {f(lock['thresholdSpanish'], 4)}",
               f"- sampling: human share {lock['trainingConfig']['human_share']}, Spanish mix {lock['trainingConfig']['es_mix']}, human weight {lock['trainingConfig']['human_weight']}, "
               f"es weight {lock['trainingConfig']['es_w']}, academic weight {lock['trainingConfig']['aca_w']}, paragraph share {lock['trainingConfig']['para_frac']}", ""]
    if fh:
        models = [m for m in MODELS if m in fh["models"]]
        md += ["## F006_1 FINAL HOLDOUT (evaluated once; each model with its own validation-fitted calibration option)", "",
               "| subset | " + " | ".join(f"{m} ({fh['models'][m]['calibration_option']})" for m in models) + " |", "|---|" + "---|" * len(models)]
        for s in SUBSETS:
            md.append(f"| {s} | " + " | ".join(cell(fh["models"][m]["subsets"].get(s)) for m in models) + " |")
        md.append("")
    if rob:
        md += ["### Robustness", "", "| model | zero-width F1 | homoglyph F1 | span token F1 |", "|---|---|---|---|"]
        for m in rob["models"]:
            md.append(f"| {m} | {f(rob['models'][m].get('zero_width', {}).get('macro_f1'))} | {f(rob['models'][m].get('homoglyph', {}).get('macro_f1'))} | {f(rob['span'].get(m, {}).get('token_f1'))} |")
        md.append("")
    if hist:
        md += ["### Historical (observed earlier; continuity only)", "", "| model | HISTORICAL_F006_SPANISH FPR | HISTORICAL_V1 v1_test FPR | v1_test_spanish FPR |", "|---|---|---|---|"]
        for m in hist["HISTORICAL_F006_SPANISH"]:
            md.append(f"| {m} | {f(hist['HISTORICAL_F006_SPANISH'][m]['spanish'].get('fpr'))} | {f(hist['HISTORICAL_V1'][m]['v1_test'].get('fpr'))} | {f(hist['HISTORICAL_V1'][m]['v1_test_spanish'].get('fpr'))} |")
        md += ["", hist["note"], ""]
    if gates:
        md += ["## Gates", ""] + [f"- {'PASS' if v else 'FAIL'} {k}" for k, v in gates["gates"].items()] + [""]
    (ROOT / "reports" / "F006_1_SPANISH_REPORT.md").write_text("\n".join(md), encoding="utf-8")
    (ROOT / "reports" / "F006_1_SPANISH_REPORT.json").write_text(json.dumps(rnd({"gates": gates, "lock": lock, "split": sd, "new_sources": ns,
                                                                                   "registry": J["candidate_model_v4_registry.json"]}), indent=1, default=str), encoding="utf-8")
    print("\n".join(md))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
