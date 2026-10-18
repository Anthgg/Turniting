"""F005 analyzer tests with a synthetic backend and synthetic artifacts (no real weights)."""

import asyncio
import json
import re
import sys
import zlib
from pathlib import Path
from types import SimpleNamespace

import httpx
import numpy as np
import pytest

from app.core.config import Settings
from app.services.analyzer import calibration as cal
from app.services.analyzer import ensemble as ens
from app.services.analyzer import service
from app.services.analyzer.artifacts import validate_artifact
from app.services.analyzer.comparison import align_paragraphs
from app.services.analyzer.manager import ModelManager, ModelUnavailableError
from app.services.analyzer.paragraphs import split_paragraphs
from app.services.analyzer.preprocessing import V2_PREPROCESSING_V1, V3_CANONICALIZED_V1
from app.services.analyzer.registry import F006, MODELS, V2, V3
from app.services.analyzer.scoring import (
    CONTEXTUAL,
    STRICT,
    aggregate_document,
    score_paragraphs,
    token_windows,
)

PARA_A = (
    "La metodología de esta investigación combina entrevistas semiestructuradas con un análisis "
    "documental de las políticas educativas regionales publicadas entre dos mil diez y dos mil veinte."
)
PARA_B = (
    "Los resultados muestran que las instituciones con mayor autonomía presupuestaria adoptaron "
    "programas de tutoría con mayor rapidez, aunque la evidencia sobre su impacto sigue siendo limitada."
)
PARA_C = (
    "En conclusión, la investigación sugiere que la coordinación entre niveles de gobierno condiciona "
    "la sostenibilidad de las reformas y que futuros estudios deberían incluir datos longitudinales."
)


class FakeBackend:
    """Deterministic stand-in: one token per word, logit depends only on the window tokens."""

    loads = 0

    def __init__(self, *args, **kwargs):
        self.loaded = False

    def load(self):
        FakeBackend.loads += 1
        self.loaded = True

    def unload(self):
        self.loaded = False

    special = (1, 2, 0)

    def encode(self, text, offsets=False):
        ids, offs, pos = [], [], 0
        for word in text.split():
            start = text.index(word, pos)
            ids.append(3 + zlib.crc32(word.lower().encode()) % 997)
            offs.append((start, start + len(word)))
            pos = start + len(word)
        return ids, (offs if offsets else None)

    def window_logits(self, windows, batch_size=16):
        return np.array(
            [((np.mean(w[1:-1]) if len(w) > 2 else 500) - 500) / 100 for w in windows],
            dtype=np.float32,
        )


def make_artifact(root: Path, spec, thresholds=None, calibration=None):
    for rel in spec.required_files:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}", encoding="utf-8")
    tok_dir = root / "backbone" if spec.kind == "v3_multitask" else root
    (tok_dir / "spm.model").write_text("x", encoding="utf-8")
    icfg = {
        "max_length": 512,
        "stride": 128,
        "max_windows_per_doc": 8,
        "aggregation": "mean",
    }
    if spec.kind == "v3_multitask":
        icfg["view"] = "canonical"
    (root / "inference_config.json").write_text(json.dumps(icfg), encoding="utf-8")
    th = thresholds or {
        "BALANCED": {"threshold": 0.5},
        "LOW_FALSE_POSITIVE": {"threshold": 0.8},
    }
    (root / "thresholds.json").write_text(json.dumps(th), encoding="utf-8")
    (root / "model_manifest.json").write_text(
        json.dumps({"variant": spec.variant}), encoding="utf-8"
    )
    if calibration:
        (root / "calibration.json").write_text(
            json.dumps({"selected": calibration}), encoding="utf-8"
        )
    return root


@pytest.fixture
def manager(tmp_path):
    v2 = make_artifact(tmp_path / "v2", MODELS[V2])
    v3 = make_artifact(tmp_path / "v3", MODELS[V3])
    profiles = tmp_path / "profiles"
    profiles.mkdir()
    settings = Settings(
        AI_MODEL_V2_PATH=str(v2),
        AI_MODEL_V3_PATH=str(v3),
        AI_ANALYZER_PROFILES_DIR=str(profiles),
        MIN_PARAGRAPH_CHARS=40,
        MIN_PARAGRAPH_WORDS=8,
        MIN_PARAGRAPH_TOKENS=8,
    )
    return ModelManager(settings, backend_factory=lambda spec, root, s: FakeBackend())


