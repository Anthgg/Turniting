import time
from collections.abc import Sequence

import pymupdf

from app.core.config import Settings
from app.services.ocr.detector import classify_page_for_ocr, classify_raster_page
from app.services.ocr.exceptions import OcrProcessingError
from app.services.ocr.merge import deduplicate_hybrid, normalize_ocr_text
from app.services.ocr.paddle_engine import engine
from app.services.ocr.preprocess import preprocess_image
from app.services.ocr.renderer import load_image, render_pdf_page
from app.services.ocr.schemas import (
    ExtractionMethod,
    OcrPageResult,
    PageAnalysis,
    PageClassification,
    ProcessResponse,
)

PDF_MIME = "application/pdf"
PNG_MIME = "image/png"
JPEG_MIME = "image/jpeg"


def analyze_document(
    content_type: str | None,
    content: bytes,
    settings: Settings,
) -> list[PageAnalysis]:
    media_type = (content_type or "").split(";", maxsplit=1)[0].strip().lower()
    if media_type == PDF_MIME:
        if not content.startswith(b"%PDF"):
            raise OcrProcessingError(
                "OCR_UNSUPPORTED_FORMAT", "The file is not a valid PDF.", 415
            )
        document = None
        try:
            document = pymupdf.open(stream=content, filetype="pdf")
            if document.needs_pass:
                raise OcrProcessingError(
                    "OCR_UNSUPPORTED_FORMAT",
                    "Encrypted PDF files are not supported.",
                    422,
                )
            if document.page_count < 1:
                raise OcrProcessingError(
                    "OCR_PROCESSING_FAILED", "The PDF does not contain any pages.", 422
                )
            return [classify_page_for_ocr(page, settings) for page in document]
        except OcrProcessingError:
            raise
        except Exception:
            raise OcrProcessingError(
                "OCR_PROCESSING_FAILED",
                "The PDF is invalid or could not be analyzed.",
                422,
            ) from None
        finally:
            if document is not None:
                document.close()

    if media_type in {PNG_MIME, JPEG_MIME}:
        image, actual_format = load_image(
            content, max_pixels=settings.ocr_max_render_pixels
        )
        expected_format = "png" if media_type == PNG_MIME else "jpeg"
        if actual_format != expected_format:
            raise OcrProcessingError(
                "OCR_UNSUPPORTED_FORMAT",
                "The image content does not match its declared MIME type.",
                415,
            )
        return [classify_raster_page(image, page_number=1, settings=settings)]

    raise OcrProcessingError(
        "OCR_UNSUPPORTED_FORMAT",
        "OCR supports PDF, PNG, and JPEG input files.",
        415,
    )


