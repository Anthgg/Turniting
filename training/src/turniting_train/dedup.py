"""Exact and near-duplicate detection (MinHash + LSH banding, no O(N^2))."""

from __future__ import annotations

import re
import zlib

import numpy as np

from .textnorm import dedup_key_text

_TOKEN = re.compile(r"\w+", re.UNICODE)
_CJK = re.compile(r"[぀-ヿ一-鿿가-힯]")


class MinHasher:
    def __init__(self, num_perm: int = 64, seed: int = 42, max_chars: int = 3000, ngram: int = 3):
        rng = np.random.default_rng(seed)
        self.num_perm = num_perm
        self.max_chars = max_chars
        self.ngram = ngram
        self.a = rng.integers(1, (1 << 61) - 1, size=num_perm, dtype=np.uint64)
        self.b = rng.integers(0, (1 << 61) - 1, size=num_perm, dtype=np.uint64)

    def shingles(self, text: str) -> np.ndarray:
        text = dedup_key_text(text)[: self.max_chars].lower()
        if _CJK.search(text):
            chars = text.replace(" ", "")
            grams = [chars[i:i + 5] for i in range(max(1, len(chars) - 4))]
            return np.fromiter((zlib.crc32(g.encode()) for g in grams), dtype=np.uint64, count=len(grams))
        tokens = np.fromiter((zlib.crc32(t.encode()) for t in _TOKEN.findall(text)), dtype=np.uint64)
        n = self.ngram
        if tokens.size < n:
            return tokens if tokens.size else np.array([zlib.crc32(text.encode())], dtype=np.uint64)
        # order-sensitive combination of consecutive token hashes
        with np.errstate(over="ignore"):
            combined = tokens[:-2] * np.uint64(1_000_003) ^ tokens[1:-1] * np.uint64(7_919) ^ tokens[2:]
        return np.unique(combined)

    def signature(self, text: str) -> np.ndarray:
        sh = self.shingles(text) & np.uint64(0xFFFFFFFF)
        # a*x + b wrapping mod 2^64: a deterministic hash family (exact universality not needed)
        with np.errstate(over="ignore"):
            prod = self.a[:, None] * sh[None, :] + self.b[:, None]
        return (prod.min(axis=1) >> np.uint64(32)).astype(np.uint32)


def band_hashes(signatures: np.ndarray, bands: int) -> np.ndarray:
    """(n, num_perm) uint32 -> (n, bands) uint64 hashes of each band."""
    n, num_perm = signatures.shape
    rows = num_perm // bands
    out = np.zeros((n, bands), dtype=np.uint64)
    with np.errstate(over="ignore"):
        for b in range(bands):
            h = np.full(n, 1469598103934665603, dtype=np.uint64)
            for j in range(rows):
                h = (h ^ signatures[:, b * rows + j].astype(np.uint64)) * np.uint64(1099511628211)
            out[:, b] = h
    return out


def candidate_pairs(bands: np.ndarray, eligible: np.ndarray) -> np.ndarray:
    """Adjacent pairs that share a band value (chain linking inside each bucket: O(N log N))."""
    pairs = []
    idx = np.flatnonzero(eligible)
    for b in range(bands.shape[1]):
        values = bands[idx, b]
        order = np.argsort(values, kind="stable")
        sorted_vals = values[order]
        same = sorted_vals[1:] == sorted_vals[:-1]
        left = idx[order[:-1][same]]
        right = idx[order[1:][same]]
        pairs.append(np.stack([left, right], axis=1))
    if not pairs:
        return np.empty((0, 2), dtype=np.int64)
    allp = np.concatenate(pairs)
    allp.sort(axis=1)
    return np.unique(allp, axis=0)


def estimated_jaccard(signatures: np.ndarray, pairs: np.ndarray, chunk: int = 200_000) -> np.ndarray:
    out = np.empty(len(pairs), dtype=np.float32)
    for start in range(0, len(pairs), chunk):
        p = pairs[start:start + chunk]
        out[start:start + chunk] = (signatures[p[:, 0]] == signatures[p[:, 1]]).mean(axis=1)
    return out


def connected_components(n_nodes: int, edges: np.ndarray) -> np.ndarray:
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components as cc

    if len(edges) == 0:
        return np.arange(n_nodes)
    data = np.ones(len(edges), dtype=np.int8)
    graph = coo_matrix((data, (edges[:, 0], edges[:, 1])), shape=(n_nodes, n_nodes))
    _, labels = cc(graph, directed=False)
    return labels
