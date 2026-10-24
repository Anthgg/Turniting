"""F008.2 evaluation: compare configs on VALIDATION (thresholds from CALIBRATION), MODEL_LOCK, single FINAL_EXTERNAL_HOLDOUT run.

    python scripts/f0082_eval.py compare
    python scripts/f0082_eval.py lock
    python scripts/f0082_eval.py final

Configurations (frozen references are evaluated with the same code and never modified):
  ZS          frozen BGE-M3 dense + frozen bge-reranker-v2-m3 (F008 zero-shot family)
  A_BIENC     fine-tuned bi-encoder (pair decision = cosine)
  B_RERANK    frozen BGE-M3 retrieval + fine-tuned reranker (pair decision = reranker)
  C_HYBRID    BM25 + fine-tuned dense (RRF) retrieval + fine-tuned reranker; pair decision = 0.7 reranker + 0.3 cosine
Pair thresholds: fitted on CALIBRATION only (max F1 with precision >= 0.80 when reachable, else max F1).
F008_2_SELECTION_SCORE (fixed before training) on VALIDATION:
  F1_para + 0.25 * translated R@10 + 0.25 * span char F1 - 2 * sum_c max(0, FPR_c - 0.10)   over hard-negative classes c;
  eligible iff paraphrase precision >= 0.80, paraphrase recall >= 0.50, Spanish R@10 >= 0.90 and exact-copy regression passes
  (hybrid exact-copy R@10 >= BM25 exact-copy R@10 - 0.005). BM25 is never replaced if it is better on exact copies.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import BASE_BIENCODER, BASE_RERANKER, BIENC, D, D8, FINAL, MANI, RERANK, REPO, SEED, SPLITS, sha256_file, write_json  # noqa: E402

FT_BI = BIENC / "ft_bge_m3"
FT_RR = RERANK / "ft_bge_reranker_v2_m3"
LOCK = MANI / "F008_2_MODEL_LOCK.json"
DONE = MANI / "F008_2_FINAL_EVAL_DONE.json"
CONFIGS = ["ZS", "A_BIENC", "B_RERANK", "C_HYBRID"]
NEG_CLASSES = ["LEXICAL_HARD_NEGATIVE", "NEGATION_HARD_NEGATIVE", "NUMBER_CHANGED_NEGATIVE", "ENTITY_CHANGED_NEGATIVE", "TRANSLATED_LEXICAL_NEGATIVE",
               "SAME_TOPIC_NEGATIVE", "SAME_TOPIC_OR_VOCAB_NEGATIVE"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Enc:
    def __init__(self, path):
        from sentence_transformers import SentenceTransformer

        self.m = SentenceTransformer(str(path), device="cuda")
        self.m.max_seq_length = 512
        self.m.half()

    def encode(self, texts, query: bool = False, batch: int = 128):
        return np.asarray(self.m.encode(list(texts), batch_size=batch, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False), np.float16)


class Rr:
    def __init__(self, path):
        from sentence_transformers.cross_encoder import CrossEncoder

        self.m = CrossEncoder(str(path), num_labels=1, max_length=512, device="cuda")
        self.m.model.half()

    def score(self, pairs, batch: int = 128):
        if not pairs:
            return np.zeros(0, np.float32)
        s = np.asarray(self.m.predict([list(p) for p in pairs], batch_size=batch, show_progress_bar=False), np.float32).reshape(-1)
        return s if (s.min() >= 0 and s.max() <= 1) else 1 / (1 + np.exp(-s))


def components(cfg: str):
    enc = Enc(FT_BI if cfg in ("A_BIENC", "C_HYBRID") else BASE_BIENCODER)
    rr = Rr(FT_RR if cfg in ("B_RERANK", "C_HYBRID") else BASE_RERANKER) if cfg != "A_BIENC" else None
    return enc, rr


def pair_scores(cfg, enc, rr, f: pd.DataFrame) -> np.ndarray:
    a = enc.encode(f["text_a"].tolist()).astype(np.float32)
    b = enc.encode(f["text_b"].tolist()).astype(np.float32)
    cos = (a * b).sum(1)
    if cfg == "A_BIENC":
        return cos
    r = rr.score(list(zip(f["text_a"], f["text_b"])))
    return 0.7 * r + 0.3 * (cos + 1) / 2 if cfg == "C_HYBRID" else r


def fit_threshold(y, s) -> dict:
    order = np.argsort(-s)
    ys, ss = y[order], s[order]
    tp = np.cumsum(ys == 1)
    fp = np.cumsum(ys == 0)
    P = tp / np.maximum(tp + fp, 1)
    R = tp / max((ys == 1).sum(), 1)
    F = 2 * P * R / np.maximum(P + R, 1e-9)
    ok = P >= 0.80
    i = int(np.argmax(np.where(ok, F, -1))) if ok.any() else int(np.argmax(F))
    return {"threshold": float(ss[i]), "precision_constraint_met": bool(ok.any()), "cal_precision": float(P[i]), "cal_recall": float(R[i]), "cal_f1": float(F[i])}


def pair_metrics(f: pd.DataFrame, s: np.ndarray, thr: float) -> dict:
    m = f["label"].isin([0.0, 1.0]).values
    y, pr = f["label"].values[m], (s[m] >= thr)
    tp, fp, fn = int(((y == 1) & pr).sum()), int(((y == 0) & pr).sum()), int(((y == 1) & ~pr).sum())
    P, R = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    out = {"n": int(m.sum()), "paraphrase_precision": P, "paraphrase_recall": R, "paraphrase_f1": 2 * P * R / max(P + R, 1e-9), "threshold": thr,
           "fpr_by_class": {}, "recall_by_class": {}}
    cls = f["pair_class"].values[m]
    for c in sorted(set(cls)):
        k = cls == c
        if (y[k] == 0).all():
            out["fpr_by_class"][c] = {"n": int(k.sum()), "fpr": float(pr[k].mean())}
        elif (y[k] == 1).all():
            out["recall_by_class"][c] = {"n": int(k.sum()), "recall": float(pr[k].mean())}
    if len(set(y)) == 2:
        from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score

        out["roc_auc"], out["pr_auc"] = float(roc_auc_score(y, s[m])), float(average_precision_score(y, s[m]))
        p_, r_, t_ = precision_recall_curve(y, s[m])
        idx = np.linspace(0, len(t_) - 1, min(40, len(t_))).astype(int)
        out["pr_curve"] = [{"threshold": float(t_[i]), "precision": float(p_[i]), "recall": float(r_[i])} for i in idx]
    if "score" in f and f["score"].notna().any():
        from scipy.stats import spearmanr

        g = f["score"].notna().values
        out["sts_spearman"] = float(spearmanr(f["score"].values[g], s[g]).correlation)
    return out


# ------------------------------------------------------------------ retrieval

def distractors(n: int = 30000) -> list[str]:
    for p in (D8 / "datasets" / "corpus_es.parquet", Path("/content/f008work/corpus_es.parquet")):
        if p.exists():
            import pyarrow.parquet as pq

            t = pq.read_table(p, columns=["text"]).to_pandas()
            return t["text"].sample(min(n, len(t)), random_state=SEED).tolist()
    return []


def retrieval(cfg, enc, rr, f: pd.DataFrame, extra: list[str]) -> dict:
    from f008_engine import BM25, dense_search, rrf

    src = f["text_a"].drop_duplicates().tolist()
    corpus = src + [t for t in f.loc[f["label"] == 0, "text_b"].drop_duplicates().tolist() if t not in set(src)] + extra
    idx = {t: i for i, t in enumerate(corpus)}
    q = f[(f["label"] == 1)]
    sets = {"spanish": q[q["lang_b"] == "es"], "translated": q[q["lang_b"] != "es"]}
    exact = pd.DataFrame({"text_b": src[:2000], "text_a": src[:2000]})
    pert = pd.DataFrame({"text_b": [re.sub(r"[,.;:]", "", t).lower() for t in src[:2000]], "text_a": src[:2000]})
    bm = BM25()
    bm.fit(corpus)
    dv = enc.encode(corpus)
    out = {"corpus_size": len(corpus), "distractors": len(extra)}

    def run(qs: pd.DataFrame, system: str) -> dict:
        if not len(qs):
            return {}
        gold = np.array([idx[t] for t in qs["text_a"]])
        texts = qs["text_b"].tolist()
        b_ids, b_sc = bm.search(texts, k=100)
        if system == "bm25":
            rk = [list(r) for r in b_ids]
        else:
            qv = enc.encode(texts, query=True)
            d_ids, _ = dense_search(qv, dv, k=100)
            rk = [list(r) for r in d_ids] if system == "dense" else rrf([np.asarray(b_ids), d_ids], top=100)
            if system == "hybrid_rerank" and rr is not None:
                new = []
                for t, r in zip(texts, rk):
                    top = r[:50]
                    s = rr.score([(t, corpus[i]) for i in top])
                    new.append([top[i] for i in np.argsort(-s)] + r[50:])
                rk = new
        pos = np.array([r.index(g) if g in r else 10**9 for r, g in zip(rk, gold)])
        return {"recall@1": float((pos < 1).mean()), "recall@5": float((pos < 5).mean()), "recall@10": float((pos < 10).mean()),
                "mrr": float(np.where(pos < 100, 1 / (pos + 1), 0).mean()), "ndcg@10": float(np.where(pos < 10, 1 / np.log2(pos + 2), 0).mean()), "queries": int(len(qs))}

    systems = ["bm25", "dense", "hybrid", "hybrid_rerank"] if cfg != "A_BIENC" else ["bm25", "dense", "hybrid"]
    for name, qs in (("spanish", sets["spanish"]), ("translated", sets["translated"]), ("exact_copy", exact), ("perturbed_copy", pert)):
        out[name] = {s: run(qs, s) for s in systems}
    best = "hybrid_rerank" if cfg != "A_BIENC" else "hybrid"
    out["pipeline"] = best
    out["exact_copy_regression"] = {"bm25_r10": out["exact_copy"]["bm25"]["recall@10"], "pipeline_r10": out["exact_copy"][best]["recall@10"],
                                    "pass": out["exact_copy"][best]["recall@10"] >= out["exact_copy"]["bm25"]["recall@10"] - 0.005}
    return out


# ------------------------------------------------------------------ spans (synthetic documents from the evaluation pairs)

def span_docs(f: pd.DataFrame, n: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    pos = f[(f["label"] == 1) & (f["lang_b"] == "es")].drop_duplicates("text_a")
    neg = f[f["pair_class"].isin(["LEXICAL_HARD_NEGATIVE", "NEGATION_HARD_NEGATIVE", "NUMBER_CHANGED_NEGATIVE", "ENTITY_CHANGED_NEGATIVE",
                               "SAME_TOPIC_OR_VOCAB_NEGATIVE"])]
    negm = neg.groupby("text_a")["text_b"].first()
    docs = []
    P = pos.sample(frac=1.0, random_state=seed).itertuples(index=False)
    for k in range(n):
        try:
            tg = [next(P) for _ in range(3)]
        except StopIteration:
            break
        hn_src = [a for a in negm.index if a not in {t.text_a for t in tg}]
        if not hn_src:
            break
        h = rng.choice(hn_src)
        src_sents = [t.text_a for t in tg] + [h]
        rng.shuffle(src_sents)
        q_parts = [(t.text_a if k % 3 == 0 and i == 0 else t.text_b, True) for i, t in enumerate(tg)] + [(negm[h], False)]
        rng.shuffle(q_parts)
        q, gold, cur = "", [], 0
        for t, g in q_parts:
            if q:
                q += " "
            s0 = len(q)
            q += t
            if g:
                gold.append((s0, len(q)))
        docs.append({"query": q, "source": " ".join(src_sents), "gold": gold, "gold_coverage": sum(e - s for s, e in gold) / len(q)})
    return docs


def span_eval(enc, rr, docs: list[dict], tau_sem: float, tau_rr: float) -> dict:
    from f008_engine import CharNgram, align

    if not docs:
        return {"docs": 0}
    char = CharNgram()
    char.fit([d["source"] for d in docs] + [d["query"] for d in docs])
    tp = fp = fn = 0
    sp_tp = sp_fp = sp_fn = 0
    mae = []
    for d in docs:
        m = align(d["query"], d["source"], enc, rr, char, tau_sem=tau_sem, tau_rr=tau_rr)
        pred = np.zeros(len(d["query"]), bool)
        for x in m:
            pred[x["queryStart"]:x["queryEnd"]] = True
        gold = np.zeros(len(d["query"]), bool)
        for s, e in d["gold"]:
            gold[s:e] = True
        tp += int((pred & gold).sum()); fp += int((pred & ~gold).sum()); fn += int((~pred & gold).sum())
        for s, e in d["gold"]:
            if pred[s:e].mean() >= 0.5:
                sp_tp += 1
            else:
                sp_fn += 1
        segs = [(x["queryStart"], x["queryEnd"]) for x in m if x["queryEnd"] > x["queryStart"]]
        sp_fp += sum(1 for s, e in segs if gold[s:e].mean() < 0.5)
        mae.append(abs(pred.mean() - d["gold_coverage"]))
    P, R = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    sP, sR = sp_tp / max(sp_tp + sp_fp, 1), sp_tp / max(sp_tp + sp_fn, 1)
    return {"docs": len(docs), "char_precision": P, "char_recall": R, "char_f1": 2 * P * R / max(P + R, 1e-9), "span_precision": sP, "span_recall": sR,
            "span_f1": 2 * sP * sR / max(sP + sR, 1e-9), "coverage_mae": float(np.mean(mae)) if mae else None}


def selection(pm: dict, ret: dict, sp: dict) -> dict:
    fprs = {c: v["fpr"] for c, v in pm["fpr_by_class"].items() if c in NEG_CLASSES}
    tr10 = (ret["translated"].get(ret["pipeline"]) or {}).get("recall@10") or 0.0
    es10 = (ret["spanish"].get(ret["pipeline"]) or {}).get("recall@10") or 0.0
    score = pm["paraphrase_f1"] + 0.25 * tr10 + 0.25 * sp["char_f1"] - 2 * sum(max(0.0, v - 0.10) for v in fprs.values())
    elig = pm["paraphrase_precision"] >= 0.80 and pm["paraphrase_recall"] >= 0.50 and es10 >= 0.90 and ret["exact_copy_regression"]["pass"]
    return {"score": score, "eligible": bool(elig), "spanish_r10": es10, "translated_r10": tr10, "hard_negative_fprs": fprs}


def compare() -> int:
    val = pd.read_parquet(SPLITS / "f008_2_validation.parquet")
    cal = pd.read_parquet(SPLITS / "f008_2_calibration.parquet")
    extra = distractors()
    docs = span_docs(val, 150, SEED)
    res = {}
    for cfg in CONFIGS:
        if cfg != "ZS" and not ((FT_BI / "train_info.json").exists() if cfg == "A_BIENC" else (FT_RR / "train_info.json").exists()):
            log(f"{cfg}: model not trained; skipped")
            continue
        enc, rr = components(cfg)
        sc_cal = pair_scores(cfg, enc, rr, cal)
        mc = cal["label"].isin([0.0, 1.0]).values
        th = fit_threshold(cal["label"].values[mc], sc_cal[mc])
        sv = pair_scores(cfg, enc, rr, val)
        pm = pair_metrics(val, sv, th["threshold"])
        ret = retrieval(cfg, enc, rr, val, extra)
        tau_rr = th["threshold"] if cfg in ("B_RERANK", "ZS") else 0.5
        sp = span_eval(enc, rr, docs, tau_sem=0.80, tau_rr=tau_rr)
        res[cfg] = {"threshold": th, "pairs": pm, "retrieval": ret, "spans": sp, "selection": selection(pm, ret, sp), "align": {"tau_sem": 0.80, "tau_rr": tau_rr}}
        log(f"{cfg}: P {pm['paraphrase_precision']:.3f} R {pm['paraphrase_recall']:.3f} F1 {pm['paraphrase_f1']:.3f} | es R@10 {res[cfg]['selection']['spanish_r10']:.3f} "
            f"tr R@10 {res[cfg]['selection']['translated_r10']:.3f} | char F1 {sp['char_f1']:.3f} | score {res[cfg]['selection']['score']:.3f} elig {res[cfg]['selection']['eligible']}")
        del enc, rr
        import torch

        torch.cuda.empty_cache()
    el = {k: v for k, v in res.items() if v["selection"]["eligible"] and k != "ZS"}
    chosen = max(el, key=lambda k: el[k]["selection"]["score"]) if el else None
    summ = {"chosen": chosen, "rule": "max F008_2_SELECTION_SCORE among eligible fine-tuned configs", "scores": {k: v["selection"] for k, v in res.items()}}
    write_json(D / "reports" / "validation_comparison.json", {"summary": summ, "configs": res})
    write_json(REPO / "reports" / "f008_2" / "validation_comparison.json", {"summary": summ, "configs": res})
    log(f"chosen {chosen}")
    return 0


def tree_sha(p: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    for f in sorted(x for x in p.rglob("*") if x.is_file()):
        h.update(str(f.relative_to(p)).encode())
        h.update(sha256_file(f).encode())
    return h.hexdigest()


def lock() -> int:
    if LOCK.exists():
        lk = json.loads(LOCK.read_text())
        for k, v in lk["models"].items():
            assert tree_sha(Path(v["path"])) == v["sha256"], k
        log("lock verifies")
        return 0
    comp = json.loads((D / "reports" / "validation_comparison.json").read_text())
    ch = comp["summary"]["chosen"]
    if not ch:
        write_json(MANI / "F008_2_NO_MODEL_LOCK.json", {"reason": "no eligible fine-tuned configuration on VALIDATION", "summary": comp["summary"]})
        raise SystemExit("STOP: no eligible configuration; nothing locked (ZS reference kept)")
    models = {}
    for name, src in (("biencoder", FT_BI if ch in ("A_BIENC", "C_HYBRID") else None), ("reranker", FT_RR if ch in ("B_RERANK", "C_HYBRID") else None)):
        if src is None:
            continue
        dst = FINAL / f"f008_2_locked_{name}"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        models[name] = {"path": str(dst), "sha256": tree_sha(dst)}
    c = comp["configs"][ch]
    lk = {"name": "F008_2_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "config": ch, "models": models,
          "frozen": {"bm25": "k1 1.2, b 0.75", "dense_base": BASE_BIENCODER, "reranker_base": BASE_RERANKER}, "pair_threshold": c["threshold"]["threshold"],
          "align": c["align"], "manifests_sha256": {k: sha256_file(MANI / f"f008_2_{k}.json") for k in ("train", "validation", "calibration", "final_external_holdout")}}
    write_json(LOCK, lk)
    write_json(REPO / "reports" / "f008_2" / "model_lock.json", lk)
    log(f"MODEL_LOCK {ch}")
    return 0


def final() -> int:
    if DONE.exists():
        log("final already evaluated once; refusing")
        return 0
    lk = json.loads(LOCK.read_text())
    for k, v in lk["models"].items():
        assert tree_sha(Path(v["path"])) == v["sha256"], f"{k} changed"
    hm = json.loads((MANI / "f008_2_final_external_holdout.json").read_text())
    fp_ = SPLITS / "f008_2_final_external_holdout.parquet"
    assert sha256_file(fp_) == hm["file_sha256"]
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    fin = pd.read_parquet(fp_)
    sent = fin[fin.get("doc_level", pd.Series(False, index=fin.index)).fillna(False) != True]  # noqa: E712
    docs_df = fin[fin.get("doc_level", pd.Series(False, index=fin.index)).fillna(False) == True]  # noqa: E712
    oods = {k: pd.read_parquet(SPLITS / f"f008_2_{k}.parquet") for k in ("translated_ood", "hard_negative_ood", "regression_paws_test")}
    extra = distractors()
    comp = json.loads((D / "reports" / "validation_comparison.json").read_text())
    out = {"set": "F008_2_FINAL_EXTERNAL_HOLDOUT", "evaluatedAt": started, "lockedAt": lk["lockedAt"], "configs": {}}
    for cfg in ("ZS", lk["config"]):
        enc = Enc(Path(lk["models"]["biencoder"]["path"]) if cfg == lk["config"] and "biencoder" in lk["models"] else BASE_BIENCODER)
        rr = (Rr(Path(lk["models"]["reranker"]["path"]) if cfg == lk["config"] and "reranker" in lk["models"] else BASE_RERANKER)
              if cfg != "A_BIENC" else None)
        thr = comp["configs"][cfg]["threshold"]["threshold"]
        r = {"pairs": pair_metrics(sent, pair_scores(cfg, enc, rr, sent), thr), "retrieval": retrieval(cfg, enc, rr, sent, extra)}
        dd = []
        for x in docs_df.itertuples(index=False):
            dd.append({"query": x.text_b, "source": x.text_a, "gold": [(0, len(x.text_b))] if x.label == 1 else [], "gold_coverage": float(x.label)})
        r["spans_documents"] = span_eval(enc, rr, dd, 0.80, comp["configs"][cfg]["align"]["tau_rr"])
        r["spans_synthetic"] = span_eval(enc, rr, span_docs(sent, 100, SEED + 9), 0.80, comp["configs"][cfg]["align"]["tau_rr"])
        for k, f in oods.items():
            r[k] = pair_metrics(f, pair_scores(cfg, enc, rr, f), thr)
        out["configs"][cfg] = r
        log(f"FINAL {cfg}: P {r['pairs']['paraphrase_precision']:.3f} R {r['pairs']['paraphrase_recall']:.3f} F1 {r['pairs']['paraphrase_f1']:.3f}")
        del enc, rr
    reg = {"name": "EXPERIMENTAL_F008_2_MODEL", "status": "EXPERIMENTAL", "active": False, "config": lk["config"], "storage_provider": "GOOGLE_DRIVE",
           "models": {k: {"logical_path": v["path"].replace("/content/drive/", ""), "SHA256": v["sha256"],
                          "size_bytes": sum(f.stat().st_size for f in Path(v["path"]).rglob("*") if f.is_file())} for k, v in lk["models"].items()},
           "training_phase": "F008_2", "base_models": {"biencoder": BASE_BIENCODER, "reranker": BASE_RERANKER},
           "dataset_manifest_hash": lk["manifests_sha256"], "pair_threshold": lk["pair_threshold"]}
    write_json(D / "reports" / "final_external_holdout.json", out)
    write_json(REPO / "reports" / "f008_2" / "final_external_holdout.json", out)
    write_json(MANI / "model_registry_f008_2.json", reg)
    write_json(REPO / "reports" / "f008_2" / "model_registry_f008_2.json", reg)
    write_json(DONE, {"evaluatedAt": started, "FINAL_HOLDOUT_TUNING": "NO"})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["compare", "lock", "final"])
    a = ap.parse_args()
    return {"compare": compare, "lock": lock, "final": final}[a.cmd]()


if __name__ == "__main__":
    raise SystemExit(main())
