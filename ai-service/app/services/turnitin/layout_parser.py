import math
import re
from collections.abc import Iterable
from typing import Any

import pymupdf

from app.services.turnitin.normalization import (
    fold_for_matching,
    normalize_document_text,
)
from app.services.turnitin.schemas import ParsedSegment, ReportType
from app.services.turnitin.similarity_parser import SOURCE_PALETTE

AI_HIGHLIGHT_COLORS = ((0.32, 0.78, 0.86),)
SIMILARITY_HIGHLIGHT_COLORS = tuple(SOURCE_PALETTE)
AI_COLOR_HEX = "#52C7DB"


def _header_marker(report_type: ReportType) -> str:
    if report_type == "AI_WRITING":
        return "entrega de escritura con ia"
    if report_type == "SIMILARITY":
        return "entrega de integridad"
    return ""


def _first_document_page(page_texts: list[str], report_type: ReportType) -> int:
    marker = _header_marker(report_type)
    if marker:
        for index, text in enumerate(page_texts):
            if marker in fold_for_matching(text):
                return index
    return 0


def _is_report_chrome(text: str) -> bool:
    folded = fold_for_matching(text)
    return bool(
        "turnitin" in folded
        or "identificador de la entrega" in folded
        or "trn:oid" in folded
        or re.search(r"p.{0,1}gina\s+\d+\s+de\s+\d+", folded)
    )


def _close_color(left: tuple[float, ...], right: tuple[float, ...]) -> bool:
    return len(left) == len(right) and all(
        math.isclose(a, b, abs_tol=0.025) for a, b in zip(left, right)
    )


def _overlap_ratio(box: pymupdf.Rect, target: pymupdf.Rect) -> float:
    intersection = box & target
    if intersection.is_empty:
        return 0.0
    area = max(1.0, box.width * box.height)
    return (intersection.width * intersection.height) / area


def _target_colors(report_type: ReportType) -> tuple[tuple[float, ...], ...]:
    if report_type == "AI_WRITING":
        return AI_HIGHLIGHT_COLORS
    if report_type == "SIMILARITY":
        return SIMILARITY_HIGHLIGHT_COLORS
    return ()


def _hex_color(color: tuple[float, ...] | None) -> str | None:
    if color is None:
        return None
    return "#" + "".join(
        f"{max(0, min(255, round(value * 255))):02X}" for value in color[:3]
    )


def _page_lines(page: pymupdf.Page) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for block in page.get_text("dict", sort=True).get("blocks", []):
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = "".join(span.get("text", "") for span in spans)
            if not text.strip() or _is_report_chrome(text):
                continue
            boxes = [pymupdf.Rect(span["bbox"]) for span in spans if span.get("bbox")]
            if not boxes:
                continue
            box = boxes[0]
            for other in boxes[1:]:
                box |= other
            result.append({"text": text.strip(), "bbox": box})
    return result


def _highlight_rectangles(
    page: pymupdf.Page,
    report_type: ReportType,
) -> list[tuple[pymupdf.Rect, tuple[float, ...]]]:
    target_colors = _target_colors(report_type)
    result: list[tuple[pymupdf.Rect, tuple[float, ...]]] = []
    for drawing in page.get_drawings():
        fill = drawing.get("fill")
        rect = drawing.get("rect")
        if fill is None or rect is None:
            continue
        color = tuple(float(value) for value in fill[:3])
        if any(_close_color(color, target) for target in target_colors):
            result.append((pymupdf.Rect(rect), color))
    return result


def _source_index_for_color(color: tuple[float, ...] | None) -> int | None:
    if color is None:
        return None
    for palette, (index, _) in SOURCE_PALETTE.items():
        if _close_color(color, palette):
            return index
    return None


def _append_group(
    result: list[ParsedSegment],
    *,
    segment_type: str,
    page_number: int,
    text_parts: list[str],
    box: pymupdf.Rect,
    source_index: int | None,
    color: str | None,
) -> None:
    text = " ".join(part.strip() for part in text_parts if part.strip()).strip()
    if not text:
        return
    result.append(
        ParsedSegment(
            segmentIndex=len(result) + 1,
            segmentType=segment_type,  # type: ignore[arg-type]
            pageNumber=page_number,
            text=text[:12_000],
            normalizedText=normalize_document_text(text)[:12_000],
            bbox=[round(value, 2) for value in box],
            sourceIndex=source_index,
            color=color,
        )
    )


def parse_layout_segments(
    document: pymupdf.Document,
    page_texts: list[str],
    report_type: ReportType,
) -> tuple[list[ParsedSegment], str]:
    """Extract line-level visible text and map only visible highlight rectangles."""
    if report_type == "UNKNOWN":
        return [], ""

    start_page = _first_document_page(page_texts, report_type)
    segments: list[ParsedSegment] = []
    document_lines: list[str] = []
    current: dict[str, Any] | None = None

    def flush() -> None:
        nonlocal current
        if current is None:
            return
        _append_group(
            segments,
            segment_type=current["type"],
            page_number=current["page"],
            text_parts=current["parts"],
            box=current["bbox"],
            source_index=current["sourceIndex"],
            color=current["color"],
        )
        current = None

    for page_index in range(start_page, len(document)):
        page = document[page_index]
        lines = _page_lines(page)
        highlights = _highlight_rectangles(page, report_type)
        for line in lines:
            text = line["text"]
            box = line["bbox"]
            document_lines.append(text)
            best_ratio = 0.0
            best_color: tuple[float, ...] | None = None
            for rect, color in highlights:
                ratio = _overlap_ratio(box, rect)
                if ratio > best_ratio:
                    best_ratio = ratio
                    best_color = color
            is_flagged = best_ratio >= 0.18
            if report_type == "AI_WRITING":
                segment_type = "AI_FLAGGED" if is_flagged else "NOT_FLAGGED"
            else:
                segment_type = "SIMILARITY_MATCH" if is_flagged else "NOT_FLAGGED"
            source_index = (
                _source_index_for_color(best_color)
                if segment_type == "SIMILARITY_MATCH"
                else None
            )
            color = _hex_color(best_color) if is_flagged else None
            same_group = (
                current is not None
                and current["page"] == page_index + 1
                and current["type"] == segment_type
                and current["sourceIndex"] == source_index
                and current["color"] == color
                and box.y0 - current["bbox"].y1 <= 7.5
                and sum(len(part) for part in current["parts"]) + len(text) < 12_000
            )
            if not same_group:
                flush()
                current = {
                    "type": segment_type,
                    "page": page_index + 1,
                    "parts": [text],
                    "bbox": pymupdf.Rect(box),
                    "sourceIndex": source_index,
                    "color": color,
                }
            else:
                current["parts"].append(text)
                current["bbox"] |= box
    flush()
    if len(segments) > 10_000:
        segments = segments[:10_000]
        segments.append(
            ParsedSegment(
                segmentIndex=len(segments) + 1,
                segmentType="UNKNOWN",
                pageNumber=max(1, start_page + 1),
                text=(
                    "Remaining segments omitted because the parser safety limit "
                    "was reached."
                ),
                bbox=[0, 0, 0, 0],
            )
        )
    normalized_lines: Iterable[str] = (
        re.sub(r"\s+", " ", line).strip() for line in document_lines
    )
    return segments, "\n".join(line for line in normalized_lines if line)
