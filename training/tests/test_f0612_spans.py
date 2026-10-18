import sys
import unicodedata
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from f0612_spans import (SpanMetrics, clip_spans, nfc_with_map, parse_spans, predict_spans, project_spans,  # noqa: E402
                         token_labels, unit_bounds)


def ws_offsets(text):
    """whitespace tokenizer offsets (stand-in for a HF offset_mapping)."""
    out, i = [], 0
    for tok in text.split():
        s = text.index(tok, i)
        out.append((s, s + len(tok)))
        i = s + len(tok)
    return out


def test_nfc_map_decomposed_accents():
    orig = "café y ñandú aquí"  # decomposed é, ñ, ú
    nfc, src = nfc_with_map(orig)
    assert nfc == unicodedata.normalize("NFC", orig)
    span = [orig.index("ñ"), orig.index("aquí")]  # "ñandú "
    (a, b), = project_spans([span], src)
    assert nfc[a:b] == "ñandú "


def test_nfc_identity_and_zero_width_preserved():
    orig = "texto​con zero‍width y homoglifo а"
    nfc, src = nfc_with_map(orig)
    assert nfc == orig and list(src) == list(range(len(orig) + 1))


def test_parse_spans_formats():
    assert parse_spans("[[5, 9], [0, 3]]") == [[0, 3], [5, 9]]
    assert parse_spans([{"start": 2, "end": 4}, {"start": 3, "end": 8}]) == [[2, 8]]
    assert parse_spans(None) == []


def test_unit_bounds_and_clip():
    p1 = "Primer párrafo. " * 20
    p2 = "Segundo párrafo con “comillas” y ñ. " * 20
    text = p1 + "\n\n" + p2
    b = unit_bounds(text, max_chars=1800, min_chars=100)
    assert len(b) == 2 and text[b[1][0]:b[1][1]].startswith("Segundo")
    sp = [[len(p1) + 2 + 8, len(p1) + 2 + 16]]
    assert clip_spans(sp, *b[1]) == [[8, 16]]


def test_token_labels_binary_bio():
    text = "uno dos tres cuatro cinco"
    offs = [(0, 0)] + ws_offsets(text) + [(0, 0)]
    spans = [[text.index("dos"), text.index("cuatro") - 1]]
    assert list(token_labels(offs, spans, len(text))) == [-100, 0, 1, 1, 0, 0, -100]
    assert list(token_labels(offs, spans, len(text), "bio")) == [-100, 0, 1, 2, 0, 0, -100]


def test_predict_spans_gap_min_abstain():
    text = "a b c d e f g h"
    offs = ws_offsets(text)
    prob = np.array([0.1, 0.9, 0.8, 0.2, 0.9, 0.1, 0.95, 0.1])
    sp = predict_spans(prob, offs, {"tau": 0.5, "gap": 0, "min_tokens": 2, "abstain": 0.0})
    assert [(s["startChar"], s["endChar"]) for s in sp] == [(2, 5)]
    assert predict_spans(prob, offs, {"tau": 0.5, "gap": 0, "min_tokens": 2, "abstain": 0.99}) == []


def test_metrics_exact_and_false_highlight():
    m = SpanMetrics()
    m.add(20, [[5, 10]], [{"startChar": 5, "endChar": 10}], kind="span")
    m.add(20, [], [{"startChar": 0, "endChar": 2}], kind="human")
    r = m.report()
    assert r["span_exact_f1"] == 2 * 0.5 * 1.0 / 1.5
    assert abs(r["false_highlight"]["human"]["false_highlight_rate"] - 0.1) < 1e-9
    assert r["boundary_start_mae"] == 0

def test_evaluate_smoke():
    import pandas as pd
    import f0612_train as t
    text = "uno dos tres cuatro cinco seis siete ocho"
    offs = [(0, 0)] + ws_offsets(text) + [(0, 0)]
    sp = [[text.index("tres"), text.index("cinco") - 1]]
    tl = token_labels(offs, sp, len(text))
    items = [{"ids": np.zeros(len(offs), np.int32), "offs": offs, "tl": tl, "a": 1.0, "spans": sp, "text_len": len(text)},
             {"ids": np.zeros(len(offs), np.int32), "offs": offs, "tl": token_labels(offs, [], len(text)), "a": 0.0, "spans": [], "text_len": len(text)}]
    frame = pd.DataFrame({"kind": ["SPAN", "HUMAN"], "language": ["es", "es"], "domain": ["academic", "general"], "n_spans": [1, 0],
                          "fine_label": ["MIXED", "HUMAN"], "ai_fraction_chars": [0.3, 0.0], "subset": ["span", "human_es"]})
    probs = [np.array([0, .1, .1, .9, .9, .1, .1, .1, .1, 0]), np.full(len(offs), 0.05)]
    para = np.array([2.0, -2.0])
    cfg, rep, grid = t.choose_postproc(items, frame, probs, para)
    assert rep["span_units"]["span_exact_f1"] == 1.0
    assert rep["all"]["false_highlight"]["human"]["false_highlight_rate"] == 0.0
    new, sp2 = t.perturb(text, sp, "zero_width", __import__("random").Random(0))
    assert new[sp2[0][0]:sp2[0][1]].replace("\u200b", "") == text[sp[0][0]:sp[0][1]]
