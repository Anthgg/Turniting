import re

from app.services.turnitin.normalization import fold_for_matching
from app.services.turnitin.schemas import ParsedSource, PercentageValue

FILTER_LABELS = {
    "bibliografia": "BIBLIOGRAPHY",
    "texto citado": "QUOTED_TEXT",
    "texto mencionado": "CITED_TEXT",
    "coincidencias menores (menos de 8 palabras)": "MATCHES_UNDER_8_WORDS",
}

SOURCE_PALETTE = {
    (1.0, 0.86, 0.91): (1, "#FFDCE8"),
    (0.84, 0.9, 0.98): (2, "#D6E6FA"),
    (0.76, 0.93, 0.88): (3, "#C2EEDD"),
}


def parse_percent(raw: str) -> tuple[float | None, bool]:
    match = re.search(r"(<\s*)?(\d+(?:[.,]\d+)?)\s*%", raw)
    if not match:
        return None, False
    if match.group(1):
        return None, True
    return float(match.group(2).replace(",", ".")), False


def parse_similarity_scores(
    page_texts: list[str],
) -> tuple[dict[str, PercentageValue], list[str]]:
    opening = fold_for_matching("\n".join(page_texts[: min(4, len(page_texts))]))
    scores: dict[str, PercentageValue] = {}
    overall = re.search(r"(\d+(?:[.,]\d+)?)\s*%\s*similitud\s+general", opening)
    if overall:
        raw = f"{overall.group(1)}%"
        scores["similarity"] = PercentageValue(
            raw=raw,
            percentage=float(overall.group(1).replace(",", ".")),
        )

    category_patterns = {
        "internet": r"(\d+(?:[.,]\d+)?)\s*%\s*fuentes?\s+de\s+internet",
        "publications": r"(\d+(?:[.,]\d+)?)\s*%\s*publicaciones",
        "studentPapers": r"(\d+(?:[.,]\d+)?)\s*%\s*trabajos\s+entregados",
    }
    for name, pattern in category_patterns.items():
        match = re.search(pattern, opening)
        if match:
            raw = f"{match.group(1)}%"
            scores[name] = PercentageValue(
                raw=raw,
                percentage=float(match.group(1).replace(",", ".")),
            )

    filters: list[str] = []
    for visible, value in FILTER_LABELS.items():
        if visible in opening:
            filters.append(value)
    return scores, filters


def _line_texts(page: object) -> list[str]:
    result: list[str] = []
    page_dict = page.get_text("dict", sort=True)  # type: ignore[attr-defined]
    for block in page_dict.get("blocks", []):
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            if text.strip():
                result.append(text.strip())
    return result


def _source_type(category: str) -> str:
    folded = fold_for_matching(category)
    if "internet" in folded:
        return "INTERNET"
    if "trabajos" in folded or "estudiante" in folded:
        return "STUDENT_PAPER"
    if "publicaciones" in folded or "publication" in folded:
        return "PUBLICATION"
    return "OTHER"


def parse_sources(pdf_document: object) -> list[ParsedSource]:
    sources: list[ParsedSource] = []
    for page in pdf_document:  # type: ignore[union-attr]
        lines = _line_texts(page)
        if not any("fuentes principales" in fold_for_matching(line) for line in lines):
            continue
        entries: list[tuple[int, list[str]]] = []
        current_index: int | None = None
        current_lines: list[str] = []
        for line in lines:
            folded = fold_for_matching(line)
            if current_index is not None and (
                "identificador de la entrega" in folded
                or "trn:oid" in folded
                or re.search(r"p.{0,1}gina\s+\d+\s+de\s+\d+", folded)
            ):
                if current_lines:
                    entries.append((current_index, current_lines))
                current_index = None
                current_lines = []
                break
            marker = re.match(
                r"^\s*(\d{1,3})(?:\s+(internet|trabajos|publicaciones))?\s*$", folded
            )
            if marker:
                if current_index is not None:
                    entries.append((current_index, current_lines))
                current_index = int(marker.group(1))
                current_lines = [line] if marker.group(2) else []
            elif current_index is not None:
                if "fuentes principales" in folded or "fuentes con el mayor" in folded:
                    if current_lines:
                        entries.append((current_index, current_lines))
                    current_index = None
                    current_lines = []
                else:
                    current_lines.append(line)
        if current_index is not None:
            entries.append((current_index, current_lines))
        if not entries:
            continue

        for index, entry_lines in entries:
            combined = " ".join(entry_lines)
            percent_match = re.search(
                r"<\s*\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%", combined
            )
            raw_percentage = (
                re.sub(r"\s+", "", percent_match.group(0)) if percent_match else None
            )
            percentage, is_less_than = parse_percent(raw_percentage or "")
            first = entry_lines[0]
            category_match = re.match(r"\s*\d{1,3}\s+(.+)", first)
            category = category_match.group(1) if category_match else first
            display_parts: list[str] = []
            for line in entry_lines[1:]:
                cleaned = re.sub(
                    r"<\s*\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%", "", line
                )
                if fold_for_matching(cleaned) in {
                    "internet",
                    "trabajos",
                    "entregados",
                    "publicaciones",
                }:
                    continue
                if cleaned.strip():
                    display_parts.append(cleaned.strip())
            color = next(
                (
                    hex_color
                    for _, (source_index, hex_color) in SOURCE_PALETTE.items()
                    if source_index == index
                ),
                None,
            )
            sources.append(
                ParsedSource(
                    sourceIndex=index,
                    sourceType=_source_type(category),
                    displayName=" ".join(display_parts)[:500] or f"Source {index}",
                    percentageRaw=raw_percentage,
                    percentage=percentage,
                    percentageIsLessThan=is_less_than,
                    color=color,
                )
            )
        if sources:
            break
    return sources
