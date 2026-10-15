from fastapi import APIRouter, File, HTTPException, UploadFile

from app.core.config import get_settings
from app.services.turnitin.parser import TurnitinParseError, parse_turnitin_report
from app.services.turnitin.schemas import TurnitinParseResponse

router = APIRouter(tags=["turnitin-reports"])


@router.post("/turnitin/parse", response_model=TurnitinParseResponse)
async def parse_turnitin_pdf(file: UploadFile = File(...)) -> TurnitinParseResponse:
    settings = get_settings()
    filename = (file.filename or "").replace("\\", "/").rsplit("/", maxsplit=1)[-1]
    media_type = (file.content_type or "").split(";", maxsplit=1)[0].lower()
    if not filename.lower().endswith(".pdf") or media_type != "application/pdf":
        raise HTTPException(status_code=415, detail="Only PDF reports are supported.")
    content = await file.read(settings.max_turnitin_report_mb * 1024 * 1024 + 1)
    if len(content) > settings.max_turnitin_report_mb * 1024 * 1024:
        raise HTTPException(
            status_code=413, detail="The report exceeds the upload limit."
        )
    try:
        return parse_turnitin_report(content)
    except TurnitinParseError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    finally:
        await file.close()
