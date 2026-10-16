"""Small, fast tests for the training pipeline (no downloads, no model training)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train import adapters  # noqa: E402
from turniting_train.calibration import Calibrator, select_calibrator  # noqa: E402
from turniting_train.dedup import MinHasher, band_hashes, candidate_pairs, connected_components, estimated_jaccard  # noqa: E402
from turniting_train.metrics import binary_metrics, ece_score, select_thresholds  # noqa: E402
from turniting_train.sampling import row_weights, weighted_sample  # noqa: E402
from turniting_train.splits import (  # noqa: E402
    TEST, TRAIN, UNSEEN_DOMAIN_TEST, UNSEEN_GENERATOR_TEST, component_splits, leakage_report, row_split,
)
from turniting_train.textnorm import (  # noqa: E402
    canonical_generator, invalid_reason, normalize_label, normalize_text, normalized_text_hash,
)
from turniting_train.transformer import aggregate, make_windows  # noqa: E402


# ------------------------------------------------------------------ labels
def test_label_normalization_default_and_inverted():
    assert normalize_label("human", scheme="text") == 0
    assert normalize_label("generated") == 1
    assert normalize_label(0) == 0 and normalize_label(1) == 1
    # MAGE: 0 = machine, 1 = human
    assert normalize_label(0, scheme="human1") == 1
    assert normalize_label(1, scheme="human1") == 0
    with pytest.raises(ValueError):
        normalize_label(3)


def test_generator_families():
    assert canonical_generator("gpt-3.5-trubo")[1] == "gpt"
    assert canonical_generator("mixtral-8x7b-instruct")[1] == "mistral"
    assert canonical_generator("cohere.command-text-v14")[1] == "cohere"
    assert canonical_generator("human") == ("human", "human")


# ------------------------------------------------------------------ text validation / normalization
def test_validation_and_normalization():
    assert invalid_reason(None, min_chars=5, min_words=1) == "null"
    assert invalid_reason("   ", min_chars=5, min_words=1) == "empty_or_whitespace"
    assert invalid_reason("<div><p></p></div>", min_chars=5, min_words=1) == "broken_html"
    assert invalid_reason("Hola qué tal estás", min_chars=5, min_words=3) is None
    clean = normalize_text("a​b\r\nc\x00 ")
    assert clean == "ab\nc"
    # adversarial rows keep zero-width / whitespace attacks
    assert normalize_text("a​b  ", adversarial=True) == "a​b  "
    assert normalized_text_hash("hola   mundo") == normalized_text_hash("hola mundo​")


# ------------------------------------------------------------------ adapters
def test_m4_list_parsing():
    assert adapters._maybe_list("['a', 'b']") == ["a", "b"]
    assert adapters._maybe_list("plain") == ["plain"]


def test_mage_adapter_inverts_labels(tmp_path, monkeypatch):
    root = tmp_path / "mage"
    root.mkdir()
    pd.DataFrame({"text": ["human words here", "machine words here"], "label": [1, 0],
                  "src": ["cmv_human", "cmv_machine_specified_gpt-3.5-trubo"]}).to_csv(root / "train.csv", index=False)
    for name in ("valid.csv", "test.csv", "test_ood_set_gpt.csv", "test_ood_set_gpt_para.csv"):
        pd.DataFrame({"text": [], "label": [], "src": []}).to_csv(root / name, index=False)
    monkeypatch.setattr(adapters, "RAW_DIR", tmp_path)
    rows = list(adapters.mage())
    assert [r["label"] for r in rows] == [0, 1]
    assert rows[1]["generator_family"] == "gpt"
    assert rows[0]["domain"] == "forum"


# ------------------------------------------------------------------ dedup
def test_near_duplicates_found_without_quadratic_scan():
    base = " ".join(f"palabra{i}" for i in range(200))
    texts = [base, base.replace("palabra7 ", "palabraX ", 1), "texto completamente distinto " * 20]
    h = MinHasher(num_perm=64)
    sig = np.stack([h.signature(t) for t in texts])
    pairs = candidate_pairs(band_hashes(sig, 8), np.ones(3, bool))
    jac = estimated_jaccard(sig, pairs)
    near = pairs[jac >= 0.8]
    assert {tuple(p) for p in near} == {(0, 1)}
    comp = connected_components(3, near)
    assert comp[0] == comp[1] != comp[2]


# ------------------------------------------------------------------ splits / leakage
def _toy():
    return pd.DataFrame({
        "id": [f"r{i}" for i in range(8)],
        "group_id": ["gA", "gA", "gA", "gB", "gB", "gC", "gD", "gD"],
        "role": [None, None, None, "official_test", None, None, None, None],
        "label": [0, 1, 1, 0, 1, 1, 0, 1],
        "generator_family": ["human", "gpt", "mistral", "human", "gpt", "gpt", "human", "llama"],
        "domain": ["news", "news", "news", "academic", "academic", "reviews", "wiki", "wiki"],
        "is_mixed": [False] * 8,
        "is_adversarial": [False] * 8,
        "normalized_text_hash": [f"h{i}" for i in range(8)],
    })


def test_group_split_keeps_derived_texts_together():
    df = _toy()
    base = component_splits(df, seed=1, ratios={"train": 0.8, "validation": 0.1, "test": 0.1})
    assert base["gB"] == TEST  # official test forces the whole group
    row_base = df["group_id"].map(base)
    for g, rows in row_base.groupby(df["group_id"]):
        assert rows.nunique() == 1


def test_holdouts_and_no_leakage():
    df = _toy()
    row_base = pd.Series([TRAIN, TRAIN, TRAIN, TEST, TEST, TEST, TRAIN, TRAIN])
    split, reason = row_split(row_base, df, {"mistral"}, {"reviews"})
    assert reason[2] == "HOLDOUT_GENERATOR_IN_TRAIN_GROUP" and split[2] is None
    assert split[5] == UNSEEN_DOMAIN_TEST
    df["split"] = split
    leak = leakage_report(df)
    assert leak["groups_spanning_train_and_eval"] == 0
    assert leak["exact_hashes_spanning_train_and_eval"] == 0
    # a deliberately leaked group is detected
    df.loc[1, "split"] = TEST
    assert leakage_report(df)["groups_spanning_train_and_eval"] == 1


def test_unseen_generator_routed_to_test_side():
    df = _toy()
    row_base = pd.Series([TEST] * 8)
    split, _ = row_split(row_base, df, {"mistral"}, set())
    assert split[2] == UNSEEN_GENERATOR_TEST


# ------------------------------------------------------------------ sampling
def test_weighted_sampling_caps_giant_dataset():
    big = pd.DataFrame({"dataset": "raid", "label": np.r_[np.zeros(50000), np.ones(50000)].astype(int),
                        "language": "en", "domain": "news"})
    small = pd.DataFrame({"dataset": "iber", "label": np.r_[np.zeros(500), np.ones(500)].astype(int),
                          "language": "es", "domain": "news"})
    df = pd.concat([big, small], ignore_index=True)
    cfg = {"dataset_weights": {"raid": 1.0, "iber": 1.0}, "label_balance": 0.5, "language_weights": {"es": 2.0}}
    s = weighted_sample(df, row_weights(df, cfg), 2000, seed=0)
    share_small = (s["dataset"] == "iber").mean()
    assert share_small > 0.3  # 1 % of rows but ~2/3 of the mass
    assert abs(s["label"].mean() - 0.5) < 0.06


# ------------------------------------------------------------------ windowing
class FakeTokenizer:
    cls_token_id, sep_token_id, pad_token_id, unk_token_id = 1, 2, 0, 3

    def __call__(self, text, add_special_tokens=False, truncation=False):
        return {"input_ids": [10 + (len(w) % 50) for w in text.split()]}


def test_windowing_overlap_and_metadata():
    text = " ".join(["w"] * 1000)
    ws = make_windows(FakeTokenizer(), text, 7, max_length=512, stride=128, max_windows=None)
    assert all(len(w.input_ids) <= 512 for w in ws)
    assert ws[0].token_start == 0 and ws[1].token_start == 510 - 128
    assert ws[-1].token_end == 1000
    assert all(w.doc_index == 7 for w in ws)
    assert [w.window_index for w in ws] == list(range(len(ws)))
    capped = make_windows(FakeTokenizer(), text, 0, max_length=256, stride=64, max_windows=2)
    assert len(capped) == 2


def test_aggregation():
    wl = [np.array([1.0, -1.0, 3.0]), np.array([2.0])]
    assert np.allclose(aggregate(wl, "mean"), [1.0, 2.0])
    assert np.allclose(aggregate(wl, "max"), [3.0, 2.0])
    assert np.allclose(aggregate(wl, "topk_mean", k=2), [2.0, 2.0])


# ------------------------------------------------------------------ metrics / calibration
def test_metrics_and_thresholds():
    y = np.array([0, 0, 0, 1, 1, 1])
    p = np.array([0.1, 0.2, 0.7, 0.6, 0.8, 0.9])
    m = binary_metrics(y, p, 0.5)
    assert m["confusion"] == {"tn": 2, "fp": 1, "fn": 0, "tp": 3}
    assert abs(m["fpr"] - 1 / 3) < 1e-9 and m["recall"] == 1.0
    t = select_thresholds(y, p, max_fpr_low=0.0)
    assert t["LOW_FALSE_POSITIVE"]["fpr"] == 0.0
    e, table = ece_score(y, p, bins=5)
    assert 0 <= e <= 1 and len(table) == 5


def test_calibrator_roundtrip():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 2000)
    logits = (y * 2 - 1) * 3.0 + rng.normal(0, 2, 2000)
    cal, report = select_calibrator(logits, y, ["temperature", "platt", "isotonic"])
    restored = Calibrator.from_dict(json.loads(json.dumps(cal.to_dict())))
    assert np.allclose(restored.predict(logits[:20]), cal.predict(logits[:20]))
    assert set(report) == {"none", "temperature", "platt", "isotonic"}


# ------------------------------------------------------------------ manifests
def test_model_manifest_contract():
    path = Path(__file__).resolve().parents[1] / "models" / "transformer" / "best" / "model_manifest.json"
    if not path.exists():
        pytest.skip("model not trained on this machine")
    m = json.loads(path.read_text(encoding="utf-8"))
    for key in ("modelVersion", "architecture", "datasetVersion", "labels", "outputs", "notTurnitin"):
        assert key in m
    assert m["labels"] == {"0": "HUMAN", "1": "MACHINE"}
    assert "Turnitin AI model" not in json.dumps(m)