def test_missing_artifacts_are_unavailable_not_errors(tmp_path):
    m = ModelManager(
        Settings(AI_ANALYZER_PROFILES_DIR=str(tmp_path)),
        backend_factory=lambda *a: FakeBackend(),
    )
    assert m.status(V2)["state"] == "UNAVAILABLE"
    assert m.status(V3)["artifactPresent"] is False
    experimental = m.status(F006)
    assert experimental["status"] == "EXPERIMENTAL"
    assert experimental["state"] == "UNAVAILABLE"
    assert experimental["artifactPresent"] is False
    assert experimental["servable"] is False
    assert "calibration.json" in experimental["missing"]
    with pytest.raises(ModelUnavailableError):
        m.predict(V3, "texto de prueba")
    with pytest.raises(ModelUnavailableError):
        m.predict(F006, "texto sintético de prueba")


def test_manifest_validation_reports_missing_and_invalid(tmp_path):
    spec = MODELS[V3]
    root = make_artifact(tmp_path / "v3", spec)
    assert validate_artifact(spec, root).valid
    (root / "heads.pt").unlink()
    assert "heads.pt" in validate_artifact(spec, root).missing
    (root / "heads.pt").write_text("x")
    (root / "inference_config.json").write_text(json.dumps({"max_length": 512}))
    check = validate_artifact(spec, root)
    assert not check.valid and any("view" in p for p in check.problems)


def test_preprocessing_profiles_are_distinct():
    attacked = "Th​is essаy"  # zero-width space + Cyrillic 'а' in a Latin word
    assert V3_CANONICALIZED_V1.apply(attacked) == "This essay"
    assert (
        V3_CANONICALIZED_V1.apply("Привет мир") == "Привет мир"
    )  # genuine Cyrillic untouched
    assert V2_PREPROCESSING_V1.apply(attacked) == attacked
    assert V3_CANONICALIZED_V1.describe()["max_length"] == 512


def test_calibrators_and_threshold_profiles(manager, tmp_path):
    assert cal.Calibrator.from_dict(
        {"method": "temperature", "params": {"temperature": 2.0}}
    ).predict([2.0])[0] == pytest.approx(cal.sigmoid(1.0))
    iso = cal.Calibrator.from_dict(
        {"method": "isotonic", "params": {"x": [0.0, 1.0], "y": [0.1, 0.9]}}
    )
    assert iso.predict([0.0])[0] == pytest.approx(0.5)
    th, source = manager.thresholds(V3)
    assert th["BALANCED"] == 0.5 and source == "model-thresholds.json"
    (Path(manager.settings.ai_analyzer_profiles_dir) / f"{V3}.json").write_text(
        json.dumps(
            {
                "calibration": {"method": "platt", "params": {"a": 1.0, "b": 0.0}},
                "calibrationVersion": "f005-test",
                "thresholds": {
                    "BALANCED": 0.6,
                    "LOW_FALSE_POSITIVE": 0.85,
                    "VERY_LOW_FALSE_POSITIVE": 0.95,
                },
            }
        )
    )
    manager.discover()
    th, source = manager.thresholds(V3)
    assert th["VERY_LOW_FALSE_POSITIVE"] == 0.95 and source == "f005-test"
    with pytest.raises(ValueError):
        manager.resolve_threshold(V3, "CUSTOM", None)
    assert manager.resolve_threshold(V3, "CUSTOM", 0.7)[0] == 0.7


def test_predict_output_contract(manager):
    out = manager.predict(V3, " ".join([PARA_A, PARA_B]), "LOW_FALSE_POSITIVE")
    for key in (
        "model",
        "modelVersion",
        "rawProbability",
        "thresholdProfile",
        "threshold",
        "classification",
        "confidence",
        "windows",
        "preprocessingVersion",
        "inferenceMs",
    ):
        assert key in out
    assert (
        out["threshold"] == 0.8 and out["preprocessingVersion"] == "V3_CANONICALIZED_V1"
    )
    assert not re.search(r"turnitin(?!g)", json.dumps(out).lower())


def test_memory_lifecycle_keeps_one_resident_model(manager):
    manager.predict(V2, PARA_A)
    assert list(manager.resident) == [V2]
    manager.predict(V3, PARA_A)
    assert list(manager.resident) == [V3]
    assert (
        manager.status(V2)["state"] == "AVAILABLE"
        and manager.status(V3)["state"] == "READY"
    )
    manager.unload(V3)
    assert not manager.resident


def test_paragraph_splitting_offsets_pages_and_formats():
    text = f"{PARA_A}\n\n{PARA_B}\f\n{PARA_C}\n"
    paras = split_paragraphs(text)
    assert [p.page_number for p in paras] == [1, 1, 2]
    for p in paras:
        assert " ".join(text[p.char_start : p.char_end].split()) == p.text
    wrapped = "Este es un párrafo largo de un PDF que fue\ncortado en varias líneas por la extracción\ndel texto original.\nNuevo párrafo que empieza aquí con mayúscula y\ncontinúa en otra línea del documento."
    assert len(split_paragraphs(wrapped)) == 2
    docx = "Título\nIntroducción\nPrimer párrafo del documento con varias palabras."
    assert len(split_paragraphs(docx)) == 3


