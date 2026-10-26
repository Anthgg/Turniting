"""F008.3 evaluation: compare configs on VALIDATION (thresholds from CALIBRATION), MODEL_LOCK, single FINAL run.

    python scripts/f0083_eval.py compare | lock | final

The four problems are measured separately (never one blended metric):
  1. candidate generation  retriever Recall@1/5/10, MRR, nDCG@10 of the fused list BEFORE reranking, per language and cross pair
  2. reranking quality      the same metrics AFTER reranking the top 50
  3. thresholding           pair precision / recall / F1 at the CALIBRATION-fitted threshold, FPR per hard-negative type, long-distance P/R/F1
  4. span alignment         char / span P/R/F1 on cross-language document pairs and their negatives
Configs (BM25 is always kept for exact / near copy): C0 = BM25 + frozen BGE-M3 (RRF) + F008.2 B_RERANK (baseline);
C1 = C0 with R1; C2 = BM25 + D1 + B_RERANK; C3 = BM25 + D1 + R1; C4 = C3 with dense-weighted fusion (0.3 / 0.7) and rerank depth 100.
F008_3 gates (pre-registered, fixed before training): exact-copy R@10 >= BM25 - 0.005; Spanish exact-copy R@10 >= 0.90; VALIDATION paraphrase
precision >= 0.80 and recall >= C0 recall - 0.02; per-language mono R@10 drop vs C0 <= 3 pp (es, en) / 5 pp (pt, fr, de); mean cross-language
R@10 >= C0; long-distance recall >= C0. Selection: eligible config with max  mean cross R@10 + mean mono R@10 + paraphrase F1 + long-distance F1
- 2 * sum_c max(0, FPR_c - 0.10). If none is eligible: NO_MODEL_LOCK (C0 stays the reference).
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import sha256_file, write_json  # noqa: E402
from f0082_eval import Enc, Rr, fit_threshold, pair_metrics, span_eval, tree_sha  # noqa: E402

DRIVE = Path("/content/drive/MyDrive/turniting")
D = DRIVE / "f008_3"
SPLITS, MANI, FINAL, EVAL = D / "datasets" / "splits", D / "datasets" / "manifests", D / "models" / "final", D / "evaluation"
F82_RR = DRIVE / "f008_2" / "models" / "final" / "f008_2_locked_reranker"
R1 = D / "models" / "reranker" / "r1_multilingual"
D1 = D / "models" / "biencoder" / "d1_multilingual_bge_m3"
REPO = Path(__file__).resolve().parents[1]
LOCK, DONE = MANI / "F008_3_MODEL_LOCK.json", MANI / "F008_3_FINAL_EVAL_DONE.json"
L5 = ["es", "en", "pt", "fr", "de"]
CROSS = [("es", "en"), ("es", "pt"), ("es", "fr"), ("es", "de"), ("en", "pt"), ("en", "fr"), ("en", "de")]
CONFIGS = {"C0": ("frozen", "b_rerank", "rrf", 50), "C1": ("frozen", "r1", "rrf", 50), "C2": ("d1", "b_rerank", "rrf", 50),
           "C3": ("d1", "r1", "rrf", 50), "C4": ("d1", "r1", "weighted", 100)}
MONO_POS = {"FAITHFUL_PARAPHRASE", "STRONG_PARAPHRASE", "LONG_DISTANCE_PARAPHRASE", "STRUCTURAL_REWRITE", "HUMAN_PARAPHRASE", "STS_GRADED",
            "PAWS_PARAPHRASE"}
NEG_TYPES = ["LEXICAL_HARD_NEGATIVE", "NEGATION_HARD_NEGATIVE", "NUMBER_CHANGED_NEGATIVE", "ENTITY_CHANGED_NEGATIVE", "CAUSALITY_CHANGED_NEGATIVE",
             "TEMPORAL_CHANGED_NEGATIVE", "CONTRADICTION", "CONTRADICTION_CROSS_LANGUAGE", "CROSS_LANGUAGE_HARD_NEGATIVE", "SAME_TOPIC_NEGATIVE",
             "SAME_TOPIC_CROSS_LANGUAGE", "SAME_TOPIC_NEGATIVE_CROSS_LANGUAGE", "HUMAN_NON_PARAPHRASE"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load(cfg: str):
    dense, rr, fusion, depth = CONFIGS[cfg]
    enc = Enc(D1 if dense == "d1" else "BAAI/bge-m3")
    rer = Rr(R1 if rr == "r1" else F82_RR)
    return enc, rer, fusion, depth


def rank_metrics(rk, gold) -> dict:
    pos = np.array([r.index(g) if g in r else 10**9 for r, g in zip(rk, gold)])
    if not len(pos):
        return {}
    return {"recall@1": float((pos < 1).mean()), "recall@5": float((pos < 5).mean()), "recall@10": float((pos < 10).mean()),
            "mrr": float(np.where(pos < 100, 1 / (pos + 1), 0).mean()), "ndcg@10": float(np.where(pos < 10, 1 / np.log2(pos + 2), 0).mean()),
            "queries": int(len(pos))}


def retrieval_task(enc, rer, fusion, depth, queries, gold_texts, corpus) -> dict:
    from f008_engine import BM25, dense_search, rrf, weighted_fusion

    idx = {t: i for i, t in enumerate(corpus)}
    gold = [idx[g] for g in gold_texts]
    bm = BM25().fit(corpus)
    b_ids, b_sc = bm.search(queries, k=100)
    dv = enc.encode(corpus)
    qv = enc.encode(queries, query=True)
    d_ids, d_sc = dense_search(qv, dv, k=100)
    fused = rrf([np.asarray(b_ids), d_ids], top=100) if fusion == "rrf" else weighted_fusion([(np.asarray(b_ids), b_sc), (d_ids, d_sc)], [0.3, 0.7], top=100)
    out = {"bm25": rank_metrics([list(r) for r in b_ids], gold), "dense": rank_metrics([list(r) for r in d_ids], gold),
           "candidate_generation": rank_metrics([list(r) for r in fused], gold)}
    rer_lists = []
    for q, r in zip(queries, fused):
        top = list(r[:depth])
        s = rer.score([(q, corpus[i]) for i in top])
        rer_lists.append([top[i] for i in np.argsort(-s)] + list(r[depth:]))
    out["reranked"] = rank_metrics(rer_lists, gold)
    return out


def retrieval_suite(enc, rer, fusion, depth, f: pd.DataFrame, distract: dict) -> dict:
    res = {"cross": {}, "mono": {}}
    tr = f[(f["pair_class"] == "DIRECT_TRANSLATION") & ~f["doc_level"].fillna(False)]
    for a, b in CROSS:
        g = tr[(tr["lang_a"] == a) & (tr["lang_b"] == b)]
        if len(g) < 20:
            continue
        corpus = list(dict.fromkeys(g["text_a"].tolist() + distract.get(a, [])))
        res["cross"][f"{a}-{b}"] = retrieval_task(enc, rer, fusion, depth, g["text_b"].tolist(), g["text_a"].tolist(), corpus)
    mono = f[(f["label"] == 1) & (f["lang_a"] == f["lang_b"]) & f["pair_class"].isin(MONO_POS) & ~f["doc_level"].fillna(False)]
    for l in L5:
        g = mono[mono["lang_a"] == l].drop_duplicates("text_b").head(1500)
        if len(g) < 20:
            continue
        negs = f[(f["lang_a"] == l) & (f["label"] == 0)]["text_b"].tolist()
        corpus = list(dict.fromkeys(g["text_a"].tolist() + negs + distract.get(l, [])))
        res["mono"][l] = retrieval_task(enc, rer, fusion, depth, g["text_b"].tolist(), g["text_a"].tolist(), corpus)
    ld = f[f["pair_class"] == "LONG_DISTANCE_PARAPHRASE"]
    if len(ld) >= 20:
        corpus = list(dict.fromkeys(ld["text_a"].tolist() + f[f["dataset"] == "claude_pairs_multilingual"]["text_b"].tolist()))
        res["long_distance"] = retrieval_task(enc, rer, fusion, depth, ld["text_b"].tolist(), ld["text_a"].tolist(), corpus)
    es = mono[mono["lang_a"] == "es"]["text_a"].drop_duplicates().head(1000).tolist()
    if es:
        corpus = list(dict.fromkeys(es + distract.get("es", [])))
        ex = retrieval_task(enc, rer, fusion, depth, es, es, corpus)
        res["exact_copy_es"] = ex
        res["exact_copy_regression"] = {"bm25_r10": ex["bm25"]["recall@10"], "pipeline_r10": ex["reranked"]["recall@10"],
                                        "pass": ex["reranked"]["recall@10"] >= ex["bm25"]["recall@10"] - 0.005 and ex["reranked"]["recall@10"] >= 0.90}
    return res


def distractors(f: pd.DataFrame) -> dict:
    tr = pd.read_parquet(SPLITS / "f008_3_train.parquet", columns=["text_a", "lang_a", "dataset"])
    out = {}
    for l in L5:
        out[l] = tr[(tr["lang_a"] == l) & (tr["dataset"] == "tapaco")]["text_a"].drop_duplicates().head(4000).tolist()
    return out


def doc_spans(enc, rer, f: pd.DataFrame, tau_rr: float) -> dict:
    docs = []
    dd = f[f["doc_level"].fillna(False)]
    for r in dd.itertuples(index=False):
        docs.append({"query": r.text_b, "source": r.text_a, "gold": [(0, len(r.text_b))], "gold_coverage": 1.0})
    texts = dd["text_a"].tolist()
    for i, r in enumerate(dd.head(80).itertuples(index=False)):  # negatives: another article's document
        other = texts[(i + 7) % len(texts)] if len(texts) > 8 else None
        if other and other != r.text_a:
            docs.append({"query": r.text_b, "source": other, "gold": [], "gold_coverage": 0.0})
    return span_eval(enc, rer, docs, 0.80, tau_rr) if docs else {"docs": 0}


def pair_suite(enc, rer, f: pd.DataFrame, thr: float) -> dict:
    g = f[~f["doc_level"].fillna(False)]
    s = rer.score(list(zip(g["text_a"], g["text_b"])))
    pm = pair_metrics(g.assign(label=g["label"]), s, thr)
    ld = g[(g["dataset"] == "claude_pairs_multilingual")]
    ld = ld[ld["parent_source_id"].isin(set(ld.loc[ld["pair_class"] == "LONG_DISTANCE_PARAPHRASE", "parent_source_id"]))]
    ld = ld[(ld["pair_class"] == "LONG_DISTANCE_PARAPHRASE") | (ld["label"] == 0)]
    if len(ld):
        sl = rer.score(list(zip(ld["text_a"], ld["text_b"])))
        pm["long_distance"] = {k: v for k, v in pair_metrics(ld, sl, thr).items() if k in ("n", "paraphrase_precision", "paraphrase_recall", "paraphrase_f1")}
    for c in ("cross_language", ):
        cg = g[g[c].fillna(False)]
        if len(cg):
            pm["cross_language_pairs"] = {k: v for k, v in pair_metrics(cg, rer.score(list(zip(cg["text_a"], cg["text_b"]))), thr).items()
                                          if k in ("n", "paraphrase_precision", "paraphrase_recall", "paraphrase_f1", "fpr_by_class")}
    return pm


def summary(res: dict) -> dict:
    cr = [v["reranked"]["recall@10"] for v in res["retrieval"]["cross"].values()]
    mo = {k: v["reranked"]["recall@10"] for k, v in res["retrieval"]["mono"].items()}
    ld = res["pairs"].get("long_distance", {})
    fprs = {c: v["fpr"] for c, v in res["pairs"]["fpr_by_class"].items() if c in NEG_TYPES}
    return {"mean_cross_r10": float(np.mean(cr)) if cr else 0.0, "mono_r10": mo, "mean_mono_r10": float(np.mean(list(mo.values()))) if mo else 0.0,
            "paraphrase_precision": res["pairs"]["paraphrase_precision"], "paraphrase_recall": res["pairs"]["paraphrase_recall"],
            "paraphrase_f1": res["pairs"]["paraphrase_f1"], "long_distance_recall": ld.get("paraphrase_recall", 0.0), "long_distance_f1": ld.get("paraphrase_f1", 0.0),
            "fprs": fprs, "exact_copy_pass": res["retrieval"].get("exact_copy_regression", {}).get("pass", False)}


def compare() -> int:
    val = pd.read_parquet(SPLITS / "f008_3_validation.parquet")
    cal = pd.read_parquet(SPLITS / "f008_3_calibration.parquet")
    dis = distractors(val)
    res = {}
    for cfg in CONFIGS:
        dense, rr, _, _ = CONFIGS[cfg]
        if (dense == "d1" and not (D1 / "train_info.json").exists()) or (rr == "r1" and not (R1 / "train_info.json").exists()):
            log(f"{cfg}: model missing; skipped")
            continue
        enc, rer, fusion, depth = load(cfg)
        cg = cal[~cal["doc_level"].fillna(False) & cal["label"].isin([0.0, 1.0])]
        th = fit_threshold(cg["label"].values, rer.score(list(zip(cg["text_a"], cg["text_b"]))))
        r = {"threshold": th, "retrieval": retrieval_suite(enc, rer, fusion, depth, val, dis), "pairs": pair_suite(enc, rer, val, th["threshold"]),
             "spans": doc_spans(enc, rer, val, th["threshold"])}
        r["summary"] = summary(r)
        res[cfg] = r
        s = r["summary"]
        log(f"{cfg}: cross R@10 {s['mean_cross_r10']:.3f} mono R@10 {s['mean_mono_r10']:.3f} P {s['paraphrase_precision']:.3f} R {s['paraphrase_recall']:.3f} "
            f"LD R {s['long_distance_recall']:.3f} exact {s['exact_copy_pass']}")
        del enc, rer
        import torch

        torch.cuda.empty_cache()
    b = res["C0"]["summary"]
    lim = {"es": 0.03, "en": 0.03, "pt": 0.05, "fr": 0.05, "de": 0.05}
    for k, v in res.items():
        s = v["summary"]
        gates = {"exact_copy": s["exact_copy_pass"], "precision_ge_0.80": s["paraphrase_precision"] >= 0.80,
                 "recall_ge_C0_minus_0.02": s["paraphrase_recall"] >= b["paraphrase_recall"] - 0.02,
                 "mono_language_drop": all(s["mono_r10"].get(l, 0) >= b["mono_r10"].get(l, 0) - lim[l] for l in b["mono_r10"]),
                 "cross_ge_C0": s["mean_cross_r10"] >= b["mean_cross_r10"], "long_distance_ge_C0": s["long_distance_recall"] >= b["long_distance_recall"]}
        v["gates"] = gates
        v["eligible"] = all(gates.values())
        v["score"] = s["mean_cross_r10"] + s["mean_mono_r10"] + s["paraphrase_f1"] + s["long_distance_f1"] - 2 * sum(max(0.0, x - 0.10) for x in s["fprs"].values())
    el = {k: v for k, v in res.items() if k != "C0" and v["eligible"]}
    chosen = max(el, key=lambda k: el[k]["score"]) if el else None
    summ = {"chosen": chosen, "scores": {k: {"score": v["score"], "eligible": v["eligible"], "gates": v["gates"]} for k, v in res.items()}}
    write_json(EVAL / "validation_comparison.json", {"summary": summ, "configs": res})
    write_json(REPO / "reports" / "f008_3" / "validation_comparison.json", {"summary": summ, "configs": res})
    log(f"chosen: {chosen}")
    return 0


def lock() -> int:
    if LOCK.exists():
        log("lock exists")
        return 0
    comp = json.loads((EVAL / "validation_comparison.json").read_text())
    ch = comp["summary"]["chosen"]
    if not ch:
        write_json(MANI / "F008_3_NO_MODEL_LOCK.json", {"reason": "no configuration passed every pre-registered gate", "summary": comp["summary"]})
        log("NO_MODEL_LOCK: FINAL evaluates the F008.2 baseline (C0) only")
        return 0
    dense, rr, fusion, depth = CONFIGS[ch]
    models = {}
    for name, src in (("biencoder", D1 if dense == "d1" else None), ("reranker", R1 if rr == "r1" else None)):
        if src is None:
            continue
        dst = FINAL / f"f008_3_locked_{name}"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        models[name] = {"path": str(dst), "sha256": tree_sha(dst)}
    lk = {"name": "F008_3_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "config": ch, "fusion": fusion,
          "rerank_depth": depth, "models": models, "threshold": comp["configs"][ch]["threshold"]["threshold"],
          "frozen": {"bm25": "k1 1.2 b 0.75", "dense": "BAAI/bge-m3" if dense == "frozen" else "D1", "reranker": "F008.2 B_RERANK" if rr == "b_rerank" else "R1"},
          "manifests_sha256": {k: sha256_file(MANI / f"f008_3_{k}.json") for k in ("train", "validation", "calibration", "final_external_holdout")}}
    write_json(LOCK, lk)
    write_json(REPO / "reports" / "f008_3" / "model_lock.json", lk)
    log(f"MODEL_LOCK {ch}")
    return 0


def final() -> int:
    if DONE.exists():
        log("final already evaluated once; refusing")
        return 0
    lk = json.loads(LOCK.read_text()) if LOCK.exists() else {"config": "C0", "models": {}, "lockedAt": None, "manifests_sha256": {}}
    for k, v in lk["models"].items():
        assert tree_sha(Path(v["path"])) == v["sha256"], k
    hm = json.loads((MANI / "f008_3_final_external_holdout.json").read_text())
    fp = SPLITS / "f008_3_final_external_holdout.parquet"
    assert sha256_file(fp) == hm["file_sha256"]
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    fin = pd.read_parquet(fp)
    regs = {k: pd.read_parquet(SPLITS / f"f008_3_{k}.parquet") for k in ("long_distance_regression_sushi", "regression_paws_es_test")}
    comp = json.loads((EVAL / "validation_comparison.json").read_text())
    dis = distractors(fin)
    out = {"set": "F008_3_FINAL_EXTERNAL_HOLDOUT", "evaluatedAt": started, "lockedAt": lk["lockedAt"], "configs": {}}
    for cfg in dict.fromkeys(("C0", lk["config"])):
        dense, rr, fusion, depth = CONFIGS[cfg]
        enc = Enc(Path(lk["models"]["biencoder"]["path"]) if (cfg == lk["config"] and "biencoder" in lk["models"]) else (D1 if dense == "d1" else "BAAI/bge-m3"))
        rer = Rr(Path(lk["models"]["reranker"]["path"]) if (cfg == lk["config"] and "reranker" in lk["models"]) else (R1 if rr == "r1" else F82_RR))
        thr = comp["configs"][cfg]["threshold"]["threshold"]
        r = {"retrieval": retrieval_suite(enc, rer, fusion, depth, fin, dis), "pairs": pair_suite(enc, rer, fin, thr), "spans": doc_spans(enc, rer, fin, thr)}
        r["summary"] = summary(r)
        for k, f in regs.items():
            g = f[~f.get("doc_level", pd.Series(False, index=f.index)).fillna(False).astype(bool)]
            r[k] = pair_metrics(g, rer.score(list(zip(g["text_a"], g["text_b"]))), thr)
        out["configs"][cfg] = r
        log(f"FINAL {cfg}: " + json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r["summary"].items() if k != "fprs"}))
        del enc, rer
    write_json(EVAL / "final_external_holdout.json", out)
    write_json(REPO / "reports" / "f008_3" / "final_external_holdout.json", out)
    if not LOCK.exists():
        write_json(DONE, {"evaluatedAt": started, "FINAL_HOLDOUT_TUNING": "NO", "lock": "NO_MODEL_LOCK"})
        return 0
    reg = {"name": "EXPERIMENTAL_F008_3_MODEL", "status": "EXPERIMENTAL", "active": False, "config": lk["config"], "storage_provider": "GOOGLE_DRIVE",
           "models": {k: {"logical_path": v["path"].replace("/content/drive/", ""), "SHA256": v["sha256"],
                          "size_bytes": sum(x.stat().st_size for x in Path(v["path"]).rglob("*") if x.is_file())} for k, v in lk["models"].items()},
           "training_phase": "F008_3", "dataset_manifest_hash": lk["manifests_sha256"]}
    write_json(MANI / "model_registry_f008_3.json", reg)
    write_json(REPO / "reports" / "f008_3" / "model_registry_f008_3.json", reg)
    write_json(DONE, {"evaluatedAt": started, "FINAL_HOLDOUT_TUNING": "NO"})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["compare", "lock", "final"])
    a = ap.parse_args()
    return {"compare": compare, "lock": lock, "final": final}[a.cmd]()


if __name__ == "__main__":
    raise SystemExit(main())
