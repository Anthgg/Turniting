import re
from typing import Any

import pymupdf

from app.core.config import Settings
from app.services.ocr.preprocess import visual_ink_ratio
from app.services.ocr.schemas import ExtractionMethod, PageAnalysis, PageClassification
from app.services.text_normalization import normalize_extracted_text


def classify_page_for_ocr(page: pymupdf.Page, settings: Settings) -> PageAnalysis:
    """Classify a PDF page from text quality, raster coverage, and visible content."""
    try:
        rectangle = page.rect
        digital_text = normalize_extracted_text(
            page.get_text("text", sort=False), remove_nuls=True
        )
        image_area_ratio = _image_area_ratio(page, rectangle)
        if _digital_is_sufficient(digital_text, settings):
            return PageAnalysis(
                pageNumber=page.number + 1,
                classification=PageClassification.DIGITAL_OK,
                width=float(rectangle.width),
                height=float(rectangle.height),
                rotation=int(page.rotation),
                digitalText=digital_text,
                canonicalText=digital_text,
                extractionMethod=ExtractionMethod.DIGITAL,
                requiresOcr=False,
                imageAreaRatio=image_area_ratio,
            )

        visual_ink = _pdf_visual_ink(page)
        if visual_ink < settings.ocr_blank_page_threshold:
            if digital_text.strip():
                return PageAnalysis(
                    pageNumber=page.number + 1,
                    classification=PageClassification.UNREADABLE,
                    width=float(rectangle.width),
                    height=float(rectangle.height),
                    rotation=int(page.rotation),
                    digitalText=digital_text,
                    canonicalText=digital_text,
                    extractionMethod=ExtractionMethod.DIGITAL,
                    requiresOcr=False,
                    imageAreaRatio=image_area_ratio,
                    warnings=[
                        "Short digital text was retained; "
                        "no additional visual text was detected."
                    ],
                )
            return PageAnalysis(
                pageNumber=page.number + 1,
                classification=PageClassification.BLANK,
                width=float(rectangle.width),
                height=float(rectangle.height),
                rotation=int(page.rotation),
                digitalText=digital_text,
                canonicalText="",
                extractionMethod=ExtractionMethod.NONE,
                requiresOcr=False,
                imageAreaRatio=image_area_ratio,
            )

        has_scan_image = image_area_ratio >= settings.ocr_image_area_ratio
        if not has_scan_image:
            classification = PageClassification.UNREADABLE
            requires_ocr = False
        elif digital_text.strip():
            classification = PageClassification.HYBRID_CANDIDATE
            requires_ocr = True
        else:
            classification = PageClassification.OCR_REQUIRED
            requires_ocr = True

        return PageAnalysis(
            pageNumber=page.number + 1,
            classification=classification,
            width=float(rectangle.width),
            height=float(rectangle.height),
            rotation=int(page.rotation),
            digitalText=digital_text,
            canonicalText=digital_text,
            extractionMethod=(
                ExtractionMethod.DIGITAL if digital_text else ExtractionMethod.NONE
            ),
            requiresOcr=requires_ocr,
            imageAreaRatio=image_area_ratio,
            warnings=(
                ["The page contains visual content with only partial digital text."]
                if classification == PageClassification.HYBRID_CANDIDATE
                else []
            ),
        )
    except Exception:
        return PageAnalysis(
            pageNumber=page.number + 1,
            classification=PageClassification.UNREADABLE,
            width=0,
            height=0,
            rotation=int(getattr(page, "rotation", 0)),
            digitalText="",
            canonicalText="",
            extractionMethod=ExtractionMethod.NONE,
            requiresOcr=False,
            warnings=["The page could not be analyzed safely."],
        )


def classify_raster_page(
    image: Any,
    *,
    page_number: int,
    settings: Settings,
    rotation: int = 0,
) -> PageAnalysis:
    height, width = image.shape[:2]
    ink = visual_ink_ratio(image)
    is_blank = ink < settings.ocr_blank_page_threshold
    return PageAnalysis(
        pageNumber=page_number,
        classification=(
            PageClassification.BLANK if is_blank else PageClassification.OCR_REQUIRED
        ),
        width=float(width),
        height=float(height),
        rotation=rotation,
        digitalText="",
        canonicalText="",
        extractionMethod=ExtractionMethod.NONE,
        requiresOcr=not is_blank,
        imageAreaRatio=1.0,
    )


def _image_area_ratio(page: pymupdf.Page, rectangle: pymupdf.Rect) -> float:
    page_area = max(float(rectangle.width * rectangle.height), 1.0)
    covered = 0.0
    for item in page.get_image_info(xrefs=True):
        bbox = item.get("bbox")
        if not bbox:
            continue
        image_rect = pymupdf.Rect(bbox) & rectangle
        covered += max(float(image_rect.width * image_rect.height), 0.0)
    return min(covered / page_area, 1.0)


def _digital_is_sufficient(text: str, settings: Settings) -> bool:
    stripped = text.strip()
    if len(stripped) < settings.ocr_min_digital_chars:
        return False
    if (
        len(re.findall(r"\b\w+\b", stripped, flags=re.UNICODE))
        < settings.ocr_min_digital_words
    ):
        return False
    replacement_count = stripped.count("\ufffd")
    control_count = sum(ord(char) < 32 and char not in "\n\r\t\f" for char in stripped)
    return (replacement_count + control_count) / max(len(stripped), 1) <= 0.02


def _pdf_visual_ink(page: pymupdf.Page) -> float:
    pixmap = page.get_pixmap(
        matrix=pymupdf.Matrix(0.5, 0.5),
        colorspace=pymupdf.csGRAY,
        alpha=False,
    )
    try:
        import numpy as np

        pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
            pixmap.height, pixmap.width
        )
        return visual_ink_ratio(pixels)
    finally:
        del pixmap