def process_document_ocr(
    content_type: str | None,
    content: bytes,
    settings: Settings,
    *,
    requested_pages: Sequence[int] | None = None,
    force: bool = False,
) -> ProcessResponse:
    started = time.perf_counter()
    pages = analyze_document(content_type, content, settings)
    page_by_number = {page.page_number: page for page in pages}
    if requested_pages is not None:
        normalized_requested = sorted(set(requested_pages))
        if any(number not in page_by_number for number in normalized_requested):
            raise OcrProcessingError(
                "OCR_PROCESSING_FAILED", "A requested page number is invalid.", 422
            )
    else:
        normalized_requested = [page.page_number for page in pages if page.requires_ocr]

    if force:
        selected = [
            number
            for number in normalized_requested
            if page_by_number[number].classification != PageClassification.BLANK
        ]
    else:
        selected = [
            number
            for number in normalized_requested
            if page_by_number[number].requires_ocr
        ]
    if not selected:
        raise OcrProcessingError("OCR_NOT_REQUIRED", "No pages require OCR.", 409)
    if len(selected) > settings.ocr_max_pages_per_run:
        raise OcrProcessingError(
            "OCR_PAGE_LIMIT_EXCEEDED",
            f"The request exceeds the {settings.ocr_max_pages_per_run}-page OCR limit.",
            413,
        )

    if not engine.ready:
        engine.warmup(settings)
    image_input = (content_type or "").split(";", maxsplit=1)[0].strip().lower() in {
        PNG_MIME,
        JPEG_MIME,
    }
    raster_image = (
        load_image(content, max_pixels=settings.ocr_max_render_pixels)[0]
        if image_input
        else None
    )
    document = None
    if not image_input:
        try:
            document = pymupdf.open(stream=content, filetype="pdf")
        except Exception:
            raise OcrProcessingError(
                "OCR_PROCESSING_FAILED", "The PDF could not be opened for OCR.", 422
            ) from None

    results: list[OcrPageResult] = []
    weighted_confidence = 0.0
    confidence_characters = 0
    warnings: list[str] = []
    pages_processed = 0
    pages_failed = 0
    deadline = started + settings.ocr_timeout_ms / 1000
    try:
        for page_analysis in pages:
            page_number = page_analysis.page_number
            if page_number not in selected:
                results.append(OcrPageResult(**page_analysis.model_dump()))
                continue
            if time.monotonic() > deadline:
                pages_failed += 1
                results.append(
                    _page_failure(page_analysis, "OCR_TIMEOUT", "OCR timed out.")
                )
                continue

            page_started = time.perf_counter()
            try:
                if image_input:
                    image = raster_image
                    dpi_used = None
                else:
                    if document is None:
                        raise OcrProcessingError(
                            "OCR_PROCESSING_FAILED", "The PDF is unavailable.", 422
                        )
                    image, dpi_used = render_pdf_page(
                        document[page_number - 1],
                        dpi=settings.ocr_dpi,
                        max_pixels=settings.ocr_max_render_pixels,
                    )
                if image is None:
                    raise OcrProcessingError(
                        "OCR_PROCESSING_FAILED",
                        "The page image could not be loaded.",
                        422,
                    )
                prepared = preprocess_image(image, settings)
                blocks, detected_angle = engine.recognize(
                    prepared.image,
                    settings=settings,
                    page_width=page_analysis.width,
                    page_height=page_analysis.height,
                )
                if not blocks:
                    raise OcrProcessingError(
                        "OCR_LOW_CONFIDENCE",
                        "No readable text blocks were recognized on this page.",
                        422,
                    )

                ocr_text = normalize_ocr_text("\n".join(block.text for block in blocks))
                canonical, blocks = deduplicate_hybrid(
                    page_analysis.digital_text, blocks
                )
                if page_analysis.digital_text and ocr_text:
                    method = (
                        ExtractionMethod.DIGITAL
                        if all(block.duplicate_of_digital for block in blocks)
                        else ExtractionMethod.HYBRID
                    )
                elif ocr_text:
                    method = ExtractionMethod.OCR
                elif page_analysis.digital_text:
                    method = ExtractionMethod.DIGITAL
                else:
                    method = ExtractionMethod.NONE
                confidence, chars = _weighted_page_confidence(blocks)
                page_warnings = list(page_analysis.warnings)
                if any(block.low_confidence for block in blocks):
                    page_warnings.append(
                        "Some recognized text blocks have low confidence."
                    )
                if prepared.contrast_enhanced:
                    page_warnings.append("Low contrast enhancement was applied.")
                if detected_angle not in (None, 0):
                    page_warnings.append(
                        "Document orientation correction reported "
                        f"{detected_angle} degrees."
                    )
                if dpi_used is not None and dpi_used < settings.ocr_dpi:
                    page_warnings.append(
                        f"Render DPI reduced to {dpi_used} to respect the pixel limit."
                    )
                page_data = page_analysis.model_dump()
                page_data.update(
                    {
                        "ocr_text": ocr_text,
                        "canonical_text": canonical,
                        "extraction_method": method,
                        "requires_ocr": False,
                        "confidence": confidence,
                        "blocks": blocks,
                        "deskew_angle": prepared.deskew_angle,
                        "processing_ms": round(
                            (time.perf_counter() - page_started) * 1000
                        ),
                        "warnings": page_warnings,
                    }
                )
                results.append(OcrPageResult(**page_data))
                pages_processed += 1
                if confidence is not None and chars > 0:
                    weighted_confidence += confidence * chars
                    confidence_characters += chars
                warnings.extend(page_warnings)
                del prepared, image
            except OcrProcessingError as error:
                pages_failed += 1
                results.append(_page_failure(page_analysis, error.code, error.message))
                warnings.append(f"Page {page_number}: OCR could not be completed.")
            except Exception:
                pages_failed += 1
                results.append(
                    _page_failure(
                        page_analysis,
                        "OCR_PROCESSING_FAILED",
                        "OCR could not be completed for this page.",
                    )
                )
                warnings.append(f"Page {page_number}: OCR could not be completed.")
    finally:
        if document is not None:
            document.close()

    if pages_failed:
        warnings.append("One or more pages still require OCR.")
    metadata = engine.metadata(settings)
    return ProcessResponse(
        **metadata,
        pages=results,
        pagesRequested=len(selected),
        pagesProcessed=pages_processed,
        pagesSkipped=max(len(pages) - len(selected), 0),
        pagesFailed=pages_failed,
        averageConfidence=(
            weighted_confidence / confidence_characters
            if confidence_characters
            else None
        ),
        durationMs=round((time.perf_counter() - started) * 1000),
        warnings=_unique(warnings),
    )


def _weighted_page_confidence(blocks) -> tuple[float | None, int]:
    weighted = 0.0
    character_count = 0
    for block in blocks:
        if block.confidence is None:
            continue
        count = len(block.text)
        weighted += block.confidence * count
        character_count += count
    return (weighted / character_count if character_count else None, character_count)


def _page_failure(
    page: PageAnalysis,
    code: str,
    message: str,
) -> OcrPageResult:
    page_data = page.model_dump()
    page_data.update(
        {
            "ocr_text": None,
            "canonical_text": page.canonical_text,
            "requires_ocr": True,
            "ocr_error_code": code,
            "warnings": [*page.warnings, message],
        }
    )
    return OcrPageResult(**page_data)


def _unique(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))
