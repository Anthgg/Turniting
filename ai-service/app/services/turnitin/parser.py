import re
from typing import Any

import pymupdf

from app.services.turnitin.ai_parser import parse_ai_scores
from app.services.turnitin.detector import detect_report_type
from app.services.turnitin.layout_parser import parse_layout_segments
from app.services.turnitin.metadata_parser import parse_metadata
from app.services.turnitin.schemas import TurnitinParseResponse
from app.services.turnitin.similarity_parser import (
    parse_similarity_scores,
    parse_sources,
)


class TurnitinParseError(ValueError):
    """Raised when the provided bytes are not a readable PDF report."""


def parse_turnitin_report(content: bytes) -> TurnitinParseResponse:
    if not content or b"%PDF-" not in content[:1024]:
        raise TurnitinParseError("File content does not match a PDF signature.")
    try:
        document = pymupdf.open(stream=content, filetype="pdf")
    except (pymupdf.FileDataError, ValueError, RuntimeError) as error:
        raise TurnitinParseError("The PDF could not be read.") from error
    try:
        if document.needs_pass:
            raise TurnitinParseError("Password-protected PDFs are not supported.")
        if len(document) > 2_000:
            raise TurnitinParseError("The PDF exceeds the supported page limit.")
        page_texts = [page.get_text("text", sort=True) for page in document]
        extracted_chars = sum(len(text.strip()) for text in page_texts)
        metadata = parse_metadata(page_texts)
        report_type = detect_report_type(page_texts)
        warnings: list[str] = []
        status: Any = "PARSED"

        if extracted_chars < max(50, len(page_texts) * 15):
            status = "OCR_REQUIRED"
            warnings.append(
                "The PDF contains too little selectable text; OCR is required "
                "in a later phase."
            )
            report_type = "UNKNOWN"
        elif report_type == "UNKNOWN":
            status = "PARTIAL"
            warnings.append(
                "The visible labels did not identify an AI-writing or "
                "similarity report."
            )

        if report_type == "AI_WRITING":
            scores = parse_ai_scores(page_texts)
            sources = []
        elif report_type == "SIMILARITY":
            scores, parsed_filters = parse_similarity_scores(page_texts)
            metadata["filters"] = parsed_filters
            sources = parse_sources(document)
        else:
            scores = {}
            parsed_filters = []
            sources = []

        filters = metadata.pop(
            "filters", parsed_filters if report_type == "SIMILARITY" else []
        )
        segments, document_text = parse_layout_segments(
            document, page_texts, report_type
        )
        flagged = [
            segment
            for segment in segments
            if segment.segmentType in {"AI_FLAGGED", "SIMILARITY_MATCH"}
        ]

        if report_type == "AI_WRITING" and "aiWriting" not in scores:
            warnings.append(
                "The AI-writing percentage was not found in visible report text."
            )
        if report_type == "SIMILARITY" and "similarity" not in scores:
            warnings.append(
                "The overall similarity percentage was not found in visible "
                "report text."
            )
        if report_type == "SIMILARITY" and not sources:
            warnings.append("No visible source list could be parsed from the report.")
        if report_type in {"AI_WRITING", "SIMILARITY"} and not flagged:
            warnings.append(
                "No visible highlighted document segments could be mapped from the PDF."
            )
        if not metadata.get("submissionId"):
            warnings.append("The visible submission identifier was not found.")
        if metadata.get("wordCount") is None or metadata.get("characterCount") is None:
            warnings.append("One or more visible document counts were not found.")

        if warnings and status == "PARSED":
            status = "PARTIAL"
        response = TurnitinParseResponse(
            status=status,
            reportType=report_type,
            metadata=metadata,
            scores=scores,
            filters=filters,
            sources=sources,
            segments=segments,
            warnings=warnings,
            documentText=document_text,
        )
        return response
    finally:
        document.close()


def parse_turnitin_ocr_pages(page_texts: list[str]) -> TurnitinParseResponse:
    """Recover only readable report text fields; scanned visual structure is unknown."""
    from app.services.document_extraction import normalize_extracted_text

    normalized = [
        normalize_extracted_text(text, remove_nuls=True) for text in page_texts
    ]
    label_texts = [
        re.sub(r"\bA[Il1]\s+writing\b", "AI writing", text, flags=re.IGNORECASE)
        for text in normalized
    ]
    metadata = parse_metadata(normalized)
    report_type = detect_report_type(label_texts)
    warnings = [
        "OCR text cannot recover exact highlight colors, vector highlights, "
        "or source bounding boxes."
    ]
    filters: list[str] = []
    if report_type == "AI_WRITING":
        scores = parse_ai_scores(label_texts)
        sources = []
    elif report_type == "SIMILARITY":
        scores, filters = parse_similarity_scores(normalized)
        metadata["filters"] = filters
        sources = []
    else:
        scores = {}
        sources = []

    if report_type == "AI_WRITING" and "aiWriting" not in scores:
        warnings.append("The AI-writing percentage was not recoverable from OCR text.")
    if report_type == "SIMILARITY" and "similarity" not in scores:
        warnings.append(
            "The overall similarity percentage was not recoverable from OCR text."
        )
    if report_type == "SIMILARITY":
        warnings.append(
            "Source rows were not synthesized because OCR has no "
            "verified source layout."
        )
    warnings.append("Scanned report segments and bounding boxes were not synthesized.")

    recovered_score = bool(scores)
    recovered_identity = bool(
        metadata.get("submissionId") or metadata.get("submissionFileName")
    )
    status = (
        "PARTIAL"
        if report_type in {"AI_WRITING", "SIMILARITY"}
        and (recovered_score or recovered_identity)
        else "OCR_REQUIRED"
    )
    return TurnitinParseResponse(
        status=status,
        reportType=report_type,
        parserVersion="f003-ocr-v1",
        metadata=metadata,
        scores=scores,
        filters=filters,
        sources=sources,
        segments=[],
        warnings=warnings,
        documentText="\n\n".join(normalized),
    )
