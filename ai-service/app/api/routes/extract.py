from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.core.config import get_settings
from app.schemas.extraction import DocumentExtractionResponse
from app.services.document_extraction import (
    DocumentInputError,
    extract_document,
)

router = APIRouter(tags=["documents"])


@router.post("/extract", response_model=DocumentExtractionResponse)
async def extract(file: Annotated[UploadFile, File(...)]) -> DocumentExtractionResponse:
    settings = get_settings()
    max_upload_bytes = settings.max_upload_mb * 1024 * 1024
    content = await file.read(max_upload_bytes + 1)
    if len(content) > max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds the {settings.max_upload_mb} MB upload limit.",
        )

    try:
        return extract_document(file.content_type, content, settings)
    except DocumentInputError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail=error.detail,
        ) from None
