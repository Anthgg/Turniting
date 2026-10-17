"""Hashed word + char TF-IDF used by the baselines (importable so pickles load anywhere)."""

from __future__ import annotations

import numpy as np
from sklearn.feature_extraction.text import HashingVectorizer, TfidfTransformer
from sklearn.pipeline import FeatureUnion


class TextVectorizer:
    """Word (1,2) + char_wb (3,5) hashed TF-IDF; hashing keeps RAM bounded (no vocabulary dict)."""

    def __init__(self, cfg: dict):
        self.max_chars = cfg["max_chars"]
        self.union = FeatureUnion([
            ("word", HashingVectorizer(ngram_range=tuple(cfg["word_ngrams"]), n_features=2**21,
                                       alternate_sign=False, norm=None, dtype=np.float32,
                                       token_pattern=r"(?u)\b\w+\b", lowercase=True)),
            ("char", HashingVectorizer(analyzer="char_wb", ngram_range=tuple(cfg["char_ngrams"]), n_features=2**21,
                                       alternate_sign=False, norm=None, dtype=np.float32, lowercase=False)),
        ])
        self.tfidf = TfidfTransformer(sublinear_tf=True)

    def _clip(self, texts):
        return [t[: self.max_chars] for t in texts]

    def fit_transform(self, texts):
        return self.tfidf.fit_transform(self.union.transform(self._clip(texts)))

    def transform(self, texts):
        return self.tfidf.transform(self.union.transform(self._clip(texts)))
