import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.router import api_router
from app.core.config import get_settings
from app.services.ocr.exceptions import OcrProcessingError
from app.services.ocr.paddle_engine import engine

settings = get_settings()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    cache_marker = settings.ocr_model_dir / ".f003-model-ready"
    if cache_marker.is_file():
        try:
            await asyncio.to_thread(engine.warmup, settings)
        except OcrProcessingError:
            logger.warning(
                "Cached local OCR model could not be loaded; "
                "OCR will remain unavailable."
            )
    yield


app = FastAPI(title=settings.name, version=settings.version, lifespan=lifespan)
app.include_router(api_router)
