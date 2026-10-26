"""F008.3 final report: KEY = VALUE contract + markdown + JSON (training/F008_3_FINAL_REPORT.{md,json}).

    python scripts/f0083_report.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import write_json  # noqa: E402

D = Path("/content/drive/MyDrive/turniting/f008_3")
EVAL, MANI = D / "evaluation", D / "datasets" / "manifests"
REPO = Path(__file__).resolve().parents[1]
L5 = ["es", "en", "pt", "fr", "de"]


def rj(p: Path) -> dict:
    return json.loads(p.read_text()) if p.exists() else {}


def f(x, n=4):
    return "NA" if x is None else (f"{x:.{n}f}" if isinstance(x, float) else str(x))


def mean(xs):
    xs = [x for x in xs if x is not None]
    return float(np.mean(xs)) if xs else None


def main() -> int:
    git = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True, cwd=REPO).stdout.strip()  # noqa: E731
    comp, fin = rj(EVAL / "validation_comparison.json"), rj(EVAL / "final_external_holdout.json")
    lk, pre = rj(MANI / "F008_3_MODEL_LOCK.json"), rj(REPO / "reports" / "f008_3" / "preflight.json")
    ch = comp.get("summary", {}).get("chosen")
    cfg = ch if ch and ch in fin.get("configs", {}) else "C0"
    r = fin.get("configs", {}).get(cfg, {})
    ret, pairs = r.get("retrieval", {}), r.get("pairs", {})
    tasks = list(ret.get("cross", {}).values()) + list(ret.get("mono", {}).values())
    rk = lambda k: mean([t.get("reranked", {}).get(k) for t in tasks])  # noqa: E731
    sushi = r.get("long_distance_regression_sushi", {})
    fpr = {c: v.get("fpr") for c, v in pairs.get("fpr_by_class", {}).items()}
    names = {"C0": ("BM25 + frozen BGE-M3", "F008.2 B_RERANK", "RRF"), "C1": ("BM25 + frozen BGE-M3", "R1", "RRF"), "C2": ("BM25 + D1", "F008.2 B_RERANK", "RRF"),
             "C3": ("BM25 + D1", "R1", "RRF"), "C4": ("BM25 + D1", "R1", "weighted 0.3/0.7, depth 100")}
    kv = {"PHASE": "F008_3", "GIT_BRANCH": git("rev-parse", "--abbrev-ref", "HEAD"), "GIT_COMMIT": git("rev-parse", "HEAD"), "COLAB_USED": "YES",
          "COLAB_NOTEBOOK": "training/notebooks/colab_f008_3.ipynb", "DRIVE_ROOT": "MyDrive/turniting/f008_3", "GPU": pre.get("GPU"),
          "NEW_DATASETS": "FLORES-200 (CC BY-SA 4.0), TaPaCo (CC BY 2.0), Opusparcus test (CC BY-NC 4.0, eval), XNLI (CC BY-NC 4.0), STSb-multi-MT (research), PAWS-X de/fr train, claude_pairs_multilingual (aux)",
          "TOTAL_PAIRS": pre.get("TOTAL_PAIRS"), "CROSS_LANGUAGE_PAIRS": pre.get("CROSS_LANGUAGE_PAIRS"), "LONG_DISTANCE_PAIRS": pre.get("LONG_DISTANCE_PAIRS"),
          "HARD_NEGATIVE_PAIRS": pre.get("HARD_NEGATIVES"), "BEST_RETRIEVER": names.get(cfg, ("NA",) * 3)[0], "BEST_RERANKER": names.get(cfg, ("NA",) * 3)[1],
          "BEST_FUSION": names.get(cfg, ("NA",) * 3)[2], "LOCKED_CONFIG": lk.get("config", "NO_MODEL_LOCK (C0 reference)"),
          "RECALL_AT_1": f(rk("recall@1")), "RECALL_AT_5": f(rk("recall@5")), "RECALL_AT_10": f(rk("recall@10")), "MRR": f(rk("mrr")), "NDCG10": f(rk("ndcg@10")),
          "PARAPHRASE_PRECISION": f(pairs.get("paraphrase_precision")), "PARAPHRASE_RECALL": f(pairs.get("paraphrase_recall")),
          "PARAPHRASE_F1": f(pairs.get("paraphrase_f1")), "LONG_DISTANCE_PRECISION": f(sushi.get("paraphrase_precision")),
          "LONG_DISTANCE_RECALL": f(sushi.get("paraphrase_recall")), "LONG_DISTANCE_F1": f(sushi.get("paraphrase_f1")),
          "TRANSLATED_RECALL_AT_10": f(mean([t.get("reranked", {}).get("recall@10") for t in ret.get("cross", {}).values()])),
          "LEXICAL_HARD_NEGATIVE_FPR": f(fpr.get("LEXICAL_HARD_NEGATIVE")), "NUMBER_CHANGE_FPR": f(fpr.get("NUMBER_CHANGED_NEGATIVE")),
          "ENTITY_CHANGE_FPR": f(fpr.get("ENTITY_CHANGED_NEGATIVE")), "NEGATION_FPR": f(fpr.get("NEGATION_HARD_NEGATIVE")),
          "CAUSALITY_CHANGE_FPR": f(fpr.get("CAUSALITY_CHANGED_NEGATIVE")),
          **{f"{l.upper()}_RECALL_AT_10": f(ret.get("mono", {}).get(l, {}).get("reranked", {}).get("recall@10")) for l in L5},
          "ES_EN_RECALL_AT_10": f(ret.get("cross", {}).get("es-en", {}).get("reranked", {}).get("recall@10")),
          "EXACT_COPY_REGRESSION": "PASS" if ret.get("exact_copy_regression", {}).get("pass") else "FAIL" if ret else "NA",
          "FINAL_HOLDOUT_TUNING": "NO", "MODEL_STATUS": "EXPERIMENTAL", "ACTIVE_MODEL": "NONE", "STATUS": "COMPLETE" if fin else "INCOMPLETE"}
    lines = [f"{k} = {v}" for k, v in kv.items()]
    print("\n".join(lines))
    md = ["# F008.3 MULTILINGUAL PARAPHRASE + TRANSLATED SIMILARITY HARDENING", "", "```", *lines, "```", "",
          "Metrics are FINAL_EXTERNAL_HOLDOUT (FLORES devtest, Opusparcus test, XNLI test; no Claude rows), evaluated once after the lock. "
          "Long-distance numbers are the Sushi LONG_DISTANCE_PARAPHRASE_REGRESSION set (never trained on). Everything stays EXPERIMENTAL.", "",
          "## Validation comparison (gates fixed before training)", "", "| config | score | eligible | failed gates |", "|---|---|---|---|"]
    for k, v in comp.get("summary", {}).get("scores", {}).items():
        md.append(f"| {k} | {f(v.get('score'))} | {v.get('eligible')} | {', '.join(g for g, ok in v.get('gates', {}).items() if not ok) or '-'} |")
    md += ["", "## Final holdout: retrieval R@10 by stage", "", "| config | task | BM25 | dense | candidate generation | reranked |", "|---|---|---|---|---|---|"]
    for c, rr in fin.get("configs", {}).items():
        for grp in ("cross", "mono"):
            for t, v in rr.get("retrieval", {}).get(grp, {}).items():
                md.append(f"| {c} | {grp} {t} | " + " | ".join(f(v.get(s, {}).get("recall@10")) for s in ("bm25", "dense", "candidate_generation", "reranked")) + " |")
    (REPO / "F008_3_FINAL_REPORT.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    write_json(REPO / "F008_3_FINAL_REPORT.json", {"contract": kv, "validation_summary": comp.get("summary"), "final": fin})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
