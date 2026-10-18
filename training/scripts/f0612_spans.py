"""F006.1.2 span core: normalisation with offset maps, paragraph units, char<->token labels, span post-processing
with abstention, and span metrics. Pure numpy / stdlib (the tokenizer is passed in), unit-tested in
tests/test_f0612_spans.py.

Offset policy (one policy everywhere):
* The unit text is NFC-normalised. `nfc_with_map` returns the NFC text plus, for every NFC char, the index of the
  original char it came from, so spans annotated on the original text are re-projected exactly (never re-searched).
* Nothing else is changed: whitespace, line breaks, zero-width characters and homoglyphs stay in the text; the
  tokenizer's offset_mapping refers to this exact string.
* Returned spans are [startChar, endChar) on the TARGET unit text only (no context offsets ever leave the model).
"""

from __future__ import annotations

import json
import re
import unicodedata

import numpy as np

LABELS_BINARY = ("HUMAN", "AI")
LABELS_BIO = ("O", "B-AI", "I-AI")


# ------------------------------------------------------------------ normalisation
def nfc_with_map(text: str) -> tuple[str, np.ndarray]:
    """NFC text + int array `src` with src[i] = original index of NFC char i (len(src) == len(nfc) + 1, last = len(text))."""
    if unicodedata.is_normalized("NFC", text):
        return text, np.arange(len(text) + 1)
    out, src = [], []
    i, n = 0, len(text)
    while i < n:  # cluster = starter + following combining marks
        j = i + 1
        while j < n and unicodedata.combining(text[j]):
            j += 1
        seg = unicodedata.normalize("NFC", text[i:j])
        out.append(seg)
        src.extend([i] * len(seg))
        i = j
    src.append(n)
    return "".join(out), np.asarray(src)


def project_spans(spans, src: np.ndarray) -> list[list[int]]:
    """Original-text spans -> NFC-text spans using the nfc_with_map index."""
    out = []
    for s, e in spans:
        a = int(np.searchsorted(src[:-1], s, side="left"))
        b = int(np.searchsorted(src[:-1], e, side="left"))
        if b > a:
            out.append([a, b])
    return out


def parse_spans(raw) -> list[list[int]]:
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return []
    v = json.loads(raw) if isinstance(raw, str) else raw
    out = []
    for x in v or []:
        if isinstance(x, dict):
            s, e = x.get("start", x.get("startChar")), x.get("end", x.get("endChar"))
        else:
            s, e = x[0], x[1]
        if s is not None and e is not None and int(e) > int(s):
            out.append([int(s), int(e)])
    return merge_spans(out)


def merge_spans(spans) -> list[list[int]]:
    out = []
    for s, e in sorted(spans):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


# ------------------------------------------------------------------ paragraph units
_BLOCK = re.compile(r"\n[ \t]*\n")
_SENT_END = re.compile(r"(?<=[.!?。！？])[\"'”’)\]]*\s+")


def unit_bounds(text: str, max_chars: int = 1800, min_chars: int = 200) -> list[tuple[int, int]]:
    """Paragraph-sized [s, e) windows over `text`: blank-line blocks, short blocks merged forward, long blocks cut at
    sentence ends. Leading / trailing whitespace trimmed (offsets stay on `text`)."""
    cuts, last = [], 0
    for m in _BLOCK.finditer(text):
        cuts.append((last, m.start()))
        last = m.end()
    cuts.append((last, len(text)))
    merged = []
    for s, e in cuts:
        if merged and (merged[-1][1] - merged[-1][0] < min_chars):
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    out = []
    for s, e in merged:
        while e - s > max_chars:
            ends = [m.end() for m in _SENT_END.finditer(text, s, s + max_chars)]
            cut = max([x for x in ends if x - s >= min_chars], default=s + max_chars)
            out.append((s, cut))
            s = cut
        out.append((s, e))
    res = []
    for s, e in out:
        seg = text[s:e]
        ls = len(seg) - len(seg.lstrip())
        rs = len(seg) - len(seg.rstrip())
        if e - rs > s + ls:
            res.append((s + ls, e - rs))
    return res


def clip_spans(spans, s: int, e: int) -> list[list[int]]:
    return [[max(a, s) - s, min(b, e) - s] for a, b in spans if min(b, e) > max(a, s)]


