"""Write TRAINING_V3_REPORT.md / .json (Drive v3/reports) and print the final key = value block.

Model choice uses VALIDATION V2 only (mean macro F1 over validation_v2, its Spanish and academic
subsets). V3 replaces CANDIDATE_MODEL_V2 only when it is better on validation AND improves most of
the target criteria on the frozen tests; otherwise V2 stays the winner (size is never a criterion).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import utc_now, write_json  # noqa: E402

V3_NAMES = ["TURNITING_RESEARCH_V3_GLOBAL", "CALIBRATED_TURNITING_RESEARCH_V3_GLOBAL",
            "TURNITING_RESEARCH_V3_SPANISH_ACADEMIC", "CALIBRATED_TURNITING_RESEARCH_V3_SPANISH_ACADEMIC"]


def rj(p: Path, default=None):
    return json.loads(p.read_text()) if p.exists() else default


def g(m, s, k="macro_f1"):
    v = (m or {}).get("sets", {}).get(s, {}).get(k)
    return None if v is None else float(v)


def val_primary(m):
    parts = [g(m, s) for s in ("validation_v2", "validation_v2_spanish", "validation_v2_academic")]
    parts = [p for p in parts if p is not None]
    return float(np.mean(parts)) if parts else None


def fmt(v, d=4):
    return "n/a" if v is None else (f"{v:.{d}f}" if isinstance(v, float) else str(v))


def criteria(m, v2):
    """(name, v3 value, v2 value, higher_is_better)"""
    st3, st2 = (m or {}).get("version_stability", {}), (v2 or {}).get("version_stability", {})
    return [
        ("academic_test_macro_f1", g(m, "test_v2_academic"), g(v2, "test_v2_academic"), True),
        ("spanish_test_macro_f1", g(m, "test_v2_spanish"), g(v2, "test_v2_spanish"), True),
        ("test_fpr", g(m, "test_v2", "fpr"), g(v2, "test_v2", "fpr"), False),
        ("mixed_recall", g(m, "test_v2_mixed", "recall"), g(v2, "test_v2_mixed", "recall"), True),
        ("ai_edited_macro_f1", g(m, "test_v2_ai_edited"), g(v2, "test_v2_ai_edited"), True),
        ("unseen_generator_macro_f1", g(m, "test_v2_unseen_generator"), g(v2, "test_v2_unseen_generator"), True),
        ("zero_width_macro_f1", g(m, "synthetic_zero_width"), g(v2, "synthetic_zero_width"), True),
        ("homoglyph_macro_f1", g(m, "synthetic_homoglyph"), g(v2, "synthetic_homoglyph"), True),
        ("unchanged_segment_drift", st3.get("overall_unchanged_segment_drift"), st2.get("overall_unchanged_segment_drift"), False),
    ]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--drive", default="/content/drive/MyDrive/turniting/v3")
    ap.add_argument("--work", default="/content/v3work")
    args = ap.parse_args()
    D = Path(args.drive)
    dl = rj(D / "manifests/TURNITING_DATASET_V2_DOWNLOAD_MANIFEST.json", {"datasets": {}})["datasets"]
    stats = rj(D / "manifests/dataset_v2_statistics.json", {})
    ids = rj(D / "experiment_ids.json", {})
    exps = {k: rj(D / "checkpoints" / v / "experiment.json", {}) for k, v in ids.items()}
    audits = {k: rj(D / "checkpoints" / v / "sample_audit.json", {}) for k, v in ids.items()}
    ev = rj(D / "reports/eval/v3_evaluation.json", {"models": {}})["models"]
    wsel = rj(D / "manifests/weight_selection.json", {})
    v2 = ev.get("CANDIDATE_MODEL_V2")
    vp = {n: val_primary(m) for n, m in ev.items() if m.get("sets")}
    v3_avail = [n for n in V3_NAMES if vp.get(n) is not None]
    best_v3 = max(v3_avail, key=lambda n: vp[n]) if v3_avail else None
    crit = criteria(ev.get(best_v3), v2) if best_v3 else []
    improved = [c for c in crit if c[1] is not None and c[2] is not None and ((c[1] > c[2] + 0.005) if c[3] else (c[1] < c[2] - 0.002))]
    worse = [c for c in crit if c[1] is not None and c[2] is not None and ((c[1] < c[2] - 0.01) if c[3] else (c[1] > c[2] + 0.01))]
    v3_wins = bool(best_v3 and vp.get("CANDIDATE_MODEL_V2") is not None and vp[best_v3] >= vp["CANDIDATE_MODEL_V2"] + 0.005
                   and len(improved) >= max(5, len(worse) + 3))
    best = best_v3 if v3_wins else "CANDIDATE_MODEL_V2"
    model_paths = {n: m.get("path") for n, m in ev.items()}
    best_ckpt = None
    if best_v3 and v3_wins:
        key = "refine" if "SPANISH" in best_v3 else "global"
        best_ckpt = str(D / "checkpoints" / ids.get(key, "") / "best")
    gm = exps.get("global", {}).get("gpuMonitor", {})
    rm = exps.get("refine", {}).get("gpuMonitor", {})
    hw = exps.get("global", {}).get("hardware", {})
    status = lambda s: sorted(k for k, v in dl.items() if v.get("status") == s)  # noqa: E731
    sb = stats.get("stage2", {})
    bm = ev.get(best_v3) if best_v3 else None

    def pair(set_name, k="macro_f1"):
        return f"V3 {fmt(g(bm, set_name, k))} | V2 {fmt(g(v2, set_name, k))}"

    stab3 = (bm or {}).get("version_stability", {})
    stab2 = (v2 or {}).get("version_stability", {})
    final = {
        "STATUS": "PASS" if ev and best_v3 else "PARTIAL",
        "GPU": f"{hw.get('gpu')} {hw.get('vram_gb')} GB (CUDA {hw.get('cuda')}, torch {hw.get('torch')})",
        "CPU": f"{hw.get('cpu_logical_cores')} logical cores",
        "RAM": f"{hw.get('ram_gb')} GB",
        "PEAK_VRAM": f"global {exps.get('global', {}).get('peakVramGb')} GB allocated (nvidia-smi max {gm.get('vram_used_max_gb')} GB) | "
                     f"refine {exps.get('refine', {}).get('peakVramGb')} GB",
        "GPU_UTILIZATION_OBSERVED": f"global mean {gm.get('gpu_util_mean')}% p50 {gm.get('gpu_util_p50')}% p90 {gm.get('gpu_util_p90')}% | "
                                    f"refine mean {rm.get('gpu_util_mean')}%",
        "DATASETS_REQUESTED": len(dl),
        "DATASETS_DOWNLOADED": ", ".join(status("DOWNLOADED") + status("EVAL_ONLY")),
        "DATASETS_BLOCKED": ", ".join(status("BLOCKED_ACCESS")) or "none",
        "DATASETS_FAILED": ", ".join(status("FAILED") + [k for k, v in stats.get("stage1", {}).items()
                                                         if v.get("status") == "FAILED_ADAPTER"]) or "none",
        "TURNITING_DATASET_V2_ROWS": stats.get("rows_kept"),
        "HUMAN_ROWS": stats.get("human"), "MACHINE_ROWS": stats.get("machine"), "MIXED_ROWS": stats.get("mixed"),
        "AI_EDITED_ROWS": stats.get("ai_edited"), "SPAN_LABELED_ROWS": stats.get("span_labeled"),
        "SPANISH_ROWS": stats.get("spanish"), "ACADEMIC_ROWS": stats.get("academic"),
        "GENERATORS": f"{stats.get('generators')} families",
        "LANGUAGES": stats.get("languages"),
        "EXACT_DUPLICATES_REMOVED": sb.get("exact_duplicates_removed"),
        "NEAR_DUPLICATES_REMOVED": sb.get("near_duplicates_removed"),
        "LEAKAGE": json.dumps(sb.get("leakage")),
        "TRAIN_WINDOWS": f"global {audits.get('global', {}).get('training_windows')} | refine {audits.get('refine', {}).get('training_windows')}",
        "VALIDATION_SIZE": stats.get("eval_sets", {}).get("validation_v2"),
        "GLOBAL_V3": f"val primary {fmt(vp.get('TURNITING_RESEARCH_V3_GLOBAL'))} | test macroF1 {fmt(g(ev.get('TURNITING_RESEARCH_V3_GLOBAL'), 'test_v2'))}",
        "SPANISH_ACADEMIC_V3": f"val primary {fmt(vp.get('TURNITING_RESEARCH_V3_SPANISH_ACADEMIC'))} | test macroF1 "
                               f"{fmt(g(ev.get('TURNITING_RESEARCH_V3_SPANISH_ACADEMIC'), 'test_v2'))}",
        "TEST": pair("test_v2"), "SPANISH_TEST": pair("test_v2_spanish"), "ACADEMIC_TEST": pair("test_v2_academic"),
        "MIXED_TEST": pair("test_v2_mixed", "recall") + " (recall)", "OOD": pair("v1_ood"),
        "UNSEEN_GENERATOR": pair("test_v2_unseen_generator"), "UNSEEN_DOMAIN": pair("test_v2_unseen_domain"),
        "ADVERSARIAL": pair("test_v2_adversarial", "recall") + " (recall)",
        "ZERO_WIDTH": pair("synthetic_zero_width"), "HOMOGLYPH": pair("synthetic_homoglyph"),
        "VERSION_STABILITY": f"unchanged-segment drift V3 {fmt(stab3.get('overall_unchanged_segment_drift'))} | V2 "
                             f"{fmt(stab2.get('overall_unchanged_segment_drift'))}",
        "V2_VS_V3": f"validation primary V3 {fmt(vp.get(best_v3) if best_v3 else None)} vs V2 {fmt(vp.get('CANDIDATE_MODEL_V2'))}; "
                    f"improved {[c[0] for c in improved]}; worse {[c[0] for c in worse]}",
        "BEST_MODEL": (f"{best_v3} -> CANDIDATE_MODEL_V3" if v3_wins else "CANDIDATE_MODEL_V2 (kept)"),
        "BEST_CHECKPOINT": best_ckpt or "MyDrive/turniting/workdir/checkpoints (V2, unchanged)",
        "MODEL_PATH": model_paths.get(best) or "",
        "TRAINING_DURATION": f"global {round(exps.get('global', {}).get('trainSeconds', 0) / 3600, 2)} h | refine "
                             f"{round(exps.get('refine', {}).get('trainSeconds', 0) / 3600, 2)} h",
        "DATASET_BUILD_DURATION": f"{round(stats.get('buildSeconds', 0) / 60, 1)} min",
    }
    report = {"generatedAt": utc_now(), "final": final, "validationPrimary": vp, "criteria": crit,
              "weightSelection": wsel, "experiments": exps, "sampleAudits": audits, "downloadManifest": dl,
              "datasetStatistics": {k: v for k, v in stats.items() if k not in ("by_dataset",)},
              "evaluation": ev, "v3Wins": v3_wins}
    write_json(D / "reports/TRAINING_V3_REPORT.json", report)
    L = ["# TURNITING_RESEARCH_V3 — training report", "",
         "Independent research detector. Not a Turnitin model. No Turnitin reports, VALIDATION_CASE_001 or private",
         "documents were used for training, tuning, calibration or thresholds. Research / non-commercial use only.", "",
         "## Final", "", "```"] + [f"{k} = {v}" for k, v in final.items()] + ["```", "",
         "## Validation (model choice)", "", "| model | val primary | validation_v2 | spanish | academic |", "|---|---:|---:|---:|---:|"]
    for n, m in ev.items():
        if m.get("sets"):
            L.append(f"| {n} | {fmt(vp.get(n))} | {fmt(g(m, 'validation_v2'))} | {fmt(g(m, 'validation_v2_spanish'))} | "
                     f"{fmt(g(m, 'validation_v2_academic'))} |")
    sets = sorted({s for m in ev.values() for s in m.get("sets", {})})
    for metric in ("macro_f1", "roc_auc", "fpr", "recall", "ece"):
        L += ["", f"## Test sets — {metric}", "", "| set | " + " | ".join(ev) + " |", "|---|" + "---:|" * len(ev)]
        for s in sets:
            if s.startswith("validation"):
                continue
            L.append(f"| {s} | " + " | ".join(fmt(g(m, s, metric)) for m in ev.values()) + " |")
    L += ["", "## Criteria V3 vs V2 (best V3 by validation)", "", "| criterion | V3 | V2 | better |", "|---|---:|---:|---|"]
    for name, a, b, hib in crit:
        L.append(f"| {name} | {fmt(a)} | {fmt(b)} | {'higher' if hib else 'lower'} |")
    L += ["", "## Span detection / version stability", "", "```json",
          json.dumps({n: {"span": m.get("span_detection"), "stability": m.get("version_stability")} for n, m in ev.items()}, indent=1),
          "```", "", "## Datasets", "", "| dataset | status | license | rows kept |", "|---|---|---|---:|"]
    for k, v in dl.items():
        L.append(f"| {k} | {v.get('status')} | {v.get('license')} | {stats.get('by_dataset', {}).get(k, {}).get('kept', 0):,} |")
    (D / "reports/TRAINING_V3_REPORT.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(f"{k} = {v}" for k, v in final.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
