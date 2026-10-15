import re
import unicodedata
import zipfile
from io import BytesIO
from typing import Literal
from xml.etree import ElementTree

import pymupdf
from docx import Document
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph

from app.core.config import Settings, get_settings
from app.schemas.extraction import DocumentExtractionResponse

PDF_MIME_TYPE = "application/pdf"
DOCX_MIME_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
TEXT_MIME_TYPE = "text/plain"
DOCX_MAIN_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
)
OCR_WARNING = "PDF has limited extractable text; OCR may be required."
BINARY_SIGNATURES = (
    b"%PDF-",
    b"PK\x03\x04",
    b"PK\x05\x06",
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
    b"\x1f\x8b",
    b"\x7fELF",
)


class DocumentInputError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def normalize_extracted_text(text: str, *, remove_nuls: bool) -> str:
    """Normalize line endings and blank runs without rewriting prose."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if remove_nuls:
        normalized = normalized.replace("\x00", "")
    return re.sub(r"\n{4,}", "\n\n\n", normalized)


def extract_document(
    content_type: str | None,
    content: bytes,
    settings: Settings | None = None,
) -> DocumentExtractionResponse:
    settings = settings or get_settings()
    media_type = (content_type or "").split(";", maxsplit=1)[0].strip().lower()

    if media_type == PDF_MIME_TYPE:
        if not content.startswith(b"%PDF"):
            raise DocumentInputError(
                400,
                "File content does not match the declared PDF media type.",
            )
        return _extract_pdf(content, settings)

    if media_type == DOCX_MIME_TYPE:
        return _extract_docx(content)

    if media_type == TEXT_MIME_TYPE:
        return _extract_text(content)

    raise DocumentInputError(
        415,
        "Only PDF, DOCX, and plain-text files are supported.",
    )


def _extract_pdf(
    content: bytes,
    settings: Settings,
) -> DocumentExtractionResponse:
    document = None
    try:
        document = pymupdf.open(stream=content, filetype="pdf")
        if document.needs_pass:
            raise DocumentInputError(422, "Encrypted PDF files are not supported.")

        page_count = document.page_count
        if page_count < 1:
            raise DocumentInputError(422, "The PDF does not contain any pages.")

        page_texts: list[str] = []
        non_whitespace_counts: list[int] = []
        for page in document:
            page_text = normalize_extracted_text(
                page.get_text("text", sort=False),
                remove_nuls=True,
            )
            page_texts.append(page_text)
            non_whitespace_counts.append(
                sum(not character.isspace() for character in page_text)
            )
    except DocumentInputError:
        raise
    except Exception:
        raise DocumentInputError(
            422,
            "The PDF is invalid or could not be read.",
        ) from None
    finally:
        if document is not None:
            document.close()

    text = normalize_extracted_text("\n".join(page_texts), remove_nuls=True)
    average_chars_per_page = sum(non_whitespace_counts) / page_count
    low_text_pages = sum(
        count < settings.ocr_min_chars_per_page for count in non_whitespace_counts
    )
    low_text_page_ratio = low_text_pages / page_count

    # OCR is only recommended: no OCR engine is invoked in this phase.
    # Require it when average non-whitespace text/page is below OCR_MIN_CHARS_PER_PAGE,
    # or when at least OCR_MIN_LOW_TEXT_PAGE_RATIO pages are below that threshold.
    requires_ocr = (
        average_chars_per_page < settings.ocr_min_chars_per_page
        or low_text_page_ratio >= settings.ocr_min_low_text_page_ratio
    )
    warnings = [OCR_WARNING] if requires_ocr else []
    return _build_response("pdf", text, page_count, requires_ocr, warnings)


def _extract_docx(content: bytes) -> DocumentExtractionResponse:
    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            names = set(archive.namelist())
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                raise DocumentInputError(422, "The DOCX package is incomplete.")

            content_types = ElementTree.fromstring(archive.read("[Content_Types].xml"))
            if not any(
                element.attrib.get("ContentType") == DOCX_MAIN_CONTENT_TYPE
                for element in content_types
            ):
                raise DocumentInputError(422, "The file is not a valid DOCX package.")
            ElementTree.fromstring(archive.read("word/document.xml"))

        document = Document(BytesIO(content))
        text_parts: list[str] = []
        for child in document.element.body.iterchildren():
            if isinstance(child, CT_P):
                text_parts.append(Paragraph(child, document).text)
            elif isinstance(child, CT_Tbl):
                table = Table(child, document)
                rows = [
                    "\t".join(cell.text for cell in row.cells)
                    for row in table.rows
                ]
                text_parts.append("\n".join(rows))
    except DocumentInputError:
        raise
    except Exception:
        raise DocumentInputError(
            422,
            "The DOCX file is invalid or could not be read.",
        ) from None

    text = normalize_extracted_text("\n".join(text_parts), remove_nuls=True)
    return _build_response("docx", text, None, False, [])


def _extract_text(content: bytes) -> DocumentExtractionResponse:
    if b"\x00" in content:
        raise DocumentInputError(422, "Plain-text files must not contain NUL bytes.")
    if content.startswith(BINARY_SIGNATURES):
        raise DocumentInputError(
            422,
            "The uploaded plain-text file appears to contain binary data.",
        )

    warnings: list[str] = []
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = content.decode("cp1252")
            warnings.append("Text was decoded using the Windows-1252 fallback.")
        except UnicodeDecodeError:
            text = content.decode("latin-1")
            warnings.append("Text was decoded using the Latin-1 fallback.")

    if _contains_binary_controls(text):
        raise DocumentInputError(
            422,
            "The uploaded plain-text file contains binary control characters.",
        )

    normalized_text = normalize_extracted_text(text, remove_nuls=False)
    return _build_response("txt", normalized_text, None, False, warnings)


def _contains_binary_controls(text: str) -> bool:
    allowed_controls = {"\t", "\n", "\r", "\f"}
    controls = [
        character
        for character in text
        if unicodedata.category(character) == "Cc" and character not in allowed_controls
    ]
    if any(ord(character) < 0x80 for character in controls):
        return True
    # Permit rare Latin-1 C1 values for the decoding fallback, but reject
    # payloads where those controls make up a meaningful share of the text.
    return bool(controls) and len(controls) / max(len(text), 1) > 0.05


def _build_response(
    file_type: Literal["pdf", "docx", "txt"],
    text: str,
    page_count: int | None,
    requires_ocr: bool,
    warnings: list[str],
) -> DocumentExtractionResponse:
    return DocumentExtractionResponse(
        file_type=file_type,
        text=text,
        page_count=page_count,
        word_count=len(text.split()),
        character_count=len(text),
        requires_ocr=requires_ocr,
        warnings=warnings,
    )
