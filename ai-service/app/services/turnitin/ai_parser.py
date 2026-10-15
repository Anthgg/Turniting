import re

from app.services.turnitin.normalization import fold_for_matching
from app.services.turnitin.schemas import PercentageValue


def parse_ai_scores(page_texts: list[str]) -> dict[str, PercentageValue]:
    opening = fold_for_matching("\n".join(page_texts[: min(4, len(page_texts))]))
    scores: dict[str, PercentageValue] = {}
    match = re.search(
        r"(\d{1,3}(?:[.,]\d+)?)\s*%\s*detectado\s+como\s+ia",
        opening,
    )
    if match:
        raw = f"{match.group(1)}%"
        scores["aiWriting"] = PercentageValue(
            raw=raw,
            percentage=float(match.group(1).replace(",", ".")),
        )
    else:
        match = re.search(
            r"(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:ai\s+writing|ai-generated)",
            opening,
        )
        if match:
            raw = f"{match.group(1)}%"
            scores["aiWriting"] = PercentageValue(
                raw=raw,
                percentage=float(match.group(1).replace(",", ".")),
            )

    category = re.search(
        r"(\d{1,3}(?:[.,]\d+)?)\s*%\s*solo\s+generado\s+con\s+ia",
        opening,
    )
    if category:
        raw = f"{category.group(1)}%"
        scores["aiGeneratedOnly"] = PercentageValue(
            raw=raw,
            percentage=float(category.group(1).replace(",", ".")),
        )
    return scores
