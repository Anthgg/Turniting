from app.schemas.analysis import TestAnalysisResponse


def analyze_text(text: str) -> TestAnalysisResponse:
    """Return lightweight text metrics for the F000 connectivity contract."""
    return TestAnalysisResponse(
        characters=len(text),
        words=len(text.split()),
    )
