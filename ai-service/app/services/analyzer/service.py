"""Analyzer modes (V2_ONLY, V3_ONLY, ENSEMBLE) on paragraphs, and version comparison."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from app.services.analyzer import calibration as cal
from app.services.analyzer import ensemble as ens
from app.services.analyzer.comparison import align_paragraphs, document_similarity
from app.services.analyzer.manager import ModelManager, ModelUnavailableError
from app.services.analyzer.paragraphs import split_paragraphs
from app.services.analyzer.registry import F006_1, F006_1_1, V2, V3
from app.services.analyzer.scoring import CONTEXTUAL, aggregate_document

ENSEMBLE_PROFILE = "ENSEMBLE_V2_V3"
MODE_MODEL = {
    "V2_ONLY": V2,
    "V3_ONLY": V3,
    "F006_1_ONLY": F006_1,
    "F006_1_1_ONLY": F006_1_1,
}


def ensemble_profile(manager: ModelManager) -> dict:
    path = Path(manager.settings.ai_analyzer_profiles_dir) / f"{ENSEMBLE_PROFILE}.json"
    if not path.is_file():
        raise ModelUnavailableError("ENSEMBLE has no validation-selected profile yet")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def analyze(
    manager: ModelManager,
    text: str,
    analyzer: str,
    profile: str,
    custom: float | None,
    mode: str,
    language_code: str = "other",
) -> dict:
    if analyzer in MODE_MODEL:
        result = manager.analyze_paragraphs(
            MODE_MODEL[analyzer], text, profile, custom, mode, language_code
        )
        return {"analyzer": analyzer, **result}
    prof = ensemble_profile(manager)
    if profile == "CUSTOM":
        if custom is None:
            raise ValueError("CUSTOM profile needs customThreshold")
        threshold = float(custom)
    elif profile in prof.get("thresholds", {}):
        threshold = float(prof["thresholds"][profile])
    else:
        raise ValueError(f"threshold profile {profile} is not available for ENSEMBLE")
    r2 = manager.analyze_paragraphs(
        V2, text, "BALANCED", None, mode
    )  # sequential: V2, then V3
    r3 = manager.analyze_paragraphs(V3, text, "BALANCED", None, mode)
    w2, method = float(prof["w2"]), prof["method"]
    segs, probs, toks = [], [], []
    for s2, s3 in zip(r2["segments"], r3["segments"]):
        seg = {
            k: s3[k]
            for k in (
                "paragraphIndex",
                "charStart",
                "charEnd",
                "pageNumber",
                "textHash",
                "words",
                "tokens",
            )
        }
        if s2["calibratedScore"] is None or s3["calibratedScore"] is None:
            seg.update(
                rawScore=None,
                calibratedScore=None,
                classification="INSUFFICIENT_TEXT",
                signalLevel=None,
                confidence=None,
                agreement=None,
                v2Score=s2["calibratedScore"],
                v3Score=s3["calibratedScore"],
            )
        else:
            p = float(
                ens.combine(
                    method, [s2["calibratedScore"]], [s3["calibratedScore"]], w2
                )[0]
            )
            seg.update(
                rawScore=p,
                calibratedScore=p,
                classification="MACHINE_SIGNAL" if p >= threshold else "LOW_SIGNAL",
                signalLevel=cal.signal_level(p),
                confidence=cal.confidence(p, threshold),
                agreement=ens.agreement(
                    s2["calibratedScore"],
                    s3["calibratedScore"],
                    r2["threshold"],
                    r3["threshold"],
                ),
                v2Score=s2["calibratedScore"],
                v3Score=s3["calibratedScore"],
            )
            probs.append(p)
            toks.append(seg["tokens"])
        if mode == CONTEXTUAL:
            seg["contextTokensUsed"] = {
                **{
                    f"V2/{name}": usage
                    for name, usage in (s2.get("contextTokensUsed") or {}).items()
                },
                **{
                    f"V3/{name}": usage
                    for name, usage in (s3.get("contextTokensUsed") or {}).items()
                },
            }
        segs.append(seg)
    agg = prof.get("documentAggregation", r3["documentAggregation"])
    doc = aggregate_document(probs, toks, agg, threshold)
    return {
        "analyzer": "ENSEMBLE",
        "model": ENSEMBLE_PROFILE,
        "modelVersion": f"{r2['modelVersion']}+{r3['modelVersion']}",
        "ensembleMethod": method,
        "ensembleWeights": {"V2": w2, "V3": round(1 - w2, 4)},
        "paragraphMode": mode,
        "contextMetadata": {
            "tokenLimitPerSide": r3["contextMetadata"]["tokenLimitPerSide"],
            "measurement": "tokens_per_window",
            "preprocessingProfiles": [
                *(f"V2/{name}" for name in r2["contextMetadata"]["preprocessingProfiles"]),
                *(f"V3/{name}" for name in r3["contextMetadata"]["preprocessingProfiles"]),
            ],
        }
        if mode == CONTEXTUAL
        else None,
        "thresholdProfile": profile,
        "threshold": threshold,
        "thresholdSource": prof.get("calibrationVersion", "ensemble-profile"),
        "calibration": "per-model",
        "documentAggregation": agg,
        "documentScore": doc,
        "rawDocumentScore": doc,
        "documentClassification": None
        if doc is None
        else ("MACHINE_SIGNAL" if doc >= threshold else "LOW_SIGNAL"),
        "documentSignalLevel": None if doc is None else cal.signal_level(doc),
        "scoredParagraphs": len(probs),
        "insufficientParagraphs": len(segs) - len(probs),
        "segments": segs,
        "preprocessingVersion": f"{r2['preprocessingVersion']}|{r3['preprocessingVersion']}",
        "inferenceMs": r2["inferenceMs"] + r3["inferenceMs"],
    }


def compare_versions(
    manager: ModelManager,
    base_text: str,
    target_text: str,
    analyzer: str,
    profile: str,
    custom: float | None,
    mode: str,
    language_code: str = "other",
) -> dict:
    base = analyze(manager, base_text, analyzer, profile, custom, mode, language_code)
    target = analyze(manager, target_text, analyzer, profile, custom, mode, language_code)
    pa, pb = split_paragraphs(base_text), split_paragraphs(target_text)
    alignment = align_paragraphs(pa, pb)
    rows, unchanged_drift = [], []
    for al in alignment:
        sa = base["segments"][al.base_index] if al.base_index is not None else None
        sb = (
            target["segments"][al.target_index] if al.target_index is not None else None
        )
        a_score = sa["calibratedScore"] if sa else None
        b_score = sb["calibratedScore"] if sb else None
        delta = None if a_score is None or b_score is None else b_score - a_score
        if al.status == "UNCHANGED" and delta is not None:
            unchanged_drift.append(abs(delta))
        rows.append(
            {
                "status": al.status,
                "baseParagraphIndex": al.base_index,
                "targetParagraphIndex": al.target_index,
                "similarity": al.similarity,
                "match": al.match,
                "baseScore": a_score,
                "targetScore": b_score,
                "delta": delta,
            }
        )
    counts = {
        s: sum(1 for r in rows if r["status"] == s)
        for s in ("UNCHANGED", "MODIFIED", "ADDED", "REMOVED")
    }
    gd = (
        None
        if base["documentScore"] is None or target["documentScore"] is None
        else (target["documentScore"] - base["documentScore"])
    )
    drift = np.asarray(unchanged_drift) if unchanged_drift else None
    return {
        "analyzer": analyzer,
        "thresholdProfile": profile,
        "paragraphMode": mode,
        "baseDocumentScore": base["documentScore"],
        "targetDocumentScore": target["documentScore"],
        "globalScoreDelta": gd,
        "documentSimilarity": document_similarity(pa, pb),
        "counts": counts,
        "unchangedDrift": None
        if drift is None
        else {
            "mean": float(drift.mean()),
            "median": float(np.median(drift)),
            "p90": float(np.percentile(drift, 90)),
            "p95": float(np.percentile(drift, 95)),
            "max": float(drift.max()),
            "n": int(len(drift)),
        },
        "paragraphs": rows,
        "base": base,
        "target": target,
    }
