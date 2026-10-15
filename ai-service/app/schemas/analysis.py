from typing import Literal

from pydantic import BaseModel, ConfigDict


class TestAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str


class TestAnalysisResponse(BaseModel):
    status: Literal["ok"] = "ok"
    characters: int
    words: int
