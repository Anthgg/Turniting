"""Language-agnostic stylometric features (no single feature is used as a detector)."""

from __future__ import annotations

import re
from collections import Counter

import numpy as np

_WORD = re.compile(r"\w+", re.UNICODE)
_SENT = re.compile(r"[.!?。！？]+")
_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)

FEATURE_NAMES = [
    "log_chars", "log_words", "mean_word_len", "std_word_len", "mean_sent_len", "std_sent_len",
    "n_sentences_log", "type_token_ratio", "hapax_ratio", "dis_legomena_ratio", "punct_ratio",
    "comma_ratio", "digit_ratio", "upper_ratio", "whitespace_ratio", "newline_ratio",
    "repeated_word_bigram_ratio", "top_word_freq", "long_word_ratio", "short_word_ratio",
    "question_ratio", "exclaim_ratio", "quote_ratio", "paren_ratio", "non_ascii_ratio",
    "para_count_log", "mean_para_len_log", "stopword_like_ratio", "unique_char_ratio",
]


def stylometric_vector(text: str) -> np.ndarray:
    n_chars = max(len(text), 1)
    words = _WORD.findall(text.lower())
    n_words = max(len(words), 1)
    lens = np.array([len(w) for w in words]) if words else np.array([0])
    sents = [s for s in _SENT.split(text) if s.strip()]
    sent_lens = np.array([len(_WORD.findall(s)) for s in sents]) if sents else np.array([n_words])
    counts = Counter(words)
    hapax = sum(1 for c in counts.values() if c == 1)
    dis = sum(1 for c in counts.values() if c == 2)
    bigrams = list(zip(words, words[1:]))
    bigram_counts = Counter(bigrams)
    repeated = sum(c for c in bigram_counts.values() if c > 1) / max(len(bigrams), 1)
    paras = [p for p in text.split("\n") if p.strip()]
    short = {w for w, _ in counts.most_common(30)}
    return np.array([
        np.log1p(len(text)),
        np.log1p(len(words)),
        lens.mean(),
        lens.std(),
        sent_lens.mean(),
        sent_lens.std(),
        np.log1p(len(sents)),
        len(counts) / n_words,
        hapax / n_words,
        dis / n_words,
        len(_PUNCT.findall(text)) / n_chars,
        text.count(",") / n_chars,
        sum(ch.isdigit() for ch in text) / n_chars,
        sum(ch.isupper() for ch in text) / n_chars,
        sum(ch.isspace() for ch in text) / n_chars,
        text.count("\n") / n_chars,
        repeated,
        (counts.most_common(1)[0][1] / n_words) if counts else 0.0,
        float((lens >= 10).mean()),
        float((lens <= 3).mean()),
        text.count("?") / n_chars,
        text.count("!") / n_chars,
        (text.count('"') + text.count("“") + text.count("”") + text.count("«")) / n_chars,
        (text.count("(") + text.count(")")) / n_chars,
        sum(ord(ch) > 127 for ch in text) / n_chars,
        np.log1p(len(paras)),
        np.log1p(n_words / max(len(paras), 1)),
        sum(counts[w] for w in short) / n_words,
        len(set(text)) / n_chars,
    ], dtype=np.float32)


def stylometric_matrix(texts) -> np.ndarray:
    return np.vstack([stylometric_vector(t) for t in texts]) if len(texts) else np.zeros((0, len(FEATURE_NAMES)), np.float32)
