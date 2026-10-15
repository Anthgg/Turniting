import re
import unicodedata


def fold_for_matching(value: str) -> str:
    """Fold accents, PDF replacement glyphs, and whitespace for label matching."""
    value = value.replace("\ufffd", " ")
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    without_marks = "".join(
        character for character in decomposed if not unicodedata.combining(character)
    )
    return re.sub(r"\s+", " ", without_marks).strip()


def normalize_document_text(value: str) -> str:
    """Create comparison text while leaving the stored source text untouched."""
    folded = fold_for_matching(value)
    folded = re.sub(r"\bturnitin\b", " ", folded)
    folded = re.sub(r"trn\s*:\s*oid\s*:{1,3}\s*[\w:.-]+", " ", folded)
    folded = re.sub(r"p.{0,1}gina\s+\d+\s+de\s+\d+[^\n]*", " ", folded)
    folded = re.sub(r"identificador de la entrega[^\n]*", " ", folded)
    folded = re.sub(r"\s+", " ", folded)
    return folded.strip()
