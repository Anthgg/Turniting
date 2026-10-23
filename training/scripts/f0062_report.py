"""F006.2 final report: KEY = VALUE contract + markdown, from the Drive manifests / reports (no text, no weights).

    python scripts/f0062_report.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0062_common import D, MANI, REPO, write_json  # noqa: E402


def rj(p: Path):
    return json.loads(p.read_text()) if p.exists() else None


def main() -> int:
    src = rj(MANI / "f006_2_sources.json") or {"sources": {}}
    cl = rj(MANI / "claude_es_academic.json") or {}
    hman = rj(MANI / "f006_2_final_external_holdout.json") or {}
    val = rj(MANI / "f006_2_validation.json") or {}
    cal = rj(MANI / "f006_2_calibration.json") or {}
    ood = rj(MANI / "f006_2_ood.json") or {}
    extra = rj(MANI / "f006_2_train_extra.json") or {}
    comp = rj(D / "reports" / "validation_comparison.json") or {}
    fin = rj(D / "reports" / "final_external_holdout.json") or {}
    reg = rj(MANI / "model_registry_f006_2.json") or {}
    lk = rj(MANI / "F006_2_MODEL_LOCK.json") or {}
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=REPO).stdout.strip()
    dd = hman.get("dedup", {})
    me = (fin.get("models") or {}).get("EXPERIMENTAL_F006_2_MODEL", {}).get("sets", {})
    g = lambda s, k: (me.get(s) or {}).get(k)  # noqa: E731
    new_rows = extra.get("new_by_dataset_label", {})
    status = "COMPLETED" if fin else "STOPPED_BEFORE_FINAL" if hman else "STOPPED_BEFORE_SPLITS"
    kv = {
        "STATUS": status, "PHASE": "F006_2", "GIT_BRANCH": "exp/f006-2-modern-spanish-academic-hardening", "GIT_COMMIT": commit, "GIT_PUSH": "SEE_BRANCH",
        "COLAB_NOTEBOOK": "training/notebooks/colab_f006_2.ipynb", "COLAB_USED": "YES", "DRIVE_ROOT": "MyDrive/turniting/f006_2",
        "GPU": (comp.get("models", {}).get(lk.get("candidate", ""), {}).get("run", {}).get("hardware", {}) or {}).get("gpu_name"),
        "NEW_SOURCES_FOUND": 5, "NEW_SOURCES_ALLOWED": 3,
        "NEW_SPANISH_ROWS": sum(v for k, v in new_rows.items() if "tdx" in k or "claude" in k) + (ood.get("docs") or 0),
        "NEW_HUMAN_ACADEMIC_ROWS": (src["sources"].get("tdx_thesis_es") or {}).get("rows"),
        "NEW_MACHINE_ROWS": sum(v for k, v in new_rows.items() if not k.endswith("|HUMAN")),
        "CLAUDE_GENERATED_ROWS": cl.get("rows"), "MIXED_ROWS": sum(v for k, v in new_rows.items() if k.endswith("|MIXED")),
        "EXACT_DUP_REMOVED": (dd.get("exact_within_new_removed") or 0) + (dd.get("exact_vs_historical_removed") or 0),
        "NEAR_DUP_REMOVED": dd.get("near_vs_historical_spanish_academic_removed"),
        "CROSS_SPLIT_LEAKAGE": 0 if hman.get("leakage", {}).get("result") == "PASS" else "FAIL",
        "PARENT_LEAKAGE": (hman.get("gates") or {}).get("PARENT_OVERLAP"), "SOURCE_LEAKAGE": (hman.get("gates") or {}).get("SOURCE_LEAKAGE"),
        "TRAIN_ROWS": extra.get("rows"), "VALIDATION_ROWS": val.get("docs"), "CALIBRATION_ROWS": cal.get("docs"), "OOD_ROWS": ood.get("docs"),
        "UNSEEN_GENERATOR_ROWS": (hman.get("by_primary") or {}).get("unseen_generator", {}).get("docs"), "FINAL_EXTERNAL_HOLDOUT_ROWS": hman.get("docs"),
        "BASELINE": "EXPERIMENTAL_F006_1_1_MODEL", "EXPERIMENTAL_MODEL": "EXPERIMENTAL_F006_2_MODEL" if fin else None,
        "MACRO_F1": g("ALL", "macro_f1"), "ROC_AUC": g("ALL", "roc_auc"), "PR_AUC": g("ALL", "pr_auc"), "SPANISH_F1": g("SPANISH", "macro_f1"),
        "ACADEMIC_F1": "NOT_MEASURABLE_IN_FINAL (human-only academic subset); ACADEMIC_FPR = " + str(g("ACADEMIC", "fpr")),
        "OOD_F1": g("OOD", "macro_f1"), "UNSEEN_GENERATOR_F1": g("UNSEEN_GENERATOR", "macro_f1"), "FPR": g("ALL", "fpr"), "FNR": g("ALL", "fnr"),
        "RECALL": g("ALL", "recall"), "PRECISION": g("ALL", "precision"), "ECE": g("ALL", "ece"), "BRIER": g("ALL", "brier"),
        "FINAL_EXTERNAL_HOLDOUT_EVALUATED": "YES (once)" if fin else "NO", "FINAL_HOLDOUT_TUNING": "NO",
        "MODEL_STORAGE": "GOOGLE_DRIVE:" + reg["logical_path"] if reg else None, "MODEL_SHA256": reg.get("SHA256"),
        "MODEL_STATUS": "EXPERIMENTAL", "MODEL_PROMOTED": "NO", "ACTIVE_MODEL": "NONE",
    }
    base = (fin.get("models") or {}).get("EXPERIMENTAL_F006_1_1_MODEL", {}).get("sets", {})
    lines = ["# F006.2 — Spanish academic + modern generator hardening (Track A)", "",
             "Status: EXPERIMENTAL; promoted: NO; active model: NONE.", "",
             "## Final external holdout (evaluated once, after MODEL_LOCK)", "",
             "| Set | Metric | F006.2 | F006.1.1 |", "|---|---|---|---|"]
    for s in ("ALL", "SPANISH", "ACADEMIC", "OOD", "UNSEEN_GENERATOR", "MIXED", "AI_EDITED"):
        for k in ("fpr", "recall", "macro_f1", "ece"):
            a, b = (me.get(s) or {}).get(k), (base.get(s) or {}).get(k)
            if a is not None or b is not None:
                lines.append(f"| {s} | {k} | {a if a is None else round(a, 4)} | {b if b is None else round(b, 4)} |")
    lines += ["", "## Output contract", "", "```"] + [f"{k} = {v}" for k, v in kv.items()] + ["```", ""]
    (REPO / "reports" / "F006_2_FINAL_REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    write_json(REPO / "reports" / "F006_2_FINAL_REPORT.json", {"contract": kv, "final": fin, "validation_summary": comp.get("summary")})
    print("\n".join(f"{k} = {v}" for k, v in kv.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
