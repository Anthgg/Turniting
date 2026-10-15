from app.services.turnitin.normalization import fold_for_matching
from app.services.turnitin.schemas import ReportType


def detect_report_type(page_texts: list[str]) -> ReportType:
    """Classify from visible report labels, never from the uploaded filename."""
    opening = fold_for_matching("\n".join(page_texts[: min(4, len(page_texts))]))
    ai_markers = sum(
        marker in opening
        for marker in (
            "escritura con ia",
            "detectado como ia",
            "solo generado con ia",
            "ai writing",
            "ai-generated",
        )
    )
    similarity_markers = sum(
        marker in opening
        for marker in (
            "similitud general",
            "similarity index",
            "descripcion general de integridad",
            "fuentes principales",
        )
    )
    if ai_markers > similarity_markers:
        return "AI_WRITING"
    if similarity_markers > ai_markers:
        return "SIMILARITY"
    return "UNKNOWN"
