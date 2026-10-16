from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.services.ocr.schemas import PageAnalysis


class DocumentExtractionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["success"] = "success"
    file_type: Literal["pdf", "docx", "txt", "png", "jpeg"] = Field(alias="fileType")
    text: str
    page_count: int | None = Field(alias="pageCount")
    word_count: int = Field(alias="wordCount")
    character_count: int = Field(alias="characterCount")
    requires_ocr: bool = Field(alias="requiresOcr")
    warnings: list[str]
    pages: list[PageAnalysis] = Field(default_factory=list)
