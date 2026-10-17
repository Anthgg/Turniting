from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ModelName = Literal["CANDIDATE_MODEL_V2", "CANDIDATE_MODEL_V3"]
ThresholdProfile = Literal[
    "BALANCED", "LOW_FALSE_POSITIVE", "VERY_LOW_FALSE_POSITIVE", "CUSTOM"
]
AnalyzerMode = Literal["V2_ONLY", "V3_ONLY", "ENSEMBLE"]
ParagraphMode = Literal["STRICT_PARAGRAPH", "CONTEXTUAL_PARAGRAPH"]


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    thresholdProfile: ThresholdProfile = "BALANCED"
    customThreshold: float | None = Field(default=None, gt=0, lt=1)


class CompareModelsRequest(PredictRequest):
    models: list[ModelName] = Field(
        default_factory=lambda: ["CANDIDATE_MODEL_V2", "CANDIDATE_MODEL_V3"],
        min_length=1,
        max_length=2,
    )


class ParagraphAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1)
    analyzer: AnalyzerMode = "V3_ONLY"
    thresholdProfile: ThresholdProfile = "BALANCED"
    customThreshold: float | None = Field(default=None, gt=0, lt=1)
    paragraphMode: ParagraphMode = "STRICT_PARAGRAPH"


class CompareVersionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baseText: str = Field(min_length=1)
    targetText: str = Field(min_length=1)
    analyzer: AnalyzerMode = "V3_ONLY"
    thresholdProfile: ThresholdProfile = "BALANCED"
    customThreshold: float | None = Field(default=None, gt=0, lt=1)
    paragraphMode: ParagraphMode = "STRICT_PARAGRAPH"


class AlignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baseText: str
    targetText: str
