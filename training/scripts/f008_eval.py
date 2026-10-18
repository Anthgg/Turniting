"""F008: build locked evaluation sets, zero-shot bake-off on VALIDATION, threshold choice, LOCK, single final evaluation.

    python scripts/f008_eval.py build      # F008_VALIDATION + F008_FINAL_HOLDOUT (LOCKED before any tuning)
    python scripts/f008_eval.py encode     # passages + BM25 / char / BGE-M3 dense+sparse / E5 representations (cached on /content)
    python scripts/f008_eval.py bakeoff    # retrieval systems, fusion, reranker, span-alignment thresholds on VALIDATION
    python scripts/f008_eval.py index      # MIRACL-es index benchmark (exact GPU vs FAISS IVF-PQ / HNSW)
    python scripts/f008_eval.py final      # F008_MODEL_LOCK + ONE evaluation on F008_FINAL_HOLDOUT

Eval families (all with exact character offsets):
* PAN-PC-11 (EN + translated ES/DE->EN): whole suspicious documents (all their cases) in one split.
* SPANISH_SYNTHETIC (MIRACL-es Wikipedia): suspicious docs mixing exact copies, near copies (case / punctuation /
  whitespace / Unicode), partial excerpts, SAME-TOPIC negatives (another passage of a copied article, absent from the
  corpus), generic academic BOILERPLATE (also planted in corpus docs) and unrelated original text.
* PAWS-X-es: label-1 pairs = PARAPHRASE positives, label-0 pairs = lexical-overlap negatives (same words != same source).
Validation and holdout use disjoint PAN suspicious docs, disjoint MIRACL articles and the PAWS-X dev / test splits.
"""

from __future__ import annotations

import hashlib
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from f006_lib import log, sha256_file, write_json  # noqa: E402
from f008_engine import BM25, CharNgram, Dense, Reranker, align, chunk_document, coverage, dense_search, lexical_weights_matrix, rrf, weighted_fusion  # noqa: E402

W = Path("/content/f008work")
D = Path("/content/drive/MyDrive/turniting/f008")
REPO = Path(__file__).resolve().parents[1]
SEED = 8008
BOILER = ["El presente estudio tiene como objetivo analizar los factores que inciden en el fenómeno estudiado.",
          "Los resultados muestran que existe una relación significativa entre las variables analizadas.",
          "En conclusión, se recomienda continuar investigando esta línea de trabajo en futuras investigaciones.",
          "La metodología empleada fue de enfoque cuantitativo, con un diseño no experimental y de corte transversal."]


