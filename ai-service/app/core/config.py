from functools import lru_cache
from pathlib import Path
from typing import Literal

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
    ocr_engine: Literal["paddleocr"] = Field(
        default="paddleocr",
        validation_alias="OCR_ENGINE",
    )
    ocr_language: str = Field(default="es", validation_alias="OCR_LANGUAGE")
    ocr_model: str = Field(
        default="PP-OCRv5_mobile_det+latin_PP-OCRv5_mobile_rec",
        validation_alias="OCR_MODEL",
    )
    ocr_model_dir: Path = Field(
        default=Path("/data/models/paddleocr"),
        validation_alias="OCR_MODEL_DIR",
    )
    ocr_pipeline_version: str = Field(
        default="f003-v1",
        validation_alias="OCR_PIPELINE_VERSION",
    )
    ocr_dpi: int = Field(default=220, ge=72, le=400, validation_alias="OCR_DPI")
    ocr_cpu_threads: int = Field(
        default=2,
        ge=1,
        le=16,
        validation_alias="OCR_CPU_THREADS",
    )
    ocr_timeout_ms: int = Field(
        default=120_000,
        ge=1_000,
        le=600_000,
        validation_alias="OCR_TIMEOUT_MS",
    )
    ocr_max_pages_per_run: int = Field(
        default=150,
        ge=1,
        le=1_000,
        validation_alias="OCR_MAX_PAGES_PER_RUN",
    )
    ocr_max_render_pixels: int = Field(
        default=20_000_000,
        ge=100_000,
        le=100_000_000,
        validation_alias="OCR_MAX_RENDER_PIXELS",
    )
    ocr_low_confidence_threshold: float = Field(
        default=0.60,
        ge=0,
        le=1,
        validation_alias="OCR_LOW_CONFIDENCE_THRESHOLD",
    )
    ocr_max_concurrent_jobs: int = Field(
        default=1,
        ge=1,
        le=8,
        validation_alias="OCR_MAX_CONCURRENT_JOBS",
    )
    ocr_min_digital_chars: int = Field(
        default=20,
        ge=1,
        validation_alias="OCR_MIN_DIGITAL_CHARS",
    )
    ocr_min_digital_words: int = Field(
        default=4,
        ge=1,
        validation_alias="OCR_MIN_DIGITAL_WORDS",
    )
    ocr_image_area_ratio: float = Field(
        default=0.15,
        ge=0,
        le=1,
        validation_alias="OCR_IMAGE_AREA_RATIO",
    )
    ocr_blank_page_threshold: float = Field(
        default=0.004,
        ge=0,
        le=1,
        validation_alias="OCR_BLANK_PAGE_THRESHOLD",
    )
    ocr_deskew_min_angle: float = Field(
        default=1.0,
        ge=0,
        le=10,
        validation_alias="OCR_DESKEW_MIN_ANGLE",
    )
    ocr_contrast_range: int = Field(
        default=70,
        ge=1,
        le=255,
        validation_alias="OCR_CONTRAST_RANGE",
    )

    # F005 local AI analyzer. Artifact paths are configured server-side only; a missing
    # artifact makes the model UNAVAILABLE, never the service unhealthy.
    ai_model_v2_path: Path | None = Field(
        default=None, validation_alias="AI_MODEL_V2_PATH"
    )
    ai_model_v3_path: Path | None = Field(
        default=None, validation_alias="AI_MODEL_V3_PATH"
    )
    ai_baseline_model_path: Path | None = Field(
        default=None,
        validation_alias="AI_BASELINE_MODEL_PATH",
    )
    ai_model_device: Literal["auto", "cpu", "cuda", "mps"] = Field(
        default="auto",
        validation_alias="AI_MODEL_DEVICE",
    )
    ai_model_max_resident: int = Field(
        default=1,
        ge=1,
        le=3,
        validation_alias="MODEL_MAX_RESIDENT",
    )
    ai_model_max_jobs: int = Field(
        default=1, ge=1, le=4, validation_alias="MODEL_MAX_JOBS"
    )
    ai_model_cpu_threads: int = Field(
        default=4,
        ge=1,
        le=32,
        validation_alias="AI_MODEL_CPU_THREADS",
    )
    ai_analyzer_profiles_dir: Path = Field(
        default=Path(__file__).resolve().parents[1]
        / "services"
        / "analyzer"
        / "profiles",
        validation_alias="AI_ANALYZER_PROFILES_DIR",
    )
    ai_max_analysis_chars: int = Field(
        default=400_000,
        ge=1_000,
        validation_alias="AI_MAX_ANALYSIS_CHARS",
    )
    min_paragraph_chars: int = Field(
        default=120, ge=1, validation_alias="MIN_PARAGRAPH_CHARS"
    )
    min_paragraph_words: int = Field(
        default=20, ge=1, validation_alias="MIN_PARAGRAPH_WORDS"
    )
    min_paragraph_tokens: int = Field(
        default=32, ge=1, validation_alias="MIN_PARAGRAPH_TOKENS"
    )
    paragraph_target_tokens: int = Field(
        default=384,
        ge=64,
        le=510,
        validation_alias="PARAGRAPH_TARGET_TOKENS",
    )
    paragraph_context_tokens: int = Field(
        default=64,
        ge=0,
        le=128,
        validation_alias="PARAGRAPH_CONTEXT_TOKENS",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
