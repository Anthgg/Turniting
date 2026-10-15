from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.turnitin.alignment import (
    AlignmentResult,
    align_report_to_document,
)

router = APIRouter(tags=["turnitin-reports"])


class SegmentReference(BaseModel):
    segmentIndex: int
    text: str = Field(max_length=12_000)


class TurnitinAlignmentRequest(BaseModel):
    documentText: str = Field(max_length=2_000_000)
    reportText: str = Field(max_length=2_000_000)
    segments: list[SegmentReference] = Field(default_factory=list, max_length=10_000)
    documentMetadata: dict[str, object] = Field(default_factory=dict)
    reportMetadata: dict[str, object] = Field(default_factory=dict)


@router.post("/turnitin/align", response_model=AlignmentResult)
def align_turnitin_report(request: TurnitinAlignmentRequest) -> AlignmentResult:
    try:
        return align_report_to_document(
            request.documentText,
            request.reportText,
            [segment.model_dump() for segment in request.segments],
            request.documentMetadata,
            request.reportMetadata,
        )
    except (ValueError, TypeError, RuntimeError) as error:
        raise HTTPException(
            status_code=422, detail="Report alignment could not be completed."
        ) from error