def h(s: str) -> float:
    return int(hashlib.sha256(f"{SEED}:{s}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def perturb(t: str, rng: random.Random) -> str:
    t = t.replace(",", rng.choice([",", ";", ""]))
    if rng.random() < 0.5:
        t = t.lower()
    t = t.replace(" ", rng.choice([" ", "  "]), 3)
    return t.replace("a", "а", 2) if rng.random() < 0.3 else t  # a few Cyrillic look-alikes (Unicode normalisation test)


# ------------------------------------------------------------------ build
def build() -> int:
    man_path = D / "manifests" / "f008_final_holdout.json"
    if man_path.exists():
        log("F008 holdout already LOCKED")
        return 0
    rng = random.Random(SEED)
    # PAN
    cases = pd.read_parquet(W / "pan11_cases.parquet")
    susp = pd.read_parquet(W / "pan11_suspicious.parquet")
    with_cases = susp[susp["suspicious"].isin(set(cases["suspicious"]))]
    without = susp[~susp["suspicious"].isin(set(cases["suspicious"]))]
    pan = pd.concat([with_cases.sample(min(700, len(with_cases)), random_state=SEED), without.sample(min(200, len(without)), random_state=SEED)])
    pan["split"] = np.where([h(s) < 0.4 for s in pan["suspicious"]], "validation", "holdout")
    # Spanish synthetic from MIRACL
    mir = pd.read_parquet(W / "miracl_es.parquet")
    arts = mir.groupby("article")
    big = [a for a, g in arts if len(g) >= 4]
    rng.shuffle(big)
    src_arts = big[:6000]
    unrelated = big[6000:7000]
    corpus_es, docs_es = [], []
    split_of = {a: ("validation" if h(a) < 0.4 else "holdout") for a in src_arts}
    held_out_passages = set()
    for a in src_arts:
        g = arts.get_group(a)
        held_out_passages.add(g.iloc[-1]["docid"])  # same-topic negative: never in the corpus
    corpus_es = mir[~mir["docid"].isin(held_out_passages) & ~mir["article"].isin(unrelated)].copy()
    planted = corpus_es.sample(300, random_state=SEED).index
    corpus_es.loc[planted, "text"] = corpus_es.loc[planted, "text"] + " " + " ".join(BOILER)
    for n, a in enumerate(src_arts[:1500]):
        g = arts.get_group(a)
        r = rng.random
        parts, gold = [], []

        def add(text, kind, src=None):
            start = sum(len(p) + 2 for p in parts)
            parts.append(text)
            if src is not None:
                gold.append({"start": start, "end": start + len(text), "source": src, "kind": kind})

        add(g.iloc[0]["text"], "EXACT_COPY", g.iloc[0]["docid"])
        add(perturb(g.iloc[1]["text"], rng), "NEAR_COPY", g.iloc[1]["docid"])
        sents = g.iloc[2]["text"].split(". ")
        if len(sents) >= 3:
            add(". ".join(sents[:2]) + ".", "PARTIAL_COPY", g.iloc[2]["docid"])
        add(g.iloc[-1]["text"], "SAME_TOPIC_NEGATIVE")
        add(" ".join(BOILER[: 2 + int(r() * 2)]), "BOILERPLATE_NEGATIVE")
        add(arts.get_group(unrelated[n % len(unrelated)]).iloc[0]["text"], "ORIGINAL")
        docs_es.append({"doc_id": f"es_synth_{n}", "text": "\n\n".join(parts), "gold": json.dumps(gold), "split": split_of[a],
                        "same_topic_span": None})
    # PAWS-X es
    paws = pd.read_parquet(W / "pawsx_es.parquet")
    paws = paws[paws["sentence1"].notna() & paws["sentence2"].notna()]
    pv, ph = paws[paws["split"].str.contains("dev")].sample(600, random_state=SEED), paws[paws["split"].str.contains("test")].sample(1000, random_state=SEED)
    fill = mir[mir["article"].isin(unrelated)]["text"].tolist()
    paws_docs, paws_corpus = [], []
    for split, frame in (("validation", pv), ("holdout", ph)):
        for k, r in enumerate(frame.itertuples(index=False)):
            sid = f"paws_src_{split}_{k}"
            ctx = fill[k % len(fill)][:600]
            paws_corpus.append({"docid": sid, "article": sid, "title": "", "text": ctx + " " + r.sentence1})
            q = fill[(k + 7) % len(fill)][:400] + " " + r.sentence2
            st = len(fill[(k + 7) % len(fill)][:400]) + 1
            paws_docs.append({"doc_id": f"paws_{split}_{k}", "text": q, "split": split, "label": int(r.label), "source": sid,
                              "start": st, "end": st + len(r.sentence2)})
    corpus_es = pd.concat([corpus_es, pd.DataFrame(paws_corpus)], ignore_index=True)
    corpus_es.to_parquet(W / "corpus_es.parquet", index=False)
    pd.DataFrame(docs_es).to_parquet(W / "es_synth_docs.parquet", index=False)
    pd.DataFrame(paws_docs).to_parquet(W / "paws_docs.parquet", index=False)
    pan.to_parquet(W / "pan_eval_docs.parquet", index=False)
    D.joinpath("datasets").mkdir(parents=True, exist_ok=True)
    for f in ("corpus_es.parquet", "es_synth_docs.parquet", "paws_docs.parquet", "pan_eval_docs.parquet"):
        (D / "datasets" / f).write_bytes((W / f).read_bytes())

    def ids(split):
        return sorted([f"pan:{s}" for s in pan.loc[pan["split"] == split, "suspicious"]] + [d["doc_id"] for d in docs_es if d["split"] == split]
                      + [d["doc_id"] for d in paws_docs if d["split"] == split])

    val_ids, hold_ids = ids("validation"), ids("holdout")
    common = {"created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "families": ["PAN-PC-11", "SPANISH_SYNTHETIC (MIRACL-es)", "PAWS-X-es"],
              "spanish_corpus_passages": int(len(corpus_es)), "pan_source_docs": int(len(pd.read_parquet(W / "pan11_sources.parquet")))}
    hman = {"name": "F008_FINAL_HOLDOUT", **common, "docs": len(hold_ids), "ids_sha256": hashlib.sha256("\n".join(hold_ids).encode()).hexdigest(),
            "pan_suspicious": int((pan["split"] == "holdout").sum()), "spanish_synthetic": sum(d["split"] == "holdout" for d in docs_es),
            "paws": sum(d["split"] == "holdout" for d in paws_docs), "LOCKED": True}
    vman = {"name": "F008_VALIDATION", **common, "docs": len(val_ids), "ids_sha256": hashlib.sha256("\n".join(val_ids).encode()).hexdigest()}
    for p, obj in ((man_path, hman), (D / "manifests" / "f008_validation.json", vman)):
        write_json(p, obj)
        write_json(REPO / "reports" / "f008" / p.name, obj)
    log(f"LOCKED F008 holdout {len(hold_ids):,} docs; validation {len(val_ids):,}")
    return 0


# ------------------------------------------------------------------ encode
def load_passages():
    if (W / "passages.parquet").exists():
        return pd.read_parquet(W / "passages.parquet")
    rows = []
    for r in pd.read_parquet(W / "pan11_sources.parquet").itertuples(index=False):
        t = Path(r.txt).read_text(errors="ignore")
        rows += [{"pid": p.pid, "doc": f"pan:{p.doc_id}", "start": p.start, "end": p.end, "text": p.text, "family": "pan"} for p in chunk_document(t, r.source)]
    for r in pd.read_parquet(W / "corpus_es.parquet").itertuples(index=False):
        rows.append({"pid": f"es:{r.docid}", "doc": f"es:{r.docid}", "start": 0, "end": len(r.text), "text": r.text, "family": "es"})
    df = pd.DataFrame(rows)
    df.to_parquet(W / "passages.parquet", index=False)
    return df


def encode() -> int:
    t0 = time.time()
    ps = load_passages()
    log(f"passages: {len(ps):,} ({ps['family'].value_counts().to_dict()})")
    perf = {}
    for kind in ("bge_m3", "e5"):
        if (W / f"emb_{kind}.npy").exists():
            continue
        enc = Dense(kind)
        t1 = time.time()
        if kind == "bge_m3":
            dense, lex = enc.encode(ps["text"].tolist(), batch=256, sparse=True)
            from scipy.sparse import save_npz
            save_npz(W / "bge_sparse.npz", lexical_weights_matrix(lex).tocsr())
        else:
            dense = enc.encode(ps["text"].tolist(), batch=256)
        np.save(W / f"emb_{kind}.npy", dense)
        perf[kind] = {"passages": len(ps), "seconds": round(time.time() - t1, 1), "passages_per_sec": round(len(ps) / (time.time() - t1), 1)}
        log(f"{kind}: {perf[kind]}")
        del enc
    write_json(D / "reports" / "encode_perf.json", {"passages": len(ps), "perf": perf, "seconds": round(time.time() - t0, 1)})
    return 0


# ------------------------------------------------------------------ queries / gold
def queries(split: str):
    """Query passages (chunked suspicious docs) with gold source docs and gold char spans."""
    out = []
    cases = pd.read_parquet(W / "pan11_cases.parquet")
    pan = pd.read_parquet(W / "pan_eval_docs.parquet")
    for r in pan[pan["split"] == split].itertuples(index=False):
        text = Path(r.txt).read_text(errors="ignore")
        cs = cases[cases["suspicious"] == r.suspicious]
        gold = [{"start": int(c.this_offset), "end": int(c.this_offset + c.this_length), "source": f"pan:{c.source}", "kind": str(c.obfuscation)} for c in cs.itertuples()]
        out.append({"doc_id": f"pan:{r.suspicious}", "text": text, "gold": gold, "family": "pan"})
    for r in pd.read_parquet(W / "es_synth_docs.parquet").query("split == @split").itertuples(index=False):
        out.append({"doc_id": r.doc_id, "text": r.text, "gold": [{**g, "source": f"es:{g['source']}"} if g.get("source") else g for g in json.loads(r.gold)],
                    "family": "es_synth"})
    for r in pd.read_parquet(W / "paws_docs.parquet").query("split == @split").itertuples(index=False):
        gold = [{"start": int(r.start), "end": int(r.end), "source": f"es:{r.source}", "kind": "PARAPHRASE"}] if r.label == 1 else []
        out.append({"doc_id": r.doc_id, "text": r.text, "gold": gold, "family": "paws", "paws_label": int(r.label), "paws_span": (int(r.start), int(r.end))})
    return out


# ------------------------------------------------------------------ retrieval systems
class Systems:
    def __init__(self, ps: pd.DataFrame):
        from scipy.sparse import load_npz

        self.ps = ps
        self.bm25 = BM25().fit(ps["text"].tolist())
        self.bge = np.load(W / "emb_bge_m3.npy")
        self.e5 = np.load(W / "emb_e5.npy")
        self.bge_sparse = load_npz(W / "bge_sparse.npz").T.tocsr()
        self.enc = {"bge_m3": Dense("bge_m3"), "e5": Dense("e5")}

    def run(self, qtexts: list[str], k: int = 100) -> dict:
        from f008_engine import _topk_sparse

        res = {"BM25": self.bm25.search(qtexts, k)}
        qd, qlex = self.enc["bge_m3"].encode(qtexts, query=True, sparse=True)
        res["BGE_DENSE"] = dense_search(qd, self.bge, k)
        res["BGE_SPARSE"] = _topk_sparse(lexical_weights_matrix(qlex).tocsr(), self.bge_sparse, k, 64)
        res["E5_DENSE"] = dense_search(self.enc["e5"].encode(qtexts, query=True), self.e5, k)
        return res


def fused(res: dict) -> dict:
    out = {k: [list(map(int, ids)) for ids in v[0]] for k, v in res.items()}
    out["RRF_BM25_BGE"] = rrf([res["BM25"][0], res["BGE_DENSE"][0]])
    out["RRF_BGE_DENSE_SPARSE"] = rrf([res["BGE_DENSE"][0], res["BGE_SPARSE"][0]])
    out["RRF_ALL"] = rrf([res["BM25"][0], res["BGE_DENSE"][0], res["BGE_SPARSE"][0], res["E5_DENSE"][0]])
    out["WEIGHTED_BM25_BGE"] = weighted_fusion([res["BM25"], res["BGE_DENSE"]], [0.4, 0.6])
    out["BGE_HYBRID_WEIGHTED"] = weighted_fusion([res["BGE_DENSE"], res["BGE_SPARSE"]], [0.6, 0.4])
    return out


def retrieval_metrics(rankings: list[list[int]], gold_docs: list[set], ps: pd.DataFrame) -> dict:
    docs = ps["doc"].values
    r = {k: [] for k in (1, 5, 10, 50)}
    mrr, ndcg = [], []
    for rank, gold in zip(rankings, gold_docs):
        seen, order = set(), []
        for pid in rank:
            d = docs[pid]
            if d not in seen:
                seen.add(d)
                order.append(d)
        hits = [i for i, d in enumerate(order) if d in gold]
        for k in r:
            r[k].append(1.0 if hits and hits[0] < k else 0.0)
        mrr.append(1.0 / (hits[0] + 1) if hits else 0.0)
        dcg = sum(1 / np.log2(i + 2) for i in hits if i < 10)
        idcg = sum(1 / np.log2(i + 2) for i in range(min(len(gold), 10)))
        ndcg.append(dcg / idcg if idcg else 0.0)
    return {f"recall@{k}": float(np.mean(v)) for k, v in r.items()} | {"mrr": float(np.mean(mrr)), "ndcg@10": float(np.mean(ndcg)), "queries": len(rankings)}


def query_passages(docs):
    qp = []
    for d in docs:
        for p in chunk_document(d["text"], d["doc_id"]):
            gsrc = {g["source"] for g in d["gold"] if g.get("source") and min(p.end, g["end"]) > max(p.start, g["start"])}
            qp.append({"doc_id": d["doc_id"], "family": d["family"], "start": p.start, "end": p.end, "text": p.text, "gold_sources": gsrc})
    return qp


def span_scores(docs, preds: dict) -> dict:
    """char-level P/R/F1 + IoU on suspicious side; same-topic / boilerplate / random false-match rates; paraphrase precision."""
    tp = fp = fn = 0
    ious, st_fp, st_n, bp_fp, bp_n, orig_fp, orig_n = [], 0, 0, 0, 0, 0, 0
    para_tp = para_fp = 0
    for d in docs:
        n = len(d["text"])
        gm = np.zeros(n, bool)
        for g in d["gold"]:
            if g.get("source"):
                gm[g["start"]:g["end"]] = True
        pm = np.zeros(n, bool)
        for m in preds.get(d["doc_id"], []):
            pm[m["queryStart"]:m["queryEnd"]] = True
        tp += int((pm & gm).sum()); fp += int((pm & ~gm).sum()); fn += int((~pm & gm).sum())
        u = int((pm | gm).sum())
        ious.append((pm & gm).sum() / u if u else 1.0)
        for g in d["gold"]:
            if g.get("kind") in ("SAME_TOPIC_NEGATIVE", "BOILERPLATE_NEGATIVE", "ORIGINAL"):
                frac = pm[g["start"]:g["end"]].mean() if g["end"] > g["start"] else 0
                hit = frac > 0.2
                if g["kind"] == "SAME_TOPIC_NEGATIVE":
                    st_n += 1; st_fp += hit
                elif g["kind"] == "BOILERPLATE_NEGATIVE":
                    bp_n += 1; bp_fp += hit
                else:
                    orig_n += 1; orig_fp += hit
        if d["family"] == "paws":
            s, e = d["paws_span"]
            hit = pm[s:e].mean() > 0.3
            para_tp += int(hit and d["paws_label"] == 1)
            para_fp += int(hit and d["paws_label"] == 0)
    P, R = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    return {"char_precision": P, "char_recall": R, "char_f1": 2 * P * R / max(P + R, 1e-9), "iou_mean": float(np.mean(ious)),
            "same_topic_fpr": st_fp / max(st_n, 1), "boilerplate_fpr": bp_fp / max(bp_n, 1), "random_fpr": orig_fp / max(orig_n, 1),
            "paraphrase_precision": para_tp / max(para_tp + para_fp, 1), "paraphrase_hits": para_tp, "paws_negative_hits": para_fp}


def detect(docs, sysm: Systems, system: str, rer: Reranker | None, cfg: dict, top_rerank: int = 20, top_align: int = 3, char: CharNgram | None = None):
    qp = query_passages(docs)
    texts = [q["text"] for q in qp]
    t0 = time.time()
    res = sysm.run(texts, 100)
    rankings = fused(res)[system]
    t_ret = time.time() - t0
    t1 = time.time()
    ps = sysm.ps
    cands = [r[:top_rerank] for r in rankings]
    pairs = [(q["text"], ps["text"].iat[pid]) for q, c in zip(qp, cands) for pid in c]
    rs = rer.score(pairs) if rer else np.ones(len(pairs))
    t_rr = time.time() - t1
    preds, k, t2 = {}, 0, time.time()
    for q, c in zip(qp, cands):
        sc = rs[k:k + len(c)]
        k += len(c)
        order = np.argsort(-sc)[:top_align]
        for j in order:
            if sc[j] < cfg["tau_doc"]:
                continue
            pid = c[j]
            for m in align(q["text"], ps["text"].iat[pid], sysm.enc["bge_m3"], rer, char, cfg["tau_sem"], cfg["tau_rr"]):
                m = {**m, "queryStart": m["queryStart"] + q["start"], "queryEnd": m["queryEnd"] + q["start"], "source": ps["doc"].iat[pid],
                     "rerankerScore": m["rerankerScore"] if m["rerankerScore"] is not None else float(sc[j])}
                preds.setdefault(q["doc_id"], []).append(m)
    t_al = time.time() - t2
    reranked = [[c[j] for j in np.argsort(-rs[sum(len(x) for x in cands[:i]):sum(len(x) for x in cands[:i + 1])])] for i, c in enumerate(cands)]
    gold = [q["gold_sources"] for q in qp]
    pos = [i for i, g in enumerate(gold) if g]
    perf = {"query_passages": len(qp), "retrieval_s": t_ret, "rerank_s": t_rr, "align_s": t_al, "queries_per_sec": len(qp) / max(t_ret, 1e-9)}
    return preds, rankings, reranked, gold, pos, perf


def bakeoff() -> int:
    ps = load_passages()
    sysm = Systems(ps)
    docs = queries("validation")
    qp = query_passages(docs)
    texts = [q["text"] for q in qp]
    gold = [q["gold_sources"] for q in qp]
    pos = [i for i, g in enumerate(gold) if g]
    res = fused(sysm.run(texts, 100))
    ret = {}
    for fam in ("pan", "es_synth", "paws"):
        idx = [i for i in pos if qp[i]["family"] == fam]
        ret[fam] = {name: retrieval_metrics([r[i] for i in idx], [gold[i] for i in idx], ps) for name, r in res.items()}
    best = max(res, key=lambda n: np.mean([ret[f][n]["mrr"] for f in ret if ret[f][n]["queries"]]))
    rer = Reranker()
    rr_rank = []
    for i in pos:
        c = res[best][i][:100]
        sc = rer.score([(texts[i], ps["text"].iat[p]) for p in c])
        rr_rank.append([c[j] for j in np.argsort(-sc)])
    rer_metrics = {fam: retrieval_metrics([rr_rank[k] for k, i in enumerate(pos) if qp[i]["family"] == fam], [gold[i] for i in pos if qp[i]["family"] == fam], ps)
                   for fam in ("pan", "es_synth", "paws")}
    char = CharNgram()
    grid = [{"tau_doc": td, "tau_sem": ts, "tau_rr": tr} for td in (0.2, 0.4) for ts in (0.78, 0.85) for tr in (0.4, 0.7)]
    span_res = []
    sub = docs[:: max(1, len(docs) // 400)]
    for cfg in grid:
        preds, *_ = detect(sub, sysm, best, rer, cfg, char=char)
        sc = span_scores(sub, preds)
        sc["config"] = cfg
        sc["objective"] = sc["char_f1"] - 2 * max(0, sc["same_topic_fpr"] - 0.02) - 2 * max(0, sc["boilerplate_fpr"] - 0.02) - 0.5 * (1 - sc["paraphrase_precision"])
        span_res.append(sc)
        log(f"span cfg {cfg}: {json.dumps({k: round(v, 3) for k, v in sc.items() if isinstance(v, float)})}")
    chosen = max(span_res, key=lambda x: x["objective"])
    out = {"set": "F008_VALIDATION", "retrieval_zero_shot": ret, "best_retrieval_system": best, "reranker_bge_v2_m3": rer_metrics,
           "span_alignment_grid": span_res, "chosen_alignment": chosen["config"],
           "fine_tune_decision": "not run: zero-shot BGE-M3 hybrid + reranker is the baseline; see report for whether validation justifies training"}
    write_json(D / "reports" / "zero_shot_bakeoff.json", out)
    for name in ("zero_shot_bakeoff.json",):
        write_json(REPO / "reports" / "f008" / name, out)
    write_json(REPO / "reports" / "f008" / "retrieval_validation.json", {"retrieval": ret, "best": best})
    write_json(REPO / "reports" / "f008" / "reranker_validation.json", rer_metrics)
    write_json(REPO / "reports" / "f008" / "span_validation.json", {"grid": span_res, "chosen": chosen})
    log(f"best retrieval {best}; chosen alignment {chosen['config']}")
    return 0


def index_bench() -> int:
    import faiss
    import torch

    mir = pd.read_parquet(W / "miracl_es.parquet")
    n = min(len(mir), 1_500_000)
    texts = mir["text"].iloc[:n].tolist()
    enc = Dense("bge_m3")
    t0 = time.time()
    emb = enc.encode(texts, batch=512).astype(np.float32)
    t_emb = time.time() - t0
    q = emb[np.random.default_rng(1).choice(n, 1000, replace=False)]
    out = {"vectors": int(n), "dim": int(emb.shape[1]), "embedding_passages_per_sec": n / t_emb}
    t = time.time()
    gt, _ = dense_search(q.astype(np.float16), emb.astype(np.float16), 10)
    out["exact_gpu_fp16"] = {"memory_gb": emb.astype(np.float16).nbytes / 1e9, "query_ms": (time.time() - t) / 1000 * 1000}
    for name, factory in (("IVF4096_PQ64", "IVF4096,PQ64"), ("HNSW32", "HNSW32")):
        idx = faiss.index_factory(emb.shape[1], factory, faiss.METRIC_INNER_PRODUCT)
        t = time.time()
        if not idx.is_trained:
            idx.train(emb[np.random.default_rng(2).choice(n, min(n, 200_000), replace=False)])
        idx.add(emb)
        build = time.time() - t
        if hasattr(idx, "nprobe"):
            faiss.ParameterSpace().set_index_parameter(idx, "nprobe", 64)
        t = time.time()
        _, I = idx.search(q, 10)
        lat = (time.time() - t) / len(q) * 1000
        rec = float(np.mean([len(set(I[i]) & set(gt[i])) / 10 for i in range(len(q))]))
        faiss.write_index(idx, str(W / f"miracl_{name}.faiss"))
        out[name] = {"build_s": build, "query_ms": lat, "recall@10_vs_exact": rec, "disk_gb": (W / f"miracl_{name}.faiss").stat().st_size / 1e9}
        log(f"{name}: {out[name]}")
    out["gpu"] = torch.cuda.get_device_name(0)
    write_json(D / "reports" / "index_benchmark.json", out)
    write_json(REPO / "reports" / "f008" / "index_benchmark.json", out)
    return 0


def final() -> int:
    done = D / "manifests" / "F008_FINAL_EVAL_DONE.json"
    if done.exists():
        log("already evaluated once")
        return 0
    bk = json.loads((D / "reports" / "zero_shot_bakeoff.json").read_text())
    hman = json.loads((D / "manifests" / "f008_final_holdout.json").read_text())
    lock = {"name": "F008_MODEL_LOCK", "LOCKED": True, "lockedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "retriever": bk["best_retrieval_system"],
            "dense_model": "BAAI/bge-m3", "sparse": "BM25 (k1 1.2, b 0.75) + BGE-M3 lexical weights", "reranker": "BAAI/bge-reranker-v2-m3",
            "alignment": bk["chosen_alignment"], "chunking": "paragraph-aware ~200 words (150-400 tokens), sentence boundaries, original offsets",
            "holdout_manifest_sha256": sha256_file(D / "manifests" / "f008_final_holdout.json"), "fine_tuned": False}
    write_json(D / "manifests" / "F008_MODEL_LOCK.json", lock)
    write_json(REPO / "reports" / "f008" / "model_lock.json", lock)
    ps = load_passages()
    sysm = Systems(ps)
    rer, char = Reranker(), CharNgram()
    docs = queries("holdout")
    preds, rankings, reranked, gold, pos, perf = detect(docs, sysm, lock["retriever"], rer, lock["alignment"], char=char)
    qp = query_passages(docs)
    out = {"set": "F008_FINAL_HOLDOUT", "evaluatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "lock": lock, "holdout_docs": hman["docs"], "performance": perf}
    for fam in ("pan", "es_synth", "paws"):
        idx = [i for i in pos if qp[i]["family"] == fam]
        fdocs = [d for d in docs if d["family"] == fam]
        out[fam] = {"retrieval": retrieval_metrics([rankings[i] for i in idx], [gold[i] for i in idx], ps),
                    "reranked": retrieval_metrics([reranked[i] for i in idx], [gold[i] for i in idx], ps),
                    "spans": span_scores(fdocs, preds)}
    out["all_spans"] = span_scores(docs, preds)
    cov = []
    for d in [x for x in docs if x["family"] == "es_synth"]:
        gold_cov = sum(g["end"] - g["start"] for g in d["gold"] if g.get("source")) / max(len(d["text"]), 1)
        by = {}
        for m in preds.get(d["doc_id"], []):
            by.setdefault(m["source"], []).append(m)
        c = coverage(d["text"], by)
        cov.append((c["matchedCoverage"], gold_cov))
    cov = np.asarray(cov) if cov else np.zeros((0, 2))
    out["document_coverage"] = {"mae": float(np.abs(cov[:, 0] - cov[:, 1]).mean()) if len(cov) else None,
                                "rmse": float(np.sqrt(((cov[:, 0] - cov[:, 1]) ** 2).mean())) if len(cov) else None,
                                "note": "gold = copied characters / all characters; predicted = matched eligible tokens / eligible tokens"}
    criteria = {"recall@10_es_ge_0.9": out["es_synth"]["reranked"]["recall@10"] >= 0.9, "char_f1_es_ge_0.8": out["es_synth"]["spans"]["char_f1"] >= 0.8,
                "same_topic_fpr_le_0.05": out["all_spans"]["same_topic_fpr"] <= 0.05, "boilerplate_fpr_le_0.05": out["all_spans"]["boilerplate_fpr"] <= 0.05,
                "paraphrase_precision_ge_0.8": out["all_spans"]["paraphrase_precision"] >= 0.8}
    out["criteria"] = criteria
    out["status"] = "CANDIDATE" if all(criteria.values()) else "EXPERIMENTAL"
    write_json(D / "reports" / "final_holdout.json", out)
    write_json(REPO / "reports" / "f008" / "final_holdout.json", out)
    write_json(done, {"evaluatedAt": out["evaluatedAt"], "status": out["status"]})
    log(f"F008 final: {out['status']} {criteria}")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1]
    raise SystemExit({"build": build, "encode": encode, "bakeoff": bakeoff, "index": index_bench, "final": final}[cmd]())
