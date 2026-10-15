from fastapi import APIRouter

from app.schemas.analysis import TestAnalysisRequest, TestAnalysisResponse
from app.services.text_analysis import analyze_text

router = APIRouter(prefix="/analyze", tags=["analysis"])


@router.post("/test", response_model=TestAnalysisResponse)
def analyze_test(payload: TestAnalysisRequest) -> TestAnalysisResponse:
    return analyze_text(payload.text)
