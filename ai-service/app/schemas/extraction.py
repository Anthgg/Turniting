from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class DocumentExtractionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["success"] = "success"
    file_type: Literal["pdf", "docx", "txt"] = Field(alias="fileType")
    text: str
    page_count: int | None = Field(alias="pageCount")
    word_count: int = Field(alias="wordCount")
    character_count: int = Field(alias="characterCount")
    requires_ocr: bool = Field(alias="requiresOcr")
    warnings: list[str]
