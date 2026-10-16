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
from app.services.ocr.detector import classify_page_for_ocr, classify_raster_page
from app.services.ocr.exceptions import OcrProcessingError
from app.services.ocr.renderer import load_image
from app.services.text_normalization import normalize_extracted_text

PDF_MIME_TYPE = "application/pdf"
DOCX_MIME_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
TEXT_MIME_TYPE = "text/plain"
PNG_MIME_TYPE = "image/png"
JPEG_MIME_TYPE = "image/jpeg"
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

    if media_type in {PNG_MIME_TYPE, JPEG_MIME_TYPE}:
        return _extract_image(media_type, content, settings)

    raise DocumentInputError(
        415,
        "Only PDF, DOCX, TXT, PNG, and JPEG files are supported.",
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

        pages = []
        for page in document:
            pages.append(classify_page_for_ocr(page, settings))
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

    text = normalize_extracted_text(
        "\n".join(page.canonical_text for page in pages), remove_nuls=True
    )
    requires_ocr = any(page.requires_ocr for page in pages)
    warnings = [OCR_WARNING] if requires_ocr else []
    return _build_response("pdf", text, page_count, requires_ocr, warnings, pages)


def _extract_image(
    media_type: str,
    content: bytes,
    settings: Settings,
) -> DocumentExtractionResponse:
    if media_type == PNG_MIME_TYPE and not content.startswith(b"\x89PNG\r\n\x1a\n"):
        raise DocumentInputError(
            400, "Image content does not match its declared PNG media type."
        )
    if media_type == JPEG_MIME_TYPE and not content.startswith(b"\xff\xd8\xff"):
        raise DocumentInputError(
            400, "Image content does not match its declared JPEG media type."
        )
    try:
        image, image_format = load_image(
            content,
            max_pixels=settings.ocr_max_render_pixels,
        )
        expected_format = "png" if media_type == PNG_MIME_TYPE else "jpeg"
        if image_format != expected_format:
            raise OcrProcessingError(
                "OCR_UNSUPPORTED_FORMAT",
                "Image format does not match its MIME type.",
                415,
            )
        page = classify_raster_page(image, page_number=1, settings=settings)
    except OcrProcessingError as error:
        raise DocumentInputError(error.status_code, error.message) from None
    warnings = ["Image requires OCR."] if page.requires_ocr else []
    return _build_response(
        expected_format,
        page.canonical_text,
        1,
        page.requires_ocr,
        warnings,
        [page],
    )


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
                    "\t".join(cell.text for cell in row.cells) for row in table.rows
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
    file_type: Literal["pdf", "docx", "txt", "png", "jpeg"],
    text: str,
    page_count: int | None,
    requires_ocr: bool,
    warnings: list[str],
    pages=None,
) -> DocumentExtractionResponse:
    return DocumentExtractionResponse(
        file_type=file_type,
        text=text,
        page_count=page_count,
        word_count=len(text.split()),
        character_count=len(text),
        requires_ocr=requires_ocr,
        warnings=warnings,
        pages=pages or [],
    )
