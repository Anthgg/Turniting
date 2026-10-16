from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class PageClassification(StrEnum):
    DIGITAL_OK = "DIGITAL_OK"
    OCR_REQUIRED = "OCR_REQUIRED"
    HYBRID_CANDIDATE = "HYBRID_CANDIDATE"
    BLANK = "BLANK"
    UNREADABLE = "UNREADABLE"


class ExtractionMethod(StrEnum):
    DIGITAL = "DIGITAL"
    OCR = "OCR"
    HYBRID = "HYBRID"
    NONE = "NONE"


class OcrBlock(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str
    confidence: float | None = None
    bbox: dict[str, float]
    reading_order: int = Field(alias="readingOrder")
    low_confidence: bool = Field(default=False, alias="lowConfidence")
    duplicate_of_digital: bool = Field(default=False, alias="duplicateOfDigital")


class PageAnalysis(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page_number: int = Field(alias="pageNumber")
    classification: PageClassification
    width: float
    height: float
    rotation: int = 0
    digital_text: str = Field(default="", alias="digitalText")
    canonical_text: str = Field(default="", alias="canonicalText")
    extraction_method: ExtractionMethod = Field(alias="extractionMethod")
    requires_ocr: bool = Field(alias="requiresOcr")
    image_area_ratio: float = Field(default=0, alias="imageAreaRatio")
    warnings: list[str] = Field(default_factory=list)


class OcrPageResult(PageAnalysis):
    ocr_text: str | None = Field(default=None, alias="ocrText")
    confidence: float | None = None
    blocks: list[OcrBlock] = Field(default_factory=list)
    deskew_angle: float = Field(default=0, alias="deskewAngle")
    processing_ms: int = Field(default=0, alias="processingMs")
    ocr_error_code: str | None = Field(default=None, alias="ocrErrorCode")


class AnalyzeResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    page_count: int = Field(alias="pageCount")
    pages: list[PageAnalysis]
    warnings: list[str] = Field(default_factory=list)


class ProcessResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["success"] = "success"
    engine: str
    engine_version: str = Field(alias="engineVersion")
    model: str
    language: str
    pipeline_version: str = Field(alias="pipelineVersion")
    pages: list[OcrPageResult]
    pages_requested: int = Field(alias="pagesRequested")
    pages_processed: int = Field(alias="pagesProcessed")
    pages_skipped: int = Field(alias="pagesSkipped")
    pages_failed: int = Field(alias="pagesFailed")
    average_confidence: float | None = Field(alias="averageConfidence")
    duration_ms: int = Field(alias="durationMs")
    warnings: list[str] = Field(default_factory=list)


JsonObject = dict[str, Any]
