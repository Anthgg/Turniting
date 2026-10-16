import re
import unicodedata
from collections.abc import Sequence

from rapidfuzz import fuzz

from app.services.ocr.schemas import OcrBlock


def normalize_ocr_text(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "").strip()


def deduplicate_hybrid(
    digital_text: str,
    blocks: Sequence[OcrBlock],
) -> tuple[str, list[OcrBlock]]:
    """Keep digital text intact and append OCR blocks not already represented."""
    digital = normalize_ocr_text(digital_text)
    candidates = [
        line.strip()
        for line in re.split(r"\n+", digital)
        if len(_comparison(line)) >= 8
    ]
    retained: list[OcrBlock] = []
    for block in blocks:
        duplicate = any(_is_duplicate(block.text, line) for line in candidates)
        retained.append(block.model_copy(update={"duplicate_of_digital": duplicate}))

    added = [block.text.strip() for block in retained if not block.duplicate_of_digital]
    if digital and added:
        canonical = f"{digital}\n{normalize_ocr_text(chr(10).join(added))}"
    elif digital:
        canonical = digital
    else:
        canonical = normalize_ocr_text("\n".join(added))
    return canonical, retained


def _comparison(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(normalized.split())


def _is_duplicate(ocr_text: str, digital_line: str) -> bool:
    ocr = _comparison(ocr_text)
    digital = _comparison(digital_line)
    if not ocr or not digital:
        return False
    if ocr in digital or digital in ocr:
        return min(len(ocr), len(digital)) / max(len(ocr), len(digital)) >= 0.75
    return fuzz.ratio(ocr, digital) >= 92
