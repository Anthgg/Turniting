from fastapi import APIRouter

from app.api.routes.analyze import router as analyze_router
from app.api.routes.extract import router as extract_router
from app.api.routes.health import router as health_router
from app.api.routes.turnitin import router as turnitin_router
from app.api.routes.turnitin_alignment import router as turnitin_alignment_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(analyze_router)
api_router.include_router(extract_router)
api_router.include_router(turnitin_router)
api_router.include_router(turnitin_alignment_router)