def _scores(text, mode):
    paras = split_paragraphs(text)
    res = score_paragraphs(
        FakeBackend(), paras, [V3_CANONICALIZED_V1], mode, 384, 8, 40, 8, 8
    )
    return [r.logit for r in res]


def test_paragraph_local_scoring_isolates_edits():
    base = f"{PARA_A}\n\n{PARA_B}\n\n{PARA_C}\n\n{PARA_A} {PARA_C}"
    edited = base.replace(
        "evidencia sobre su impacto", "literatura reciente sobre sus efectos"
    )
    s0, s1 = _scores(base, STRICT), _scores(edited, STRICT)
    assert [a == b for a, b in zip(s0, s1)] == [True, False, True, True]
    c0, c1 = _scores(base, CONTEXTUAL), _scores(edited, CONTEXTUAL)
    assert c0[3] == c1[3]  # two paragraphs away: untouched even with context


def test_fresh_synthetic_paragraph_inference_is_deterministic_for_five_runs(manager):
    text = f"{PARA_A}\n\n{PARA_B}\n\n{PARA_C}"
    results = [
        manager.analyze_paragraphs(V3, text, "BALANCED", None, STRICT)
        for _ in range(5)
    ]
    scores = [result["documentScore"] for result in results]
    assert all(result["paragraphMode"] == "STRICT_PARAGRAPH" for result in results)
    assert max(scores) - min(scores) == 0
    assert all(result["segments"] == results[0]["segments"] for result in results)


def test_fresh_synthetic_ensemble_is_deterministic_for_five_runs(manager):
    text = f"{PARA_A}\n\n{PARA_B}\n\n{PARA_C}"
    profile = Path(manager.settings.ai_analyzer_profiles_dir) / "ENSEMBLE_V2_V3.json"
    profile.write_text(
        json.dumps(
            {
                "method": "weighted_logodds",
                "w2": 0.5,
                "thresholds": {"BALANCED": 0.59},
                "documentAggregation": "token_weighted_mean",
            }
        ),
        encoding="utf-8",
    )

    results = [
        service.analyze(manager, text, "ENSEMBLE", "BALANCED", None, STRICT)
        for _ in range(5)
    ]
    scores = [result["documentScore"] for result in results]
    assert max(scores) - min(scores) == 0
    assert results[0]["ensembleWeights"] == {"V2": 0.5, "V3": 0.5}
    assert all(result["paragraphMode"] == "STRICT_PARAGRAPH" for result in results)
    assert all(result["segments"] == results[0]["segments"] for result in results)


def test_paragraph_mode_request_defaults_to_strict():
    from app.schemas.analyzer import ParagraphAnalysisRequest

    assert ParagraphAnalysisRequest(text=PARA_A).paragraphMode == "STRICT_PARAGRAPH"


def test_transformer_backend_uses_eval_and_inference_mode_for_stable_windows(monkeypatch):
    torch = pytest.importorskip("torch")
    from app.services.analyzer.backends import TransformerBackend

    class FakeTokenizer:
        cls_token_id = 1
        sep_token_id = 2
        pad_token_id = 0

    class FakeTokenizerLoader:
        @staticmethod
        def from_pretrained(_path):
            return FakeTokenizer()

    class FakeModel:
        evaluated = False

        def to(self, _device):
            return self

        def eval(self):
            self.evaluated = True
            return self

        def parameters(self):
            return []

    fake_model = FakeModel()
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(AutoTokenizer=FakeTokenizerLoader),
    )
    backend = TransformerBackend(Path("synthetic"), "cpu", 1)
    backend._load_model = lambda: fake_model
    original_threads = torch.get_num_threads()
    try:
        backend.load()
        assert fake_model.evaluated
        inference_flags = []

        def forward(ids, _mask):
            inference_flags.append(torch.is_inference_mode_enabled())
            return ids[:, 1].float()

        backend._forward = forward
        windows = [[1, 11, 2], [1, 17, 2], [1, 23, 2]]
        outputs = [backend.window_logits(windows).tolist() for _ in range(5)]
        assert all(inference_flags)
        assert all(output == outputs[0] for output in outputs)
        assert outputs[0] == [11.0, 17.0, 23.0]
    finally:
        torch.set_num_threads(original_threads)


