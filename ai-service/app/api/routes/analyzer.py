"""F005 local AI analyzer API (internal; consumed by the backend only).

Outputs are an independent "AI signal probability", never a Turnitin score.
"""

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.schemas.analyzer import (
    CompareModelsRequest,
    CompareVersionsRequest,
    ModelName,
    ParagraphAnalysisRequest,
    PredictRequest,
)
from app.services.analyzer import service
from app.services.analyzer.manager import (
    AnalyzerBusyError,
    ModelUnavailableError,
    get_manager,
)
from app.services.analyzer.registry import MODELS

router = APIRouter(tags=["analyzer"])


def _check_size(*texts: str) -> None:
    limit = get_settings().ai_max_analysis_chars
    if any(len(t) > limit for t in texts):
        raise HTTPException(
            status_code=413, detail={"code": "TEXT_TOO_LARGE", "maxChars": limit}
        )


async def _run(fn, *args):
    try:
        return await run_in_threadpool(fn, *args)
    except ModelUnavailableError as exc:
        raise HTTPException(
            status_code=503, detail={"code": "MODEL_UNAVAILABLE", "message": str(exc)}
        ) from exc
    except AnalyzerBusyError as exc:
        raise HTTPException(
            status_code=429, detail={"code": "ANALYZER_BUSY", "message": str(exc)}
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_ANALYSIS_REQUEST", "message": str(exc)},
        ) from exc


@router.get("/models")
def list_models() -> dict:
    manager = get_manager()
    manager.discover()
    return {
        "models": [manager.status(name) for name in MODELS],
        "policy": {
            "maxResident": manager.settings.ai_model_max_resident,
            "maxJobs": manager.settings.ai_model_max_jobs,
            "device": manager.settings.ai_model_device,
            "inference": "sequential",
        },
    }


@router.get("/models/{model}/status")
def model_status(model: str) -> dict:
    if model not in MODELS:
        raise HTTPException(status_code=404, detail={"code": "MODEL_NOT_REGISTERED"})
    manager = get_manager()
    manager.discover()
    return manager.status(model)


@router.post("/models/{model}/predict")
async def predict(model: ModelName, payload: PredictRequest) -> dict:
    _check_size(payload.text)
    return await _run(
        get_manager().predict,
        model,
        payload.text,
        payload.thresholdProfile,
        payload.customThreshold,
    )


@router.post("/models/compare")
async def compare_models(payload: CompareModelsRequest) -> dict:
    _check_size(payload.text)
    manager = get_manager()
    results = []
    for (
        model
    ) in payload.models:  # sequential on purpose (MODEL_MAX_RESIDENT=1 by default)
        results.append(
            await _run(
                manager.predict,
                model,
                payload.text,
                payload.thresholdProfile,
                payload.customThreshold,
            )
        )
    return {"results": results}


@router.post("/analysis/paragraphs")
async def analysis_paragraphs(payload: ParagraphAnalysisRequest) -> dict:
    _check_size(payload.text)
    return await _run(
        service.analyze,
        get_manager(),
        payload.text,
        payload.analyzer,
        payload.thresholdProfile,
        payload.customThreshold,
        payload.paragraphMode,
    )


@router.post("/analysis/compare-versions")
async def analysis_compare_versions(payload: CompareVersionsRequest) -> dict:
    _check_size(payload.baseText, payload.targetText)
    return await _run(
        service.compare_versions,
        get_manager(),
        payload.baseText,
        payload.targetText,
        payload.analyzer,
        payload.thresholdProfile,
        payload.customThreshold,
        payload.paragraphMode,
    )
