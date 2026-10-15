from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ReportType = Literal["AI_WRITING", "SIMILARITY", "UNKNOWN"]
ReportStatus = Literal["PARSED", "PARTIAL", "OCR_REQUIRED"]
SegmentType = Literal["AI_FLAGGED", "SIMILARITY_MATCH", "NOT_FLAGGED", "UNKNOWN"]
SourceType = Literal["INTERNET", "PUBLICATION", "STUDENT_PAPER", "OTHER"]


class PercentageValue(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    raw: str
    percentage: float | None = None
    percentageIsLessThan: bool = False


class ParsedSource(BaseModel):
    sourceIndex: int
    sourceType: SourceType
    displayName: str
    percentageRaw: str | None = None
    percentage: float | None = None
    percentageIsLessThan: bool = False
    color: str | None = None


class ParsedSegment(BaseModel):
    segmentIndex: int
    segmentType: SegmentType
    pageNumber: int
    text: str
    normalizedText: str = ""
    bbox: list[float] = Field(min_length=4, max_length=4)
    sourceIndex: int | None = None
    color: str | None = None


class TurnitinParseResponse(BaseModel):
    status: ReportStatus
    reportType: ReportType
    parserVersion: str = "f002-v1"
    metadata: dict[str, Any] = Field(default_factory=dict)
    scores: dict[str, PercentageValue] = Field(default_factory=dict)
    filters: list[str] = Field(default_factory=list)
    sources: list[ParsedSource] = Field(default_factory=list)
    segments: list[ParsedSegment] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    # Internal service-to-service field used only for document alignment.
    documentText: str = ""