def test_short_paragraphs_are_insufficient(manager):
    out = manager.analyze_paragraphs(V3, f"Capítulo 1\n\n{PARA_A}\n\n{PARA_B}")
    assert out["segments"][0]["classification"] == "INSUFFICIENT_TEXT"
    assert out["segments"][0]["calibratedScore"] is None
    assert out["insufficientParagraphs"] == 1 and out["scoredParagraphs"] == 2
    scored = [segment for segment in out["segments"] if segment["rawScore"] is not None]
    expected_raw = aggregate_document(
        [segment["rawScore"] for segment in scored],
        [segment["tokens"] for segment in scored],
        out["documentAggregation"],
        out["threshold"],
    )
    assert out["rawDocumentScore"] == pytest.approx(expected_raw)


def test_document_aggregation_methods():
    probs, toks = [0.1, 0.9, 0.5], [100, 50, 50]
    assert aggregate_document(probs, toks, "mean", 0.5) == pytest.approx(0.5)
    assert aggregate_document(probs, toks, "token_weighted_mean", 0.5) == pytest.approx(
        0.4
    )
    assert aggregate_document(
        probs, toks, "portion_above_threshold", 0.5
    ) == pytest.approx(0.5)
    assert aggregate_document([], [], "mean", 0.5) is None
    assert len(token_windows(list(range(1000)), 512, 128, None)) == 3


def test_ensemble_rules():
    assert ens.weighted_probability([0.2], [0.8], 0.5)[0] == pytest.approx(0.5)
    assert ens.weighted_logodds([0.5], [0.5], 0.3)[0] == pytest.approx(0.5)
    assert ens.agreement(0.9, 0.9, 0.5, 0.5) == ens.HIGH_CONFIDENCE
    assert ens.agreement(0.1, 0.9, 0.5, 0.5) == ens.REVIEW
    assert ens.agreement(0.1, 0.2, 0.5, 0.5) == ens.LOW_SIGNAL


def test_ensemble_requires_validation_profile(manager):
    with pytest.raises(ModelUnavailableError):
        service.analyze(manager, PARA_A, "ENSEMBLE", "BALANCED", None, CONTEXTUAL)
    (
        Path(manager.settings.ai_analyzer_profiles_dir) / "ENSEMBLE_V2_V3.json"
    ).write_text(
        json.dumps(
            {"method": "weighted_logodds", "w2": 0.4, "thresholds": {"BALANCED": 0.5}}
        )
    )
    out = service.analyze(
        manager, f"{PARA_A}\n\n{PARA_B}", "ENSEMBLE", "BALANCED", None, CONTEXTUAL
    )
    assert out["ensembleWeights"] == {"V2": 0.4, "V3": 0.6}
    assert out["segments"][0]["agreement"] in (
        ens.HIGH_CONFIDENCE,
        ens.REVIEW,
        ens.LOW_SIGNAL,
    )


def test_version_alignment_and_comparison(manager):
    base = f"{PARA_A}\n\n{PARA_B}\n\n{PARA_C}"
    target = f"{PARA_A}\n\n{PARA_B.replace('limitada', 'escasa')}\n\nUn párrafo completamente nuevo que agrega una sección distinta sobre financiamiento y gobernanza universitaria regional."
    statuses = [
        a.status
        for a in align_paragraphs(split_paragraphs(base), split_paragraphs(target))
    ]
    assert statuses.count("UNCHANGED") == 1 and statuses.count("MODIFIED") == 1
    assert "ADDED" in statuses and "REMOVED" in statuses
    out = service.compare_versions(
        manager, base, base, "V3_ONLY", "BALANCED", None, CONTEXTUAL
    )
    assert out["counts"]["UNCHANGED"] == 3 and out["unchangedDrift"]["max"] == 0.0


def test_api_models_and_unavailable_predict(tmp_path, monkeypatch):
    from app.main import app
    from app.services.analyzer import manager as mgr

    monkeypatch.setattr(
        mgr,
        "_manager",
        ModelManager(
            Settings(AI_ANALYZER_PROFILES_DIR=str(tmp_path)),
            backend_factory=lambda *a: FakeBackend(),
        ),
    )

    async def go():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://t"
        ) as c:
            models = await c.get("/models")
            pred = await c.post(f"/models/{V3}/predict", json={"text": PARA_A})
            bad = await c.post("/models/OTHER/predict", json={"text": PARA_A})
            health = await c.get("/health")
            return models, pred, bad, health

    models, pred, bad, health = asyncio.run(go())
    assert health.status_code == 200
    assert {m["model"]: m["state"] for m in models.json()["models"]}[
        V3
    ] == "UNAVAILABLE"
    assert (
        pred.status_code == 503 and pred.json()["detail"]["code"] == "MODEL_UNAVAILABLE"
    )
    assert bad.status_code == 422
    f006 = next(m for m in models.json()["models"] if m["model"] == F006)
    assert f006["status"] == "EXPERIMENTAL"
    assert f006["state"] == "UNAVAILABLE"
    assert f006["servable"] is False
    assert "Spanish human false-positive rate is elevated." in f006["warnings"]
