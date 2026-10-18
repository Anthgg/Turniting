"""F008 experimental similarity engine (independent of any commercial service; no private corpus).

QUERY DOCUMENT -> paragraph-aware chunking (offsets kept) -> sparse (BM25 / BGE-M3 sparse / char n-grams) + dense
(BGE-M3 / multilingual-E5) retrieval -> fusion (RRF or weighted) -> cross-encoder reranking (bge-reranker-v2-m3)
-> span alignment (word n-gram seeds + monotone chaining for LEXICAL_MATCH; sentence embeddings + reranker +
char-gram evidence for PARAPHRASE_MATCH) -> overlap resolution -> source grouping -> document coverage
(unique matched eligible tokens / eligible tokens; references, URLs, DOIs, ORCID, institution headers and generic
academic boilerplate are not eligible).
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

import numpy as np

WORD = re.compile(r"\w+", re.U)
SENT = re.compile(r"[^.!?¿¡\n]+[.!?]+[\"'”’)\]]*|[^.!?¿¡\n]+$", re.U)
REF_HEAD = re.compile(r"^\s*(referencias|bibliograf[ií]a|references|bibliography|obras citadas|works cited)\s*:?\s*$", re.I | re.M)
NON_ELIGIBLE = [re.compile(p, re.I) for p in (r"https?://\S+", r"\bwww\.\S+", r"\bdoi\s*:?\s*10\.\S+", r"\b10\.\d{4,9}/\S+", r"\borcid\b[:\s]*[\d-]{15,19}",
                                              r"\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b", r"\S+@\S+\.\w+")]
BOILERPLATE = [re.compile(p, re.I) for p in (
    r"el presente (estudio|trabajo|art[ií]culo) tiene (como|por) objetivo", r"los resultados (muestran|indican|sugieren) que", r"en conclusi[oó]n",
    r"por lo tanto", r"de acuerdo con los resultados", r"la presente investigaci[oó]n", r"materiales? y m[eé]todos?", r"palabras clave",
    r"universidad (nacional|aut[oó]noma|de) [\w ]{2,40}", r"facultad de [\w ]{2,40}", r"this (study|paper) aims to", r"the results (show|indicate|suggest) that",
    r"in conclusion", r"keywords?:", r"resumen\s*:", r"abstract\s*:")]


# ------------------------------------------------------------------ chunking

@dataclass
class Passage:
    pid: str
    doc_id: str
    para: int
    start: int
    end: int
    text: str


def chunk_document(text: str, doc_id: str, target_words: int = 200, max_words: int = 300, min_words: int = 40) -> list[Passage]:
    """Paragraph-aware passages of ~150-400 tokens (~115-300 words) with original character offsets."""
    out, para_spans = [], [(m.start(), m.end()) for m in re.finditer(r"\S[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*", text)]
    for pi, (ps, pe) in enumerate(para_spans):
        sents = [(ps + m.start(), ps + m.end()) for m in SENT.finditer(text[ps:pe]) if m.group(0).strip()]
        cur, words = None, 0
        for s, e in sents:
            w = len(text[s:e].split())
            if cur and words + w > max_words:
                out.append((pi, cur[0], cur[1]))
                cur, words = None, 0
            cur = (cur[0], e) if cur else (s, e)
            words += w
            if words >= target_words:
                out.append((pi, cur[0], cur[1]))
                cur, words = None, 0
        if cur:
            if out and out[-1][0] == pi and words < min_words:
                out[-1] = (pi, out[-1][1], cur[1])
            else:
                out.append((pi, cur[0], cur[1]))
    return [Passage(f"{doc_id}::{k}", doc_id, pi, s, e, text[s:e]) for k, (pi, s, e) in enumerate(out)]


# ------------------------------------------------------------------ sparse retrieval

class BM25:
    """Okapi BM25 over a CountVectorizer vocabulary; scores = binary(query) @ W^T (sparse)."""

    def __init__(self, k1: float = 1.2, b: float = 0.75):
        self.k1, self.b = k1, b

    def fit(self, texts: list[str]):
        from sklearn.feature_extraction.text import CountVectorizer

        self.vec = CountVectorizer(lowercase=True, strip_accents="unicode", token_pattern=r"(?u)\b\w\w+\b", dtype=np.float32)
        tf = self.vec.fit_transform(texts).tocsr()
        n = tf.shape[0]
        df = np.bincount(tf.indices, minlength=tf.shape[1])
        idf = np.log(1 + (n - df + 0.5) / (df + 0.5)).astype(np.float32)
        dl = np.asarray(tf.sum(1)).ravel()
        avg = dl.mean()
        tf = tf.tocoo()
        denom = tf.data + self.k1 * (1 - self.b + self.b * dl[tf.row] / avg)
        data = idf[tf.col] * tf.data * (self.k1 + 1) / denom
        from scipy.sparse import csr_matrix

        self.W = csr_matrix((data, (tf.row, tf.col)), shape=tf.shape).T.tocsr()  # V x N
        return self

    def search(self, queries: list[str], k: int = 100, batch: int = 64):
        q = (self.vec.transform(queries) > 0).astype(np.float32).tocsr()
        return _topk_sparse(q, self.W, k, batch)


def _topk_sparse(q, W, k, batch):
    ids, scores = [], []
    for s in range(0, q.shape[0], batch):
        m = (q[s:s + batch] @ W).toarray()
        kk = min(k, m.shape[1])
        part = np.argpartition(-m, kk - 1, axis=1)[:, :kk]
        ps = np.take_along_axis(m, part, 1)
        order = np.argsort(-ps, axis=1)
        ids.append(np.take_along_axis(part, order, 1))
        scores.append(np.take_along_axis(ps, order, 1))
    return np.vstack(ids), np.vstack(scores)


class CharNgram:
    """Hashed character 4-5-gram TF-IDF-like vectors (L2) for lexical retrieval / pair scoring."""

    def __init__(self, n_features: int = 2 ** 20):
        from sklearn.feature_extraction.text import HashingVectorizer

        self.vec = HashingVectorizer(analyzer="char_wb", ngram_range=(4, 5), n_features=n_features, alternate_sign=False, norm="l2",
                                     lowercase=True, strip_accents="unicode")

    def fit(self, texts):
        self.M = self.vec.transform(texts).T.tocsr()  # F x N
        return self

    def search(self, queries, k=100, batch=64):
        return _topk_sparse(self.vec.transform(queries).tocsr(), self.M, k, batch)

    def pair(self, a: list[str], b: list[str]) -> np.ndarray:
        A, B = self.vec.transform(a), self.vec.transform(b)
        return np.asarray(A.multiply(B).sum(1)).ravel()


# ------------------------------------------------------------------ dense retrieval

class Dense:
    """BGE-M3 (dense + sparse lexical weights) or multilingual-E5-large-instruct; exact GPU inner-product search."""

    TASK = "Given a text passage, retrieve the source passage it was copied, translated or paraphrased from"

    def __init__(self, kind: str, device: str = "cuda"):
        self.kind, self.device = kind, device
        if kind == "bge_m3":
            from FlagEmbedding import BGEM3FlagModel

            self.m = BGEM3FlagModel("BAAI/bge-m3", use_fp16=True, devices=[device])
        else:
            from sentence_transformers import SentenceTransformer

            self.m = SentenceTransformer("intfloat/multilingual-e5-large-instruct", device=device)
            self.m.half()

    def encode(self, texts: list[str], query: bool = False, batch: int = 128, sparse: bool = False):
        if self.kind == "bge_m3":
            out = self.m.encode(texts, batch_size=batch, max_length=512, return_dense=True, return_sparse=sparse, return_colbert_vecs=False)
            dense = np.asarray(out["dense_vecs"], dtype=np.float16)
            return (dense, out["lexical_weights"]) if sparse else dense
        if query:
            texts = [f"Instruct: {self.TASK}\nQuery: {t}" for t in texts]
        return np.asarray(self.m.encode(texts, batch_size=batch, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False), dtype=np.float16)


def dense_search(qv: np.ndarray, dv: np.ndarray, k: int = 100, device: str = "cuda", chunk: int = 400_000):
    import torch

    q = torch.from_numpy(qv).to(device)
    best_s = best_i = None
    for s in range(0, len(dv), chunk):
        d = torch.from_numpy(dv[s:s + chunk]).to(device)
        sc = q @ d.T
        kk = min(k, sc.shape[1])
        v, i = sc.topk(kk, dim=1)
        i = i + s
        if best_s is None:
            best_s, best_i = v, i
        else:
            v2, j = torch.cat([best_s, v], 1).topk(min(k, best_s.shape[1] + kk), dim=1)
            best_i = torch.gather(torch.cat([best_i, i], 1), 1, j)
            best_s = v2
        del d, sc
    return best_i.cpu().numpy(), best_s.float().cpu().numpy()


def lexical_weights_matrix(weights: list[dict], vocab: int = 250_002):
    from scipy.sparse import csr_matrix

    rows, cols, vals = [], [], []
    for r, w in enumerate(weights):
        for t, v in w.items():
            rows.append(r); cols.append(int(t)); vals.append(float(v))
    return csr_matrix((np.asarray(vals, np.float32), (rows, cols)), shape=(len(weights), vocab))


# ------------------------------------------------------------------ fusion / reranking

def rrf(rankings: list[np.ndarray], k: int = 60, top: int = 100) -> list[list[int]]:
    out = []
    for qi in range(len(rankings[0])):
        sc: dict[int, float] = {}
        for r in rankings:
            for rank, pid in enumerate(r[qi]):
                sc[int(pid)] = sc.get(int(pid), 0.0) + 1.0 / (k + rank + 1)
        out.append([p for p, _ in sorted(sc.items(), key=lambda x: -x[1])[:top]])
    return out


def weighted_fusion(results: list[tuple[np.ndarray, np.ndarray]], weights: list[float], top: int = 100) -> list[list[int]]:
    out = []
    for qi in range(len(results[0][0])):
        sc: dict[int, float] = {}
        for (ids, scores), w in zip(results, weights):
            s = scores[qi]
            lo, hi = float(s.min()), float(s.max())
            for pid, v in zip(ids[qi], s):
                sc[int(pid)] = sc.get(int(pid), 0.0) + w * ((v - lo) / (hi - lo) if hi > lo else 1.0)
        out.append([p for p, _ in sorted(sc.items(), key=lambda x: -x[1])[:top]])
    return out


class Reranker:
    def __init__(self, device="cuda"):
        from FlagEmbedding import FlagReranker

        self.m = FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=True, devices=[device])

    def score(self, pairs: list[tuple[str, str]], batch: int = 128) -> np.ndarray:
        if not pairs:
            return np.zeros(0)
        return np.asarray(self.m.compute_score([list(p) for p in pairs], batch_size=batch, max_length=512, normalize=True), dtype=np.float32).reshape(-1)


# ------------------------------------------------------------------ eligibility / normalisation

def normalise_with_map(text: str) -> tuple[str, np.ndarray]:
    """NFKC + casefold + punctuation->space + collapsed whitespace, with a map back to original offsets."""
    chars, pos = [], []
    for i, ch in enumerate(text):
        c = unicodedata.normalize("NFKC", ch).casefold()
        c = "".join(x if (x.isalnum()) else " " for x in c)
        for x in c:
            if x == " " and chars and chars[-1] == " ":
                continue
            chars.append(x)
            pos.append(i)
    return "".join(chars), np.asarray(pos + [len(text)])


def eligible_mask(text: str) -> np.ndarray:
    m = np.ones(len(text), bool)
    ref = REF_HEAD.search(text)
    if ref:
        m[ref.start():] = False
    for rx in NON_ELIGIBLE + BOILERPLATE:
        for x in rx.finditer(text):
            m[x.start():x.end()] = False
    for line in re.finditer(r"[^\n]+", text):  # short all-caps institution / heading lines
        s = line.group(0)
        if len(s.split()) <= 12 and s.isupper():
            m[line.start():line.end()] = False
    return m


# ------------------------------------------------------------------ span alignment

def _words(text: str):
    return [(m.start(), m.end(), m.group(0).casefold()) for m in WORD.finditer(unicodedata.normalize("NFKC", text))]


def lexical_regions(q: str, s: str, n: int = 4, max_gap: int = 30, min_seeds: int = 3):
    """Word n-gram seeds chained monotonically into regions -> [(qs, qe, ss, se, matched_words)] in char offsets."""
    qw, sw = _words(q), _words(s)
    if len(qw) < n or len(sw) < n:
        return []
    index: dict[tuple, list[int]] = {}
    for j in range(len(sw) - n + 1):
        index.setdefault(tuple(w for _, _, w in sw[j:j + n]), []).append(j)
    seeds = []
    for i in range(len(qw) - n + 1):
        for j in index.get(tuple(w for _, _, w in qw[i:i + n]), [])[:20]:
            seeds.append((i, j))
    if not seeds:
        return []
    seeds.sort()
    regions, cur = [], [seeds[0]]
    for i, j in seeds[1:]:
        pi, pj = cur[-1]
        if 0 <= i - pi <= max_gap and 0 <= j - pj <= max_gap + 10:
            cur.append((i, j))
        elif 0 <= i - pi <= max_gap and abs(j - pj) > max_gap + 10:
            continue
        else:
            regions.append(cur)
            cur = [(i, j)]
    regions.append(cur)
    out = []
    for r in regions:
        if len(r) < min_seeds:
            continue
        i0, j0 = r[0]
        i1, j1 = r[-1]
        out.append((qw[i0][0], qw[min(i1 + n - 1, len(qw) - 1)][1], sw[j0][0], sw[min(j1 + n - 1, len(sw) - 1)][1], len(r) + n - 1))
    return out


def sentences(text: str):
    return [(m.start(), m.end(), m.group(0)) for m in SENT.finditer(text) if len(m.group(0).split()) >= 6]


def paraphrase_regions(q: str, s: str, encoder: Dense, reranker: Reranker | None, covered: np.ndarray, tau_sem: float, tau_rr: float, char: CharNgram):
    """Sentence-level semantic matches outside lexical regions, confirmed by the reranker (when given)."""
    qs, ss = sentences(q), sentences(s)
    qs = [x for x in qs if covered[x[0]:x[1]].mean() < 0.5]
    if not qs or not ss:
        return []
    qv = encoder.encode([x[2] for x in qs], query=True)
    sv = encoder.encode([x[2] for x in ss])
    sim = qv.astype(np.float32) @ sv.astype(np.float32).T
    best = sim.argmax(1)
    cand = [(k, int(best[k]), float(sim[k, best[k]])) for k in range(len(qs)) if sim[k, best[k]] >= tau_sem]
    if not cand:
        return []
    rr = reranker.score([(qs[k][2], ss[j][2]) for k, j, _ in cand]) if reranker else np.ones(len(cand))
    lex = char.pair([qs[k][2] for k, _, _ in cand], [ss[j][2] for _, j, _ in cand])
    return [(qs[k][0], qs[k][1], ss[j][0], ss[j][1], sv_, float(r), float(lx)) for (k, j, sv_), r, lx in zip(cand, rr, lex) if r >= tau_rr]


def align(q: str, s: str, encoder: Dense | None = None, reranker: Reranker | None = None, char: CharNgram | None = None,
          tau_sem: float = 0.80, tau_rr: float = 0.5, lexical_type_min: float = 0.5) -> list[dict]:
    covered = np.zeros(len(q) + 1, bool)
    out = []
    for qs_, qe, ss_, se, nw in lexical_regions(q, s):
        covered[qs_:qe] = True
        lex = float(char.pair([q[qs_:qe]], [s[ss_:se]])[0]) if char else 1.0
        out.append({"queryStart": qs_, "queryEnd": qe, "sourceStart": ss_, "sourceEnd": se, "matchedWords": nw, "lexicalScore": lex,
                    "semanticScore": None, "rerankerScore": None, "matchType": "LEXICAL_MATCH" if lex >= lexical_type_min else "PARAPHRASE_MATCH"})
    if encoder is not None and char is not None:
        for qs_, qe, ss_, se, sem, rr, lex in paraphrase_regions(q, s, encoder, reranker, covered, tau_sem, tau_rr, char):
            out.append({"queryStart": qs_, "queryEnd": qe, "sourceStart": ss_, "sourceEnd": se, "matchedWords": None, "lexicalScore": lex,
                        "semanticScore": sem, "rerankerScore": rr, "matchType": "PARAPHRASE_MATCH"})
    return out


# ------------------------------------------------------------------ coverage

def coverage(query_text: str, matches_by_source: dict[str, list[dict]]) -> dict:
    """Unique matched eligible tokens / eligible tokens; a char covered by several sources counts once globally and is
    attributed to the source with the highest reranker / lexical score for the per-source contribution."""
    elig = eligible_mask(query_text)
    toks = [(m.start(), m.end()) for m in WORD.finditer(query_text)]
    tok_ok = [elig[s:e].mean() >= 0.5 for s, e in toks]
    owner = np.full(len(query_text), -1)
    best = np.full(len(query_text), -math.inf)
    srcs = list(matches_by_source)
    for k, src in enumerate(srcs):
        for m in matches_by_source[src]:
            sc = m.get("rerankerScore") if m.get("rerankerScore") is not None else m.get("lexicalScore") or 0.0
            sl = slice(m["queryStart"], m["queryEnd"])
            upd = best[sl] < sc
            owner[sl] = np.where(upd, k, owner[sl])
            best[sl] = np.where(upd, sc, best[sl])
    eligible = sum(tok_ok)
    matched, contrib = 0, {s: 0 for s in srcs}
    for (s, e), ok in zip(toks, tok_ok):
        if not ok:
            continue
        o = owner[s:e]
        o = o[o >= 0]
        if len(o):
            matched += 1
            contrib[srcs[int(np.bincount(o).argmax())]] += 1
    return {"similarityScore": matched / max(eligible, 1), "matchedCoverage": matched / max(eligible, 1), "eligibleTokens": int(eligible),
            "matchedTokens": int(matched), "sourceContribution": {s: c / max(eligible, 1) for s, c in contrib.items()}}
