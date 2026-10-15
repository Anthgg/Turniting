import re
from typing import Any

from app.services.turnitin.normalization import fold_for_matching


def _count(pattern: str, text: str) -> int | None:
    match = re.search(pattern, text, re.IGNORECASE)
    if not match:
        return None
    return int(match.group(1).replace(",", "").replace(".", ""))


def _labeled_value(text: str, labels: tuple[str, ...]) -> str | None:
    for line in text.splitlines():
        folded = fold_for_matching(line)
        for label in labels:
            marker = fold_for_matching(label)
            position = folded.find(marker)
            if position < 0:
                continue
            # Use the original line for visible metadata, with label offsets mapped
            # through the same character length for the common ASCII labels.
            raw_position = line.casefold().find(label.casefold())
            if raw_position >= 0:
                value = line[raw_position + len(label) :].strip(" :\t")
                if value:
                    return value[:300]
    return None


def parse_metadata(page_texts: list[str]) -> dict[str, Any]:
    all_text = "\n".join(page_texts)
    normalized = fold_for_matching(all_text)
    submission = re.search(
        r"trn\s*:\s*oid\s*:{1,3}\s*\d+\s*:\s*\d+",
        all_text,
        re.IGNORECASE,
    )
    submission_id = re.sub(r"\s+", "", submission.group(0)) if submission else None
    page_count = _count(r"\b(\d{1,5})\s+p.{0,1}ginas?\b", normalized)
    word_count = _count(r"\b(\d[\d,.]*)\s+palabras?\b", normalized)
    character_count = _count(r"\b(\d[\d,.]*)\s+caracteres?\b", normalized)
    document_name = _labeled_value(
        page_texts[0] if page_texts else "",
        ("Nombre del archivo", "File name", "Filename"),
    )
    return {
        "submissionId": submission_id,
        "submissionFileName": document_name,
        "reportPageCount": len(page_texts),
        "documentPageCount": page_count,
        "wordCount": word_count,
        "characterCount": character_count,
    }
