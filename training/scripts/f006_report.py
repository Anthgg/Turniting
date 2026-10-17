"""F006: build training/reports/F006_TRAINING_REPORT.{md,json} from the small JSON reports in training/reports/f006/.

    python scripts/f006_report.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
R = ROOT / "reports" / "f006"
MODELS = ["CANDIDATE_MODEL_V2", "CANDIDATE_MODEL_V3", "ENSEMBLE_V2_V3", "F006_MODEL", "F006_VALIDATION_ENSEMBLE"]
SUBSETS = ["all", "general", "hard_human", "spanish", "academic", "mixed", "ai_edited", "ood", "unseen_generator",
           "unseen_domain", "adversarial"]


def load(name):
    p = R / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def f(x, nd=3):
    return "n/a" if x is None else f"{x:.{nd}f}"


def cell(m: dict | None) -> str:
    if not m:
        return "n/a"
    parts = []
    if m.get("macro_f1") is not None:
        parts.append(f"F1 {f(m['macro_f1'])}")
    if m.get("fpr") is not None:
        ci = m.get("fpr_ci95")
        parts.append(f"FPR {f(m['fpr'])}" + (f" [{f(ci[0])}-{f(ci[1])}]" if ci else ""))
    if m.get("recall") is not None and m.get("macro_f1") is None:
        parts.append(f"recall {f(m['recall'])}")
    return " / ".join(parts) or "n/a"


def table(title: str, by_model: dict, subsets: list[str]) -> list[str]:
    models = [m for m in MODELS if m in by_model]
    out = [f"### {title}", "", "| subset | " + " | ".join(models) + " |", "|---|" + "---|" * len(models)]
    for s in subsets:
        out.append(f"| {s} | " + " | ".join(cell((by_model[m] or {}).get(s)) for m in models) + " |")
    return out + [""]


def main() -> int:
    val, hold, hist = load("f006_validation.json"), load("f006_final_holdout.json"), load("historical_v1_benchmark.json")
    rob, abl = load("robustness_eval.json"), load("ablation_results.json")
    lock, gates, reg = load("model_lock.json"), load("gates.json"), load("candidate_model_v4_registry.json")
    hard, gated, ext = load("hard_human_pool_v1_analysis.json"), load("gated_status.json"), load("external_holdout_2026.json")
    hman, vman, run = load("f006_final_holdout_manifest.json"), load("f006_validation_manifest.json"), load("F006_FULL_run.json")
    md = ["# F006 — Low-FPR Transformer + generalization hardening", "",
          "Research use only. Scores are estimates of an independent research detector, never a Turnitin score.", ""]
    if gates:
        md += [f"**Result:** status `{gates['status']}`; CANDIDATE_MODEL_V4 created: **{'YES' if gates['passed'] else 'NO'}**; ACTIVE: NO.", ""]
    md += ["## Data", ""]
    if hman and vman:
        md += [f"- F006_FINAL_HOLDOUT (LOCKED before training): {hman['docs']:,} docs, {hman['humans']:,} humans, {hman['groups']:,} groups; "
               f"ids sha256 `{hman['ids_sha256'][:16]}…`. Never-observed TEST-side groups only.",
               f"- F006 VALIDATION: {vman['docs']:,} docs, {vman['humans']:,} humans.",
               f"- Unseen generators: validation proxy {vman['unseen_generator_families']['validation_proxy']}, holdout {hman['unseen_generator_families']['holdout']}; "
               f"unseen domains: validation proxy {vman['unseen_domains']['validation_proxy']}, holdout {hman['unseen_domains']['holdout']}.",
               f"- Leakage (group / exact / parent-child / near-duplicate): {hman['leakage']['result']}.", ""]
    if hard:
        md += [f"- HARD_HUMAN_POOL (TRAIN only): {hard['pool_size']:,} docs from {hard['scored_humans']:,} scored TRAIN humans; "
               f"cut-off raw P >= {f(hard['cutoff_raw_prob'])} (top 15 %), <= 12 % per source dataset; "
               f"{f(hard['share_raw_prob_ge_0.50'])} of TRAIN humans already had raw P >= 0.5 under V3.", ""]
    if gated:
        md += ["- Gated datasets: " + ", ".join(f"{k} {v['status']}" for k, v in gated.items() if isinstance(v, dict)), ""]
    if abl:
        md += ["## Stage A ablations (F006 VALIDATION only)", "",
               "Selection rule: eligible (FPR all validation humans <= 0.05 at general-human FPR 0.04) first, then max F006_SELECTION_SCORE.", "",
               "| run | score | FPR all | ES FPR | ACA FPR | UGEN FPR | UDOM FPR | OOD FPR | mixed rec | hard FPR |", "|---|---|---|---|---|---|---|---|---|---|"]
        rows = sorted(abl["runs"], key=lambda r: r["selection"]["score"], reverse=True)
        v3 = abl.get("v3_init_on_f006_validation")
        if v3:
            rows = [{"run": "V3 (init, no training)", "selection": v3["selection"], "subsets": v3["subsets"]}] + rows
        for r in rows:
            s, sub = r["selection"], r["subsets"]
            md.append(f"| {r['run']} | {f(s['score'], 4)} | {f(s['fprs']['fpr_all_humans'])} | {f(s['fprs']['spanish_fpr'])} | {f(s['fprs']['academic_fpr'])} | "
                      f"{f(s['fprs']['unseen_generator_fpr'])} | {f(s['fprs'].get('unseen_domain_fpr'))} | {f(s['fprs']['ood_fpr'])} | "
                      f"{f(sub.get('mixed', {}).get('recall'))} | {f(sub.get('hard_human', {}).get('fpr'))} |")
        md.append("")
    if lock:
        md += ["## Locked configuration", "", f"- loss: {lock['loss']}", f"- sampling: {lock['sampling']}",
               f"- preprocessing: {lock['preprocessing']}", f"- calibration: {lock['calibration']['method']}; thresholds {lock['thresholds']}",
               f"- selected analyzer (validation): {lock['selectedAnalyzer']}", f"- model sha256 `{lock['modelSha256'][:16]}…`, locked {lock['lockedAt']}", ""]
    if run:
        md += [f"- training: {run['sampleAudit']['training_windows']:,} windows, {run['trainSeconds'] / 3600:.2f} h, "
               f"{run['throughputWindowsPerSec']} win/s, GPU {run.get('gpuMonitor')}, peak VRAM {run.get('peakVramGb')} GB", ""]
    md += ["## Results (each model at its own BALANCED threshold chosen on F006 VALIDATION)", ""]
    if val:
        md += table("F006 VALIDATION", {m: v["balanced"] for m, v in val["models"].items()}, SUBSETS)
    if hold:
        md += table("F006_FINAL_HOLDOUT (evaluated once, after the lock)", {m: v["BALANCED"]["subsets"] for m, v in hold["models"].items()}, SUBSETS)
    if rob:
        md += ["### Robustness (holdout copies)", "", "| model | zero-width F1 | homoglyph F1 | span token F1 |", "|---|---|---|---|"]
        for m, v in rob["models"].items():
            md.append(f"| {m} | {f(v['zero_width']['attacked']['BALANCED'].get('macro_f1'))} | {f(v['homoglyph']['attacked']['BALANCED'].get('macro_f1'))} | "
                      f"{f(rob['span_detection_head_c'].get(m, {}).get('token_f1'))} |")
        md.append("")
    if hist:
        md += table("HISTORICAL_V1_BENCHMARK (observed in F005; continuity only)",
                    {m: {s: v["BALANCED"] for s, v in sets.items()} for m, sets in hist["models"].items()},
                    ["v1_test", "v1_test_spanish", "v1_test_academic", "v1_ood", "v1_adversarial", "v1_unseen_generator", "v1_unseen_domain"])
    if ext:
        md += ["### EXTERNAL_HOLDOUT_2026", "", "| model | BALANCED |", "|---|---|"] + [f"| {m} | {cell(v['BALANCED'])} |" for m, v in ext["models"].items()] + [""]
    if gates:
        md += ["## CANDIDATE_MODEL_V4 gates", ""] + [f"- {'PASS' if v else 'FAIL'} {k}" for k, v in gates["gates"].items()] + \
              [f"- span token F1 >= 0.88 (recommended): {'PASS' if gates['span_gate'] else 'FAIL'}", ""]
    md += ["BEST_BASELINE: its artifact is not on Drive, so it was not re-evaluated in F006.", ""]
    (ROOT / "reports" / "F006_TRAINING_REPORT.md").write_text("\n".join(md), encoding="utf-8")
    summary = {"gates": gates, "registry": reg, "lock": lock, "holdout_manifest": hman, "validation_manifest": vman, "gated": gated,
               "hard_human_pool": hard, "ablations": abl and [{"run": r["run"], "config": r["config"], "selection": r["selection"]} for r in abl["runs"]]}
    (ROOT / "reports" / "F006_TRAINING_REPORT.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
    print("wrote F006_TRAINING_REPORT.md/.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
