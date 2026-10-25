"""F006.3 final report: KEY = VALUE contract + markdown + JSON (training/F006_3_FINAL_REPORT.{md,json}).

    python scripts/f0063_report.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0063_common import D, LANGS, MANI, REPO, write_json  # noqa: E402


def rj(p: Path) -> dict:
    return json.loads(p.read_text()) if p.exists() else {}


def f(x, n=4):
    return "NA" if x is None else (f"{x:.{n}f}" if isinstance(x, float) else str(x))


def main() -> int:
    git = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True, cwd=REPO).stdout.strip()  # noqa: E731
    comp = rj(D / "reports" / "validation_comparison.json")
    fin = rj(D / "reports" / "final_external_holdout.json")
    hman = rj(MANI / "f006_3_final_external_holdout.json")
    val, cal = rj(MANI / "f006_3_validation.json"), rj(MANI / "f006_3_calibration.json")
    tx = rj(MANI / "f006_3_train_extra.json")
    split = rj(REPO / "reports" / "f006_3" / "split_report.json")
    summ = comp.get("summary", {})
    best = summ.get("chosen")
    key = "EXPERIMENTAL_F006_3_MODEL" if best and "EXPERIMENTAL_F006_3_MODEL" in fin.get("models", {}) else "EXPERIMENTAL_F006_1_1_MODEL"
    fm = fin.get("models", {}).get(key, {})
    sets = fm.get("sets", {})
    vb = comp.get("models", {}).get(best or "", {})
    by_lang = {l: sum(int(d.get("by_language", {}).get(l, 0)) for d in (val, cal, hman)) + int(tx.get("new_by_language", {}).get(l, 0)) for l in LANGS}
    claude_rows = sum(v for k, v in tx.get("new_by_dataset_label", {}).items() if k.startswith("f0063_claude"))
    nb = tx.get("new_by_dataset_label", {})
    gpu = (vb.get("run", {}).get("hardware") or {}).get("gpu") if vb else None
    kv = {"PHASE": "F006_3", "GIT_BRANCH": git("rev-parse", "--abbrev-ref", "HEAD"), "GIT_COMMIT": git("rev-parse", "HEAD"), "COLAB_USED": "YES",
          "COLAB_NOTEBOOK": "training/notebooks/colab_f006_3.ipynb", "DRIVE_ROOT": "MyDrive/turniting/f006_3", "GPU": gpu or "see run.json",
          "NEW_DATASETS": "openalex_academic(CC0), aigtbench(Apache-2.0), open_llm_multilingual(Qwen2.5-14B, Mistral-Nemo-12B, OLMo-2-7B, Phi-3.5-mini, Granite-3.1-8B), claude_multilingual(aux), mixed_language_documents",
          "NEW_LANGUAGES": "pt, fr, de (+ it, nl language-OOD)", "TOTAL_LANGUAGES": 7,
          **{f"{l.upper()}_ROWS": by_lang[l] for l in LANGS},
          "MIXED_LANGUAGE_ROWS": sum(int(v) for v in split.get("mixed_documents", {}).values()),
          "HUMAN_ROWS": sum(int(d.get("humans", 0)) for d in (val, cal, hman)) + sum(v for k, v in nb.items() if k.endswith("|HUMAN")),
          "AI_ROWS": sum(int(d.get("machines", 0)) for d in (val, cal, hman)) + sum(v for k, v in nb.items() if not k.endswith("|HUMAN")),
          "MIXED_ROWS": sum(int(d.get("mixed_rows", 0)) for d in (val, cal, hman)) + sum(v for k, v in nb.items() if k.endswith("|MIXED")),
          "CLAUDE_ROWS": claude_rows, "TRAIN_ROWS": tx.get("rows"), "VALIDATION_ROWS": val.get("docs"), "CALIBRATION_ROWS": cal.get("docs"),
          "FINAL_HOLDOUT_ROWS": hman.get("docs"), "BASELINE": "EXPERIMENTAL_F006_1_1_MODEL", "BEST_CANDIDATE": best or "NONE",
          "GATE_STATUS": summ.get("status"), "GLOBAL_MACRO_F1": f(sets.get("ALL", {}).get("macro_f1")),
          **{f"{l.upper()}_F1": f(sets.get(f"LANG_{l.upper()}", {}).get("macro_f1")) for l in LANGS},
          "MIXED_LANGUAGE_F1": f(fm.get("mixed_language", {}).get("MIXED_LANGUAGE_F1")),
          "ACADEMIC_FPR": f"es {f(sets.get('ACADEMIC_ES', {}).get('fpr'))} / en {f(sets.get('ACADEMIC_EN', {}).get('fpr'))}",
          "UNSEEN_GENERATOR_RECALL": f(sets.get("UNSEEN_GENERATOR", {}).get("recall")),
          "LANGUAGE_OOD_F1": f(sets.get("LANGUAGE_OOD", {}).get("macro_f1")),
          "HISTORICAL_FORGETTING_PP": f(vb.get("gates", {}).get("forgetting_macro_f1", {}).get("drop_pp"), 2) if vb else "NA",
          "FINAL_HOLDOUT_TUNING": "NO", "MODEL_STATUS": "EXPERIMENTAL", "MODEL_PROMOTED": "NO", "ACTIVE_MODEL": "NONE",
          "STATUS": "COMPLETE" if fin else "INCOMPLETE"}
    lines = [f"{k} = {v}" for k, v in kv.items()]
    print("\n".join(lines))
    md = ["# F006.3 MULTILINGUAL ACADEMIC + MODERN GENERATOR HARDENING", "", "```", *lines, "```", "",
          "Every model stays EXPERIMENTAL; nothing is active or promoted. FINAL_EXTERNAL_HOLDOUT was evaluated once after the lock.", "",
          "## Validation comparison (gates fixed before training)", "", "| model | score | eligible | gates | forgetting ok |", "|---|---|---|---|---|"]
    for k, v in summ.get("scores", {}).items():
        md.append(f"| {k} | {f(v.get('score'))} | {v.get('eligible')} | {v.get('gates_all_pass')} | {v.get('forgetting_pass')} |")
    md += ["", "## Final holdout per model", "", "| model | macro F1 | ES | EN | PT | FR | DE | mixed-lang F1 | human-doc false flag | unseen recall |",
           "|---|---|---|---|---|---|---|---|---|---|"]
    for k, v in fin.get("models", {}).items():
        s, ml = v.get("sets", {}), v.get("mixed_language", {})
        md.append(f"| {k} | {f(s.get('ALL', {}).get('macro_f1'))} | " + " | ".join(f(s.get(f'LANG_{l.upper()}', {}).get('macro_f1')) for l in LANGS) +
                  f" | {f(ml.get('MIXED_LANGUAGE_F1'))} | {f(ml.get('HUMAN_DOC_FALSE_FLAG_RATE'))} | {f(s.get('UNSEEN_GENERATOR', {}).get('recall'))} |")
    (REPO / "F006_3_FINAL_REPORT.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    write_json(REPO / "F006_3_FINAL_REPORT.json", {"contract": kv, "validation_summary": summ, "final": fin})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