# ------------------------------------------------------------------ labels
def token_labels(offsets, spans, n_chars: int, scheme: str = "binary") -> np.ndarray:
    """Per-token labels from char spans. A token is AI when >= half of its non-space chars are inside a span.
    binary: 0/1; bio: 0=O, 1=B-AI, 2=I-AI. Special tokens (offset (0,0)) -> -100."""
    mask = np.zeros(n_chars + 1, np.int32)
    for a, b in spans:
        mask[max(0, a):min(n_chars, b)] = 1
    cum = np.concatenate([[0], np.cumsum(mask)])
    lab = np.full(len(offsets), -100, np.int64)
    prev = 0
    for i, (s, e) in enumerate(offsets):
        if e <= s:
            continue
        inside = cum[min(e, n_chars)] - cum[min(s, n_chars)]
        y = 1 if inside * 2 >= (e - s) else 0
        if scheme == "bio":
            lab[i] = 0 if y == 0 else (2 if prev == 1 else 1)
        else:
            lab[i] = y
        prev = y
    return lab


def ai_prob_from_logits(logits: np.ndarray, scheme: str) -> np.ndarray:
    """Token AI probability: sigmoid (binary) or 1 - P(O) (bio)."""
    if scheme == "bio":
        z = logits - logits.max(-1, keepdims=True)
        p = np.exp(z) / np.exp(z).sum(-1, keepdims=True)
        return 1.0 - p[..., 0]
    return 1.0 / (1.0 + np.exp(-logits))


# ------------------------------------------------------------------ post-processing
def predict_spans(prob: np.ndarray, offsets, cfg: dict, text: str | None = None) -> list[dict]:
    """token probs -> spans: threshold, merge gaps <= cfg['gap'] tokens, drop spans shorter than cfg['min_tokens'],
    abstain on spans whose mean probability < cfg['abstain']. Char offsets = first token start .. last token end."""
    tau, gap, min_tok, abst = cfg["tau"], cfg.get("gap", 0), cfg.get("min_tokens", 1), cfg.get("abstain", 0.0)
    valid = np.array([e > s for s, e in offsets])
    pos = (prob >= tau) & valid
    idx = np.flatnonzero(pos)
    spans, cur = [], None
    for i in idx:
        if cur and i - cur[1] - 1 <= gap:
            cur[1] = i
        else:
            if cur:
                spans.append(cur)
            cur = [i, i]
    if cur:
        spans.append(cur)
    out = []
    for a, b in spans:
        toks = np.arange(a, b + 1)
        toks = toks[valid[toks]]
        if len(toks) < min_tok:
            continue
        conf = float(prob[toks].mean())
        if conf < abst:
            continue
        sc, ec = int(offsets[a][0]), int(offsets[b][1])
        if text is not None:  # SentencePiece offsets carry the leading space of a word: trim to visible characters
            while sc < ec and text[sc].isspace():
                sc += 1
            while ec > sc and text[ec - 1].isspace():
                ec -= 1
        out.append({"startChar": sc, "endChar": ec, "startToken": int(a), "endToken": int(b) + 1,
                    "confidence": round(conf, 4), "label": "AI_SIGNAL"})
    return out


# ------------------------------------------------------------------ metrics
def _prf(tp, fp, fn):
    p = tp / max(tp + fp, 1)
    r = tp / max(tp + fn, 1)
    return p, r, 2 * p * r / max(p + r, 1e-9)


