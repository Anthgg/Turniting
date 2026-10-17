"""Paragraph splitting with offsets into the original text.

Handles text extracted from DOCX (one paragraph per line or blank-line separated), PDF
(hard-wrapped lines, form feed page breaks) and OCR reconstructions. Offsets always point
into the exact input string; the scoring text is the paragraph with whitespace collapsed.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass

BLANK_LINE = re.compile(r"\n[ \t\r\f\v]*\n")
SENTENCE_END = re.compile(r"[.!?:;»\")\]]\s*$")
LIST_ITEM = re.compile(r"^\s*(?:[-•*·▪]|\d{1,3}[.)]|[a-zA-Z][.)])\s+")
SPACE = re.compile(r"\s+")


@dataclass
class Paragraph:
    index: int
    char_start: int
    char_end: int
    page_number: int | None
    text: str  # whitespace-collapsed content used for scoring
    text_hash: str
    normalized_hash: str
    words: int


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalized_key(text: str) -> str:
    t = unicodedata.normalize("NFKC", text).lower()
    t = re.sub(r"[^\w\s]", "", t)
    return SPACE.sub(" ", t).strip()


def _line_spans(block: str, base: int) -> list[tuple[int, int]]:
    spans, pos = [], 0
    for line in block.split("\n"):
        spans.append((base + pos, base + pos + len(line)))
        pos += len(line) + 1
    return spans


def _merge_wrapped_lines(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """Single-newline separated lines: join hard wraps, break where a line ends a sentence
    and the next one starts a new paragraph (capital letter after short line, list item)."""
    lines = [
        (s, e) for s, e in _line_spans(text[start:end], start) if text[s:e].strip()
    ]
    if len(lines) <= 1:
        return lines
    lengths = sorted(e - s for s, e in lines)
    typical = lengths[int(len(lengths) * 0.75)]
    # DOCX-like text: lines are already paragraphs (they end a sentence or are short headings)
    ends = sum(
        1 for s, e in lines if SENTENCE_END.search(text[s:e].rstrip()) or (e - s) < 40
    )
    line_paragraphs = ends / len(lines) > 0.6
    out, cur = [], [lines[0]]
    for prev, line in zip(lines, lines[1:]):
        prev_text, nxt = (
            text[prev[0] : prev[1]].rstrip(),
            text[line[0] : line[1]].lstrip(),
        )
        short_prev = (prev[1] - prev[0]) < 0.75 * typical
        breaks = (
            SENTENCE_END.search(prev_text) and (short_prev or nxt[:1].isupper())
        ) or LIST_ITEM.match(nxt)
        if line_paragraphs:
            breaks = True
        if breaks:
            out.append((cur[0][0], cur[-1][1]))
            cur = [line]
        else:
            cur.append(line)
    out.append((cur[0][0], cur[-1][1]))
    return out


def split_paragraphs(text: str) -> list[Paragraph]:
    spans: list[tuple[int, int]] = []
    pos = 0
    blocks = []
    for m in BLANK_LINE.finditer(text):
        blocks.append((pos, m.start()))
        pos = m.end()
    blocks.append((pos, len(text)))
    for s, e in blocks:
        if not text[s:e].strip():
            continue
        if "\n" in text[s:e].strip("\n"):
            spans.extend(_merge_wrapped_lines(text, s, e))
        else:
            spans.append((s, e))
    page_breaks = [m.start() for m in re.finditer("\f", text)]
    paragraphs = []
    for s, e in spans:
        raw = text[s:e]
        lead = len(raw) - len(raw.lstrip())
        trail = len(raw) - len(raw.rstrip())
        s2, e2 = s + lead, e - trail
        content = SPACE.sub(" ", text[s2:e2]).strip()
        if not content:
            continue
        page = (sum(1 for b in page_breaks if b < s2) + 1) if page_breaks else None
        paragraphs.append(
            Paragraph(
                index=len(paragraphs),
                char_start=s2,
                char_end=e2,
                page_number=page,
                text=content,
                text_hash=text_hash(content),
                normalized_hash=text_hash(normalized_key(content)),
                words=len(content.split()),
            )
        )
    return paragraphs
