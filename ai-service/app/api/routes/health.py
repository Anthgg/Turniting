from fastapi import APIRouter

from app.core.config import get_settings
from app.schemas.health import ServiceStatusResponse

router = APIRouter(tags=["health"])


@router.get("/", response_model=ServiceStatusResponse, include_in_schema=False)
def root() -> ServiceStatusResponse:
    """Keep the service information endpoint available at the root path."""
    return ServiceStatusResponse(status="ok", service=get_settings().name)


@router.get("/health", response_model=ServiceStatusResponse)
def health() -> ServiceStatusResponse:
    return ServiceStatusResponse(status="ok", service=get_settings().name)
