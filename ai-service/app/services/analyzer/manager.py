"""ModelManager: lazy, memory-bounded loading and sequential inference of the analyzer models.

States: UNAVAILABLE (no/invalid artifact) -> AVAILABLE -> LOADING -> READY, or ERROR.
At most MODEL_MAX_RESIDENT models stay in memory (least recently used is unloaded) and at
most MODEL_MAX_JOBS inferences run at once (default 1: a simple queue), so two requests can
never load two transformers at the same time on a small machine. No text is logged.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from app.core.config import Settings, get_settings
from app.services.analyzer import calibration as cal
from app.services.analyzer.artifacts import ArtifactCheck, validate_artifact
from app.services.analyzer.backends import BACKENDS
from app.services.analyzer.paragraphs import split_paragraphs
from app.services.analyzer.preprocessing import PROFILES, profile_for_view
from app.services.analyzer.registry import MODELS, V2, V3, ModelSpec, artifact_path
from app.services.analyzer.scoring import (
    STRICT,
    aggregate_document,
    score_document,
    score_paragraphs,
)

logger = logging.getLogger(__name__)
SERVABLE = (V2, V3)
UNAVAILABLE, AVAILABLE, LOADING, READY, ERROR = (
    "UNAVAILABLE",
    "AVAILABLE",
    "LOADING",
    "READY",
    "ERROR",
)
DEFAULT_DOC_AGGREGATION = "token_weighted_mean"


class ModelUnavailableError(RuntimeError):
    pass


class AnalyzerBusyError(RuntimeError):
    pass


@dataclass
class ModelState:
    spec: ModelSpec
    state: str = UNAVAILABLE
    check: ArtifactCheck | None = None
    backend: object | None = None
    error: str | None = None
    loaded_at: float | None = None
    load_ms: int | None = None
    analyzer_profile: dict = field(default_factory=dict)


class ModelManager:
    def __init__(self, settings: Settings | None = None, backend_factory=None):
        self.settings = settings or get_settings()
        self.backend_factory = backend_factory or (
            lambda spec, root, s: BACKENDS[spec.kind](
                root, s.ai_model_device, s.ai_model_cpu_threads
            )
        )
        self.states: dict[str, ModelState] = {
            name: ModelState(MODELS[name]) for name in MODELS
        }
        self.resident: OrderedDict[str, None] = OrderedDict()
        self.lock = threading.RLock()
        self.jobs = threading.BoundedSemaphore(self.settings.ai_model_max_jobs)
        self.discover()

    # ------------------------------------------------------------------ discovery / status
    def discover(self) -> None:
        with self.lock:
            for name, st in self.states.items():
                if st.state in (READY, LOADING):
                    continue
                st.check = validate_artifact(
                    st.spec, artifact_path(st.spec, self.settings)
                )
                if name not in SERVABLE:
                    st.state = AVAILABLE if st.check.valid else UNAVAILABLE
                    continue
                if not st.check.present or st.check.missing:
                    st.state, st.error = UNAVAILABLE, None
                elif not st.check.valid:
                    st.state, st.error = ERROR, "; ".join(st.check.problems)
                else:
                    st.state, st.error = AVAILABLE, None
                st.analyzer_profile = self._analyzer_profile(name)

    def _analyzer_profile(self, name: str) -> dict:
        path = Path(self.settings.ai_analyzer_profiles_dir) / f"{name}.json"
        if path.is_file():
            try:
                with open(path, encoding="utf-8") as handle:
                    data = json.load(handle)
                if isinstance(data, dict):
                    return data
            except (OSError, ValueError):
                logger.warning("analyzer profile for %s is unreadable", name)
        return {}

    def calibrator(self, name: str) -> tuple[cal.Calibrator, str]:
        st = self.states[name]
        prof = st.analyzer_profile
        if prof.get("calibration"):
            return cal.Calibrator.from_dict(prof["calibration"]), prof.get(
                "calibrationVersion", "analyzer-profile"
            )
        model_cal = (st.check.calibration or {}).get("selected") if st.check else None
        return cal.Calibrator.from_dict(model_cal), (
            "model-calibration.json" if model_cal else "raw"
        )

    def thresholds(self, name: str) -> tuple[dict[str, float], str]:
        st = self.states[name]
        prof = st.analyzer_profile
        if prof.get("thresholds"):
            return {k: float(v) for k, v in prof["thresholds"].items()}, prof.get(
                "calibrationVersion", "analyzer-profile"
            )
        model_th = cal.thresholds_from_model(st.check.thresholds if st.check else {})
        return model_th, "model-thresholds.json"

    def status(self, name: str) -> dict:
        st = self.states[name]
        thresholds, th_source = (
            self.thresholds(name) if st.check and st.check.valid else ({}, None)
        )
        return {
            "model": name,
            "registered": True,
            "status": st.spec.status,
            "state": st.state,
            "artifactPresent": bool(st.check and st.check.present),
            "artifactValid": bool(st.check and st.check.valid),
            "missing": list(st.check.missing) if st.check else [],
            "error": st.error,
            "architecture": st.spec.architecture,
            "variant": st.spec.variant,
            "modelVersion": (
                st.check.manifest.get("variant") if st.check else None
            )
            or st.spec.variant,
            "dataset": st.spec.dataset,
            "artifactProvider": st.spec.artifact_provider,
            "preprocessing": self._preprocessing_names(name),
            "thresholdProfiles": sorted(thresholds),
            "thresholdSource": th_source,
            "approxMemoryMb": st.spec.approx_memory_mb,
            "loadMs": st.load_ms,
            "servable": name in SERVABLE,
            "warnings": list(st.spec.warnings),
        }

    def _preprocessing_names(self, name: str) -> list[str]:
        st = self.states[name]
        if st.spec.kind == "v3_multitask" and st.check and st.check.inference_config:
            return [
                p.name
                for p in profile_for_view(
                    st.check.inference_config.get("view", "canonical")
                )
            ]
        return [st.spec.preprocessing]

    def profiles(self, name: str):
        return [PROFILES[n] for n in self._preprocessing_names(name)]

    # ------------------------------------------------------------------ lifecycle
    def load(self, name: str):
        with self.lock:
            st = self.states[name]
            if name not in SERVABLE:
                raise ModelUnavailableError(f"{name} is not served by the analyzer")
            if st.state == READY:
                self.resident.move_to_end(name)
                return st.backend
            self.discover()
            if st.state not in (AVAILABLE, ERROR) or not (st.check and st.check.valid):
                raise ModelUnavailableError(f"{name} artifact is not available")
            while len(self.resident) >= self.settings.ai_model_max_resident:
                self.unload(next(iter(self.resident)))
            st.state = LOADING
            t0 = time.perf_counter()
            try:
                backend = self.backend_factory(
                    st.spec, artifact_path(st.spec, self.settings), self.settings
                )
                backend.load()
            except Exception as exc:  # noqa: BLE001 - reported as model state, never crashes the service
                st.state, st.error = ERROR, f"{type(exc).__name__}: {str(exc)[:300]}"
                logger.warning("model %s failed to load (%s)", name, type(exc).__name__)
                raise ModelUnavailableError(f"{name} failed to load") from exc
            st.backend, st.state, st.error = backend, READY, None
            st.loaded_at, st.load_ms = (
                time.time(),
                int((time.perf_counter() - t0) * 1000),
            )
            self.resident[name] = None
            logger.info("model %s ready in %d ms", name, st.load_ms)
            return backend

    def unload(self, name: str) -> None:
        with self.lock:
            st = self.states[name]
            if st.backend is not None:
                st.backend.unload()
            st.backend = None
            self.resident.pop(name, None)
            if st.state == READY:
                st.state = AVAILABLE

    # ------------------------------------------------------------------ inference
    def _job(self):
        manager = self

        class _Job:
            def __enter__(self):
                if not manager.jobs.acquire(timeout=600):
                    raise AnalyzerBusyError("analyzer queue timeout")

            def __exit__(self, *exc):
                manager.jobs.release()

        return _Job()

    def resolve_threshold(
        self, name: str, profile: str, custom: float | None
    ) -> tuple[float, str]:
        st = self.states[name]
        if st.state not in (READY, LOADING):
            self.discover()
        if name not in SERVABLE or not (st.check and st.check.valid):
            raise ModelUnavailableError(f"{name} artifact is not available")
        if profile == "CUSTOM":
            if custom is None or not 0 < custom < 1:
                raise ValueError("CUSTOM profile needs 0 < customThreshold < 1")
            return float(custom), "request"
        thresholds, source = self.thresholds(name)
        if profile not in thresholds:
            raise ValueError(f"threshold profile {profile} is not available for {name}")
        return thresholds[profile], source

    def predict(
        self,
        name: str,
        text: str,
        profile: str = "BALANCED",
        custom: float | None = None,
    ) -> dict:
        threshold, th_source = self.resolve_threshold(name, profile, custom)
        with self._job():
            backend = self.load(name)
            st = self.states[name]
            t0 = time.perf_counter()
            icfg = st.check.inference_config
            doc = score_document(
                backend, text, self.profiles(name), icfg.get("aggregation", "mean")
            )
            ms = int((time.perf_counter() - t0) * 1000)
        calibrator, cal_source = self.calibrator(name)
        p_cal = float(calibrator.predict([doc.logit])[0])
        return {
            "model": name,
            "modelVersion": st.check.manifest.get("variant") or st.spec.variant,
            "rawProbability": float(cal.sigmoid(doc.logit)),
            "calibratedProbability": p_cal,
            "calibration": calibrator.method,
            "calibrationSource": cal_source,
            "thresholdProfile": profile,
            "threshold": threshold,
            "thresholdSource": th_source,
            "classification": "MACHINE_SIGNAL" if p_cal >= threshold else "LOW_SIGNAL",
            "signalLevel": cal.signal_level(p_cal),
            "confidence": cal.confidence(p_cal, threshold),
            "windows": [
                {**w, "probability": float(cal.sigmoid(w["logit"]))}
                for w in doc.windows
            ],
            "preprocessingVersion": "+".join(self._preprocessing_names(name)),
            "inferenceMs": ms,
        }

    def analyze_paragraphs(
        self,
        name: str,
        text: str,
        profile: str = "BALANCED",
        custom: float | None = None,
        mode: str = STRICT,
    ) -> dict:
        threshold, th_source = self.resolve_threshold(name, profile, custom)
        s = self.settings
        paragraphs = split_paragraphs(text)
        with self._job():
            backend = self.load(name)
            t0 = time.perf_counter()
            scores = score_paragraphs(
                backend,
                paragraphs,
                self.profiles(name),
                mode,
                s.paragraph_target_tokens,
                s.paragraph_context_tokens,
                s.min_paragraph_chars,
                s.min_paragraph_words,
                s.min_paragraph_tokens,
            )
            ms = int((time.perf_counter() - t0) * 1000)
        calibrator, cal_source = self.calibrator(name)
        st = self.states[name]
        agg = st.analyzer_profile.get("documentAggregation", DEFAULT_DOC_AGGREGATION)
        segs, probs, raw_probs, toks = [], [], [], []
        for sc in scores:
            p = sc.paragraph
            seg = {
                "paragraphIndex": p.index,
                "charStart": p.char_start,
                "charEnd": p.char_end,
                "pageNumber": p.page_number,
                "textHash": p.text_hash,
                "words": p.words,
                "tokens": sc.tokens,
            }
            if sc.insufficient:
                seg.update(
                    rawScore=None,
                    calibratedScore=None,
                    classification="INSUFFICIENT_TEXT",
                    signalLevel=None,
                    confidence=None,
                )
            else:
                pc = float(calibrator.predict([sc.logit])[0])
                seg.update(
                    rawScore=float(cal.sigmoid(sc.logit)),
                    calibratedScore=pc,
                    classification="MACHINE_SIGNAL"
                    if pc >= threshold
                    else "LOW_SIGNAL",
                    signalLevel=cal.signal_level(pc),
                    confidence=cal.confidence(pc, threshold),
                )
                probs.append(pc)
                raw_probs.append(float(cal.sigmoid(sc.logit)))
                toks.append(sc.tokens)
            segs.append(seg)
        doc_score = aggregate_document(probs, toks, agg, threshold)
        return {
            "model": name,
            "modelVersion": st.check.manifest.get("variant") or st.spec.variant,
            "paragraphMode": mode,
            "thresholdProfile": profile,
            "threshold": threshold,
            "thresholdSource": th_source,
            "calibration": calibrator.method,
            "calibrationSource": cal_source,
            "documentAggregation": agg,
            "documentScore": doc_score,
            "rawDocumentScore": aggregate_document(raw_probs, toks, agg, threshold),
            "documentClassification": (
                None
                if doc_score is None
                else "MACHINE_SIGNAL"
                if doc_score >= threshold
                else "LOW_SIGNAL"
            ),
            "documentSignalLevel": None
            if doc_score is None
            else cal.signal_level(doc_score),
            "scoredParagraphs": len(probs),
            "insufficientParagraphs": len(segs) - len(probs),
            "segments": segs,
            "preprocessingVersion": "+".join(self._preprocessing_names(name)),
            "inferenceMs": ms,
        }


_manager: ModelManager | None = None
_manager_lock = threading.Lock()


def get_manager() -> ModelManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = ModelManager()
        return _manager
