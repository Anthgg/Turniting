from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AI_SERVICE_", extra="ignore")

    name: str = "ai-service"
    version: str = "0.1.0"
    max_upload_mb: int = Field(default=20, ge=1, validation_alias="MAX_UPLOAD_MB")
    max_turnitin_report_mb: int = Field(
        default=30,
        ge=1,
        validation_alias="MAX_TURNITIN_REPORT_MB",
    )
    ocr_min_chars_per_page: int = Field(
        default=20,
        ge=1,
        validation_alias="OCR_MIN_CHARS_PER_PAGE",
    )
    ocr_min_low_text_page_ratio: float = Field(
        default=0.5,
        ge=0,
        le=1,
        validation_alias="OCR_MIN_LOW_TEXT_PAGE_RATIO",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
