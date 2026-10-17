"""Document windows, paragraph-local scoring and document aggregation.

Backends expose encode(text, offsets) -> (ids, offsets), special -> (cls, sep, pad) and
window_logits(list[list[int]]) -> np.ndarray of MACHINE_SIGNAL log-odds.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.services.analyzer.calibration import logit, sigmoid
from app.services.analyzer.paragraphs import Paragraph
from app.services.analyzer.preprocessing import PreprocessingProfile

STRICT, CONTEXTUAL = "STRICT_PARAGRAPH", "CONTEXTUAL_PARAGRAPH"
AGGREGATIONS = (
    "mean",
    "token_weighted_mean",
    "trimmed_mean",
    "logodds_mean",
    "portion_above_threshold",
    "span_weighted",
)


def token_windows(
    ids: list[int], max_length: int, stride: int, max_windows: int | None
):
    """[(token_start, token_end)] covering ids with `stride` tokens of overlap."""
    content = max_length - 2
    if not ids:
        return [(0, 0)]
    step = max(1, content - stride)
    spans, start = [], 0
    while True:
        end = min(start + content, len(ids))
        spans.append((start, end))
        if end >= len(ids) or (max_windows and len(spans) >= max_windows):
            break
        start += step
    return spans


def aggregate_windows(
    values: np.ndarray, method: str, k: int = 2, trim: float = 0.2
) -> float:
    if len(values) == 1 or method == "mean":
        return float(values.mean())
    if method == "max":
        return float(values.max())
    if method == "topk_mean":
        return float(np.sort(values)[-k:].mean())
    if method == "trimmed_mean":
        s = np.sort(values)
        cut = int(len(s) * trim)
        s = s[cut : len(s) - cut] if len(s) - 2 * cut > 0 else s
        return float(s.mean())
    raise ValueError(f"unknown window aggregation {method}")


@dataclass
class DocumentScore:
    logit: float
    windows: list[dict] = field(default_factory=list)


def score_document(
    backend, text: str, profiles: list[PreprocessingProfile], aggregation: str
) -> DocumentScore:
    """Window-level document score, averaged in log-odds over the model's inference views."""
    cls, sep, _ = backend.special
    view_logits, details = [], []
    for profile in profiles:
        view = profile.apply(text)
        ids, offsets = backend.encode(view, offsets=True)
        spans = token_windows(
            ids, profile.max_length, profile.stride, profile.max_windows
        )
        windows = [[cls] + ids[s:e] + [sep] for s, e in spans]
        logits = backend.window_logits(windows)
        view_logits.append(aggregate_windows(logits, aggregation))
        if not details:  # report window positions in the first view
            for (s, e), lg in zip(spans, logits):
                cs = offsets[s][0] if offsets and s < len(offsets) else 0
                ce = offsets[e - 1][1] if offsets and e else 0
                details.append(
                    {
                        "tokenStart": s,
                        "tokenEnd": e,
                        "charStart": int(cs),
                        "charEnd": int(ce),
                        "viewProfile": profile.name,
                        "logit": float(lg),
                    }
                )
    return DocumentScore(logit=float(np.mean(view_logits)), windows=details)


@dataclass
class ParagraphScore:
    paragraph: Paragraph
    logit: float | None
    tokens: int
    insufficient: bool
    chunks: int = 0


def score_paragraphs(
    backend,
    paragraphs: list[Paragraph],
    profiles: list[PreprocessingProfile],
    mode: str,
    target_tokens: int,
    context_tokens: int,
    min_chars: int,
    min_words: int,
    min_tokens: int,
) -> list[ParagraphScore]:
    """Each paragraph is scored on its own tokens (+ a small neighbour context in
    CONTEXTUAL mode), so editing one paragraph cannot move distant ones."""
    cls, sep, _ = backend.special
    per_view: list[list[float | None]] = []
    token_counts: list[int] = []
    chunk_counts: list[int] = []
    for v, profile in enumerate(profiles):
        encoded = [backend.encode(profile.apply(p.text))[0] for p in paragraphs]
        if v == 0:
            token_counts = [len(ids) for ids in encoded]
        budget = profile.max_length - 2
        target = min(
            target_tokens, budget if mode == STRICT else budget - 2 * context_tokens
        )
        windows, owners, weights = [], [], []
        for i, (p, ids) in enumerate(zip(paragraphs, encoded)):
            if len(p.text) < min_chars or p.words < min_words or len(ids) < min_tokens:
                continue
            prev = (
                encoded[i - 1][-context_tokens:]
                if mode == CONTEXTUAL and i > 0 and context_tokens
                else []
            )
            nxt = (
                encoded[i + 1][:context_tokens]
                if mode == CONTEXTUAL and i + 1 < len(paragraphs) and context_tokens
                else []
            )
            for s in range(0, len(ids), target):
                chunk = ids[s : s + target]
                if (
                    s and len(chunk) < min_tokens
                ):  # fold a tiny tail into the previous chunk's weight
                    weights[-1] += len(chunk)
                    continue
                windows.append([cls] + prev + chunk + nxt + [sep])
                owners.append(i)
                weights.append(len(chunk))
        logits = backend.window_logits(windows) if windows else np.zeros(0)
        scores: list[float | None] = [None] * len(paragraphs)
        counts = [0] * len(paragraphs)
        for i in set(owners):
            sel = [k for k, o in enumerate(owners) if o == i]
            w = np.array([weights[k] for k in sel], dtype=np.float64)
            scores[i] = float(np.average(logits[sel], weights=w))
            counts[i] = len(sel)
        per_view.append(scores)
        if v == 0:
            chunk_counts = counts
    out = []
    for i, p in enumerate(paragraphs):
        vals = [view[i] for view in per_view if view[i] is not None]
        lg = float(np.mean(vals)) if vals else None
        out.append(
            ParagraphScore(
                paragraph=p,
                logit=lg,
                tokens=token_counts[i] if token_counts else 0,
                insufficient=lg is None,
                chunks=chunk_counts[i] if chunk_counts else 0,
            )
        )
    return out


def aggregate_document(
    probs: list[float], tokens: list[int], method: str, threshold: float
) -> float | None:
    """Document AI-signal score from paragraph probabilities (scored paragraphs only)."""
    if not probs:
        return None
    p = np.asarray(probs, dtype=np.float64)
    w = np.asarray(tokens, dtype=np.float64).clip(min=1)
    if method == "mean":
        return float(p.mean())
    if method == "token_weighted_mean":
        return float(np.average(p, weights=w))
    if method == "trimmed_mean":
        s = np.sort(p)
        cut = int(len(s) * 0.1)
        s = s[cut : len(s) - cut] if len(s) - 2 * cut > 0 else s
        return float(s.mean())
    if method == "logodds_mean":
        return float(sigmoid(np.average(logit(p), weights=w)))
    if method == "portion_above_threshold":
        return float(w[p >= threshold].sum() / w.sum())
    if method == "span_weighted":
        # expected share of AI-signal text: token-weighted mean of the calibrated probabilities
        # restricted to paragraphs above the threshold, scaled by their token share
        hi = p >= threshold
        return float((w[hi] * p[hi]).sum() / w.sum())
    raise ValueError(f"unknown document aggregation {method}")
