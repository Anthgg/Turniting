import re
import unicodedata
from difflib import SequenceMatcher
from typing import Literal

from pydantic import BaseModel, Field

try:
    from rapidfuzz import fuzz
except (
    ImportError
):  # Keep local parsing usable before optional dependency installation.
    fuzz = None

MatchStatus = Literal["UNVERIFIED", "EXACT", "HIGH", "PARTIAL", "MISMATCH"]

# Centralized content-identity thresholds; these describe text overlap only.
MIN_COMPARABLE_CHARS = 200
HIGH_MATCH_RATIO = 0.88
PARTIAL_MATCH_RATIO = 0.60
SUBSTRING_MIN_COVERAGE = 0.85
SEGMENT_FUZZY_THRESHOLD = 0.78


class SegmentAlignment(BaseModel):
    segmentIndex: int
    documentStartOffset: int | None = None
    documentEndOffset: int | None = None
    alignmentMethod: str = "unmatched"
    alignmentScore: float | None = None


class AlignmentResult(BaseModel):
    matchStatus: MatchStatus
    similarityRatio: float | None = None
    method: str
    matchedChars: int = 0
    documentCharacterCount: int = 0
    reportCharacterCount: int = 0
    signals: list[str] = Field(default_factory=list)
    segmentAlignments: list[SegmentAlignment] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


def normalize_with_offsets(value: str) -> tuple[str, list[int]]:
    normalized: list[str] = []
    offsets: list[int] = []
    for index, original in enumerate(value):
        if original == "\ufffd":
            continue
        folded = unicodedata.normalize("NFKD", original.casefold())
        for character in folded:
            if unicodedata.combining(character):
                continue
            output = character if character.isalnum() else " "
            if output == " " and (not normalized or normalized[-1] == " "):
                continue
            normalized.append(output)
            offsets.append(index)
    while normalized and normalized[-1] == " ":
        normalized.pop()
        offsets.pop()
    return "".join(normalized), offsets


