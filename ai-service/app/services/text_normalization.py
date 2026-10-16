import re


def normalize_extracted_text(text: str, *, remove_nuls: bool) -> str:
    """Normalize line endings and blank runs without rewriting prose."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if remove_nuls:
        normalized = normalized.replace("\x00", "")
    return re.sub(r"\n{4,}", "\n\n\n", normalized)