class SpanMetrics:
    """Accumulates token / char / span metrics over units. `kind` tags let false-highlight rates be split by
    human-only / reference / metadata / boilerplate units."""

    def __init__(self):
        self.t = np.zeros(4, np.int64)  # tp fp fn tn tokens
        self.c = np.zeros(4, np.int64)  # chars
        self.ex = np.zeros(3, np.int64)  # exact span tp, n_pred, n_gold
        self.ov = np.zeros(3, np.int64)  # overlap(IoU>=0.5) tp_pred, n_pred, tp_gold(n matched) / n_gold tracked separately
        self.n_gold = 0
        self.ious, self.smae, self.emae, self.cnt_err, self.len_err = [], [], [], [], []
        self.fh = {}  # kind -> [highlighted chars, chars, units with any span, units]
        self.units = 0

    def add(self, text_len: int, gold, pred, tok_gold=None, tok_pred=None, kind: str = "span"):
        self.units += 1
        if tok_gold is not None:
            g = tok_gold >= 1
            m = tok_gold != -100
            p = tok_pred
            self.t += [int((p & g & m).sum()), int((p & ~g & m).sum()), int((~p & g & m).sum()), int((~p & ~g & m).sum())]
        gm = np.zeros(text_len, bool)
        for a, b in gold:
            gm[a:b] = True
        pm = np.zeros(text_len, bool)
        pred = [(int(s["startChar"]), int(s["endChar"])) if isinstance(s, dict) else (int(s[0]), int(s[1])) for s in pred]
        for s in pred:
            pm[s[0]:s[1]] = True
        self.c += [int((pm & gm).sum()), int((pm & ~gm).sum()), int((~pm & gm).sum()), int((~pm & ~gm).sum())]
        u = int((pm | gm).sum())
        if gold:
            self.ious.append((pm & gm).sum() / u if u else 1.0)
        ps = list(pred)
        gs = [(a, b) for a, b in gold]
        self.ex += [len(set(ps) & set(gs)), len(ps), len(gs)]

        def iou(x, y):
            inter = max(0, min(x[1], y[1]) - max(x[0], y[0]))
            return inter / max(max(x[1], y[1]) - min(x[0], y[0]), 1)

        self.ov[0] += sum(1 for p_ in ps if any(iou(p_, g_) >= 0.5 for g_ in gs))
        self.ov[1] += len(ps)
        self.ov[2] += sum(1 for g_ in gs if any(iou(p_, g_) >= 0.5 for p_ in ps))
        self.n_gold += len(gs)
        for g_ in gs:
            cand = [p_ for p_ in ps if min(p_[1], g_[1]) > max(p_[0], g_[0])]
            if cand:
                b_ = max(cand, key=lambda p_: iou(p_, g_))
                self.smae.append(abs(b_[0] - g_[0]))
                self.emae.append(abs(b_[1] - g_[1]))
        self.cnt_err.append(abs(len(ps) - len(gs)))
        if gs and ps:
            self.len_err.append(abs(np.mean([b - a for a, b in ps]) - np.mean([b - a for a, b in gs])))
        human_chars = ~gm
        f = self.fh.setdefault(kind, [0, 0, 0, 0])
        f[0] += int((pm & human_chars).sum()); f[1] += int(human_chars.sum()); f[2] += int(bool(ps)); f[3] += 1
        if kind != "all":
            a = self.fh.setdefault("all_human_chars", [0, 0, 0, 0])
            a[0] += int((pm & human_chars).sum()); a[1] += int(human_chars.sum()); a[2] += int(bool(ps) and not gs); a[3] += int(not gs)

    def report(self) -> dict:
        tP, tR, tF = _prf(*self.t[:3])
        cP, cR, cF = _prf(*self.c[:3])
        eP = self.ex[0] / max(self.ex[1], 1)
        eR = self.ex[0] / max(self.ex[2], 1)
        oP = self.ov[0] / max(self.ov[1], 1)
        oR = self.ov[2] / max(self.n_gold, 1)
        fh = {k: {"false_highlight_rate": v[0] / max(v[1], 1), "units_with_any_span": v[2] / max(v[3], 1), "units": v[3]} for k, v in self.fh.items()}
        return {"units": self.units, "token_precision": tP, "token_recall": tR, "token_f1": tF, "token_fpr": self.t[1] / max(self.t[1] + self.t[3], 1),
                "char_precision": cP, "char_recall": cR, "char_f1": cF,
                "span_exact_precision": eP, "span_exact_recall": eR, "span_exact_f1": 2 * eP * eR / max(eP + eR, 1e-9),
                "span_overlap_precision": oP, "span_overlap_recall": oR, "span_overlap_f1": 2 * oP * oR / max(oP + oR, 1e-9),
                "iou_mean": float(np.mean(self.ious)) if self.ious else None,
                "boundary_start_mae": float(np.mean(self.smae)) if self.smae else None, "boundary_end_mae": float(np.mean(self.emae)) if self.emae else None,
                "span_count_error": float(np.mean(self.cnt_err)) if self.cnt_err else None, "span_length_error": float(np.mean(self.len_err)) if self.len_err else None,
                "gold_spans": self.n_gold, "false_highlight": fh}
