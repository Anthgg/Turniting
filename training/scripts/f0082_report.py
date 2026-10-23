"""F008.2 final report: KEY = VALUE contract + markdown (no text, no weights).   python scripts/f0082_report.py"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import D, MANI, REPO, write_json  # noqa: E402


def rj(p: Path):
    return json.loads(p.read_text()) if p.exists() else {}


def main() -> int:
    tr, va, ca, fh = (rj(MANI / f"f008_2_{k}.json") for k in ("train", "validation", "calibration", "final_external_holdout"))
    cl = rj(MANI / "claude_pairs.json")
    comp = rj(D / "reports" / "validation_comparison.json")
    fin = rj(D / "reports" / "final_external_holdout.json")
    lk = rj(MANI / "F008_2_MODEL_LOCK.json")
    reg = rj(MANI / "model_registry_f008_2.json")
    bi = rj(REPO / "reports" / "f008_2" / "train_biencoder.json")
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=REPO).stdout.strip()
    cfg = lk.get("config")
    me = (fin.get("configs") or {}).get(cfg, {})
    pm, ret = me.get("pairs", {}), me.get("retrieval", {})
    pipe = ret.get("pipeline")
    g = lambda s, k: ((ret.get(s) or {}).get(pipe) or {}).get(k)  # noqa: E731
    fpr = lambda c, src=pm: (src.get("fpr_by_class", {}).get(c) or {}).get("fpr")  # noqa: E731
    hn = me.get("hard_negative_ood", {})
    sp = me.get("spans_synthetic", {})
    dd = tr.get("dedup", {})
    lkg = fh.get("leakage", {})
    kv = {
        "STATUS": "COMPLETED" if fin else "STOPPED_BEFORE_FINAL" if fh else "STOPPED_BEFORE_SPLITS", "PHASE": "F008_2",
        "GIT_BRANCH": "exp/f008-2-paraphrase-similarity-training", "GIT_COMMIT": commit, "GIT_PUSH": "SEE_BRANCH",
        "COLAB_NOTEBOOK": "training/notebooks/colab_f008_2.ipynb", "COLAB_USED": "YES", "DRIVE_ROOT": "MyDrive/turniting/f008_2",
        "GPU": bi.get("gpu"), "VRAM": bi.get("vram_gib"),
        "NEW_PARAPHRASE_SOURCES": "Sushi corpus (CC0, final holdout), STS-es MTEB test (CC BY 4.0, OOD), Claude pairs (train only)",
        "NEW_PAIR_COUNT": (tr.get("pairs") or 0) + (fh.get("pairs") or 0), "CLAUDE_PAIR_COUNT": cl.get("pairs"),
        "HARD_NEGATIVE_COUNT": sum(v for k, v in (tr.get("by_class") or {}).items() if "NEGATIVE" in k),
        "TRANSLATED_PAIR_COUNT": (tr.get("by_class") or {}).get("TRANSLATED_PARAPHRASE"),
        "EXACT_DUP_REMOVED": (dd.get("exact_within_train_removed") or 0) + (dd.get("exact_vs_eval_removed") or 0), "NEAR_DUP_REMOVED": dd.get("near_vs_eval_removed"),
        "CROSS_SPLIT_LEAKAGE": lkg.get("CROSS_SPLIT_LEAKAGE"), "PARENT_LEAKAGE": lkg.get("PARENT_LEAKAGE"), "SOURCE_LEAKAGE": lkg.get("SOURCE_LEAKAGE"),
        "TRAIN_PAIRS": tr.get("pairs"), "VALIDATION_PAIRS": va.get("pairs"), "CALIBRATION_PAIRS": ca.get("pairs"), "FINAL_HOLDOUT_PAIRS": fh.get("pairs"),
        "BEST_RETRIEVER": {"C_HYBRID": "BM25 + fine-tuned BGE-M3 (RRF)", "A_BIENC": "BM25 + fine-tuned BGE-M3 (RRF)", "B_RERANK": "BM25 + frozen BGE-M3 (RRF)"}.get(cfg),
        "BEST_RERANKER": {"C_HYBRID": "fine-tuned bge-reranker-v2-m3", "B_RERANK": "fine-tuned bge-reranker-v2-m3"}.get(cfg, "none"),
        "BEST_FUSION": cfg, "RECALL_AT_1": g("spanish", "recall@1"), "RECALL_AT_5": g("spanish", "recall@5"), "RECALL_AT_10": g("spanish", "recall@10"),
        "MRR": g("spanish", "mrr"), "NDCG10": g("spanish", "ndcg@10"),
        "PARAPHRASE_PRECISION": pm.get("paraphrase_precision"), "PARAPHRASE_RECALL": pm.get("paraphrase_recall"), "PARAPHRASE_F1": pm.get("paraphrase_f1"),
        "SAME_TOPIC_FPR": fpr("SAME_TOPIC_OR_VOCAB_NEGATIVE"), "LEXICAL_HARD_NEGATIVE_FPR": fpr("LEXICAL_HARD_NEGATIVE", me.get("regression_paws_test", {})),
        "NEGATION_FPR": fpr("NEGATION_HARD_NEGATIVE", hn), "ENTITY_CHANGE_FPR": fpr("ENTITY_CHANGED_NEGATIVE", hn), "NUMBER_CHANGE_FPR": fpr("NUMBER_CHANGED_NEGATIVE", hn),
        "TRANSLATED_RECALL_AT_10": g("translated", "recall@10"),
        "SPAN_PRECISION": sp.get("span_precision"), "SPAN_RECALL": sp.get("span_recall"), "SPAN_F1": sp.get("span_f1"), "CHAR_F1": sp.get("char_f1"),
        "DOCUMENT_COVERAGE_MAE": (me.get("spans_documents") or {}).get("coverage_mae"),
        "EXACT_COPY_REGRESSION": "PASS" if (ret.get("exact_copy_regression") or {}).get("pass") else ("FAIL" if ret else None),
        "SPANISH_COPY_REGRESSION": ("PASS" if (g("spanish", "recall@10") or 0) >= 0.90 and (sp.get("char_f1") or 0) >= 0.80 else "FAIL") if ret else None,
        "MODEL_STORAGE": "GOOGLE_DRIVE:MyDrive/turniting/f008_2/models/final" if reg else None,
        "MODEL_SHA256": {k: v["SHA256"] for k, v in (reg.get("models") or {}).items()} or None, "MODEL_STATUS": "EXPERIMENTAL", "ACTIVE_MODEL": "NONE",
    }
    zs = (fin.get("configs") or {}).get("ZS", {}).get("pairs", {})
    lines = ["# F008.2 — Paraphrase + translated similarity (Track B)", "", "Status: EXPERIMENTAL; active model: NONE.", "",
             f"Selected configuration: {cfg}. Frozen zero-shot reference (ZS): precision {zs.get('paraphrase_precision')}, recall {zs.get('paraphrase_recall')}, "
             f"F1 {zs.get('paraphrase_f1')} on the same final holdout.", "", "## Output contract", "", "```"] + [f"{k} = {v}" for k, v in kv.items()] + ["```", ""]
    (REPO / "reports" / "F008_2_FINAL_REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    write_json(REPO / "reports" / "F008_2_FINAL_REPORT.json", {"contract": kv, "validation_summary": comp.get("summary"), "final": fin})
    print("\n".join(f"{k} = {v}" for k, v in kv.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