def _ratio(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if fuzz is not None:
        return float(fuzz.ratio(left, right)) / 100.0
    return SequenceMatcher(None, left, right, autojunk=True).ratio()


def _partial_alignment(query: str, target: str) -> tuple[float, int, int]:
    if not query or not target:
        return 0.0, -1, -1
    if fuzz is not None and hasattr(fuzz, "partial_ratio_alignment"):
        result = fuzz.partial_ratio_alignment(query, target)
        return float(result.score) / 100.0, result.dest_start, result.dest_end
    matcher = SequenceMatcher(None, query, target, autojunk=True)
    match = matcher.find_longest_match(0, len(query), 0, len(target))
    return match.size / max(1, len(query)), match.b, match.b + match.size


def _metadata_signals(
    document_metadata: dict[str, object] | None,
    report_metadata: dict[str, object] | None,
) -> list[str]:
    document = document_metadata or {}
    report = report_metadata or {}
    signals: list[str] = []
    word_count = document.get("wordCount")
    report_word_count = report.get("wordCount")
    if isinstance(word_count, int) and isinstance(report_word_count, int):
        tolerance = max(5, round(word_count * 0.015))
        if abs(word_count - report_word_count) <= tolerance:
            signals.append("word_count_close")
    char_count = document.get("characterCount")
    report_char_count = report.get("characterCount")
    if isinstance(char_count, int) and isinstance(report_char_count, int):
        tolerance = max(100, round(char_count * 0.03))
        if abs(char_count - report_char_count) <= tolerance:
            signals.append("character_count_close")
    document_name = document.get("originalName")
    report_name = report.get("submissionFileName")
    if isinstance(document_name, str) and isinstance(report_name, str):
        left_name = re.sub(r"\.[a-z0-9]{1,8}$", "", document_name.casefold())
        right_name = re.sub(r"\.[a-z0-9]{1,8}$", "", report_name.casefold())
        left_name, _ = normalize_with_offsets(left_name)
        right_name, _ = normalize_with_offsets(right_name)
        if left_name and left_name == right_name:
            signals.append("title_exact")
        elif left_name and right_name and _ratio(left_name, right_name) >= 0.8:
            signals.append("title_similar")
    return signals


def _segment_alignment(
    document_text: str,
    normalized_document: str,
    document_offsets: list[int],
    segment_index: int,
    segment_text: str,
) -> SegmentAlignment:
    raw_start = document_text.find(segment_text)
    if raw_start >= 0:
        return SegmentAlignment(
            segmentIndex=segment_index,
            documentStartOffset=raw_start,
            documentEndOffset=raw_start + len(segment_text),
            alignmentMethod="exact_substring",
            alignmentScore=1.0,
        )

    normalized_segment, _ = normalize_with_offsets(segment_text)
    if len(normalized_segment) < 12:
        return SegmentAlignment(segmentIndex=segment_index)
    normalized_start = normalized_document.find(normalized_segment)
    if normalized_start >= 0:
        normalized_end = normalized_start + len(normalized_segment) - 1
        return SegmentAlignment(
            segmentIndex=segment_index,
            documentStartOffset=document_offsets[normalized_start],
            documentEndOffset=document_offsets[normalized_end] + 1,
            alignmentMethod="normalized_exact",
            alignmentScore=1.0,
        )

    best_score = 0.0
    best_range: tuple[int, int] | None = None
    for paragraph in re.finditer(r"[^\n]+", document_text):
        paragraph_text = paragraph.group(0)
        normalized_paragraph, paragraph_offsets = normalize_with_offsets(paragraph_text)
        score, start, end = _partial_alignment(normalized_segment, normalized_paragraph)
        if score > best_score and 0 <= start < end <= len(paragraph_offsets):
            best_score = score
            best_range = (
                paragraph.start() + paragraph_offsets[start],
                paragraph.start() + paragraph_offsets[end - 1] + 1,
            )
    if best_range and best_score >= SEGMENT_FUZZY_THRESHOLD:
        return SegmentAlignment(
            segmentIndex=segment_index,
            documentStartOffset=best_range[0],
            documentEndOffset=best_range[1],
            alignmentMethod="paragraph_fuzzy",
            alignmentScore=round(best_score, 4),
        )
    return SegmentAlignment(
        segmentIndex=segment_index,
        alignmentMethod="unmatched",
        alignmentScore=round(best_score, 4) if best_score else None,
    )


def align_report_to_document(
    document_text: str,
    report_text: str,
    segments: list[dict[str, str | int]] | None = None,
    document_metadata: dict[str, object] | None = None,
    report_metadata: dict[str, object] | None = None,
) -> AlignmentResult:
    signals = _metadata_signals(document_metadata, report_metadata)
    normalized_document, document_offsets = normalize_with_offsets(document_text)
    normalized_report, _ = normalize_with_offsets(report_text)
    if min(len(normalized_document), len(normalized_report)) < MIN_COMPARABLE_CHARS:
        return AlignmentResult(
            matchStatus="UNVERIFIED",
            method="insufficient_text",
            documentCharacterCount=len(document_text),
            reportCharacterCount=len(report_text),
            signals=signals,
            warnings=[
                "At least 200 normalized characters are required for content matching."
            ],
        )

    ratio = _ratio(normalized_document, normalized_report)
    shorter, longer = sorted((normalized_document, normalized_report), key=len)
    coverage = len(shorter) / max(1, len(longer))
    method = "normalized_fuzzy"
    if normalized_document == normalized_report:
        status: MatchStatus = "EXACT"
        ratio = 1.0
        method = "normalized_exact"
        matched_chars = min(len(document_text), len(report_text))
    elif shorter in longer and coverage >= SUBSTRING_MIN_COVERAGE:
        status = "EXACT"
        ratio = coverage
        method = "exact_substring"
        matched_chars = len(shorter)
    else:
        partial_ratio, _, _ = _partial_alignment(shorter, longer)
        if partial_ratio >= 0.95 and coverage >= SUBSTRING_MIN_COVERAGE:
            status = "HIGH"
            ratio = max(ratio, coverage)
            method = "fuzzy_substring"
            matched_chars = round(coverage * max(len(document_text), len(report_text)))
        elif ratio >= HIGH_MATCH_RATIO:
            status = "HIGH"
            method = "normalized_fuzzy"
            matched_chars = round(ratio * max(len(document_text), len(report_text)))
        elif ratio >= 0.80 and any(
            signal in signals for signal in ("word_count_close", "title_exact")
        ):
            status = "HIGH"
            method = "content_and_metadata"
            matched_chars = round(ratio * min(len(document_text), len(report_text)))
        elif ratio >= PARTIAL_MATCH_RATIO or partial_ratio >= 0.75:
            status = "PARTIAL"
            method = "paragraph_similarity"
            ratio = max(ratio, partial_ratio * coverage)
            matched_chars = round(
                partial_ratio * min(len(document_text), len(report_text))
            )
        else:
            status = "MISMATCH"
            method = "normalized_fuzzy"
            matched_chars = round(ratio * min(len(document_text), len(report_text)))

    aligned_segments = [
        _segment_alignment(
            document_text,
            normalized_document,
            document_offsets,
            int(segment.get("segmentIndex", index + 1)),
            str(segment.get("text", "")),
        )
        for index, segment in enumerate(segments or [])
    ]
    return AlignmentResult(
        matchStatus=status,
        similarityRatio=round(ratio, 4),
        method=method,
        matchedChars=matched_chars,
        documentCharacterCount=len(document_text),
        reportCharacterCount=len(report_text),
        signals=signals,
        segmentAlignments=aligned_segments,
        warnings=[],
    )
