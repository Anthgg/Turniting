import asyncio
import json
import threading
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.core.config import get_settings
from app.services.ocr.exceptions import OcrProcessingError
from app.services.ocr.paddle_engine import engine
from app.services.ocr.processor import analyze_document, process_document_ocr
from app.services.ocr.schemas import AnalyzeResponse, ProcessResponse

router = APIRouter(prefix="/ocr", tags=["ocr"])
_semaphore_lock = threading.Lock()
_job_semaphores: dict[int, threading.BoundedSemaphore] = {}


def _model_cache_marker() -> bool:
    return (get_settings().ocr_model_dir / ".f003-model-ready").is_file()


@router.get("/status")
async def ocr_status() -> dict[str, object]:
    settings = get_settings()
    return {
        "status": "ok",
        "engine": settings.ocr_engine,
        "engineVersion": engine.metadata(settings)["engineVersion"],
        "model": settings.ocr_model,
        "language": settings.ocr_language,
        "pipelineVersion": settings.ocr_pipeline_version,
        "modelReady": engine.ready,
        "modelCacheConfigured": _model_cache_marker(),
    }


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze(file: Annotated[UploadFile, File(...)]) -> AnalyzeResponse:
    settings = get_settings()
    content = await _read_upload(file, settings.max_upload_mb * 1024 * 1024)
    try:
        pages = await asyncio.to_thread(
            analyze_document,
            file.content_type,
            content,
            settings,
        )
        return AnalyzeResponse(pageCount=len(pages), pages=pages)
    except OcrProcessingError as error:
        _raise_ocr_error(error)


@router.post("/process", response_model=ProcessResponse)
async def process(
    file: Annotated[UploadFile, File(...)],
    pages: Annotated[str | None, Form()] = None,
    force: Annotated[bool, Form()] = False,
) -> ProcessResponse:
    settings = get_settings()
    content = await _read_upload(
        file,
        max(settings.max_upload_mb, settings.max_turnitin_report_mb) * 1024 * 1024,
    )
    requested_pages = _parse_pages(pages)
    semaphore = _semaphore_for(settings.ocr_max_concurrent_jobs)

    def run() -> ProcessResponse:
        if not semaphore.acquire(timeout=settings.ocr_timeout_ms / 1000):
            raise OcrProcessingError(
                "OCR_TIMEOUT", "OCR timed out while waiting for capacity.", 504
            )
        try:
            return process_document_ocr(
                file.content_type,
                content,
                settings,
                requested_pages=requested_pages,
                force=force,
            )
        finally:
            semaphore.release()

    try:
        return await asyncio.wait_for(
            asyncio.to_thread(run), timeout=settings.ocr_timeout_ms / 1000
        )
    except TimeoutError:
        raise HTTPException(
            status_code=504,
            detail={
                "code": "OCR_TIMEOUT",
                "message": "OCR exceeded the configured time limit.",
            },
        ) from None
    except OcrProcessingError as error:
        _raise_ocr_error(error)


async def _read_upload(file: UploadFile, max_bytes: int) -> bytes:
    content = await file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "OCR_IMAGE_TOO_LARGE",
                "message": "File exceeds the configured upload limit.",
            },
        )
    return content


def _parse_pages(value: str | None) -> list[int] | None:
    if value is None or not value.strip():
        return None
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list) and all(
            isinstance(number, int) and not isinstance(number, bool)
            for number in parsed
        ):
            return parsed
    except json.JSONDecodeError:
        pass
    try:
        return [int(part.strip()) for part in value.split(",") if part.strip()]
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "OCR_PROCESSING_FAILED",
                "message": "Page selection is invalid.",
            },
        ) from None


def _semaphore_for(limit: int) -> threading.BoundedSemaphore:
    with _semaphore_lock:
        return _job_semaphores.setdefault(limit, threading.BoundedSemaphore(limit))


def _raise_ocr_error(error: OcrProcessingError) -> None:
    raise HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    ) from None
