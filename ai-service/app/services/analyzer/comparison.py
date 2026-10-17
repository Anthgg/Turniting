"""Paragraph alignment between two versions of a document."""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

from rapidfuzz import fuzz

from app.services.analyzer.paragraphs import Paragraph

UNCHANGED, MODIFIED, ADDED, REMOVED = "UNCHANGED", "MODIFIED", "ADDED", "REMOVED"


@dataclass
class Alignment:
    status: str
    base_index: int | None
    target_index: int | None
    similarity: float
    match: str  # exact_hash | normalized_hash | similarity | none


def align_paragraphs(
    base: list[Paragraph], target: list[Paragraph], min_similarity: float = 0.55
) -> list[Alignment]:
    """Order-preserving alignment: identical (or whitespace/punctuation-identical) paragraphs
    are UNCHANGED; inside the remaining gaps paragraphs are paired greedily by similarity."""
    a = [p.normalized_hash for p in base]
    b = [p.normalized_hash for p in target]
    out: list[Alignment] = []
    sm = SequenceMatcher(a=a, b=b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for i, j in zip(range(i1, i2), range(j1, j2)):
                exact = base[i].text_hash == target[j].text_hash
                out.append(
                    Alignment(
                        UNCHANGED,
                        i,
                        j,
                        1.0,
                        "exact_hash" if exact else "normalized_hash",
                    )
                )
            continue
        left, right = list(range(i1, i2)), list(range(j1, j2))
        pairs = sorted(
            (
                (fuzz.ratio(base[i].text, target[j].text) / 100.0, i, j)
                for i in left
                for j in right
            ),
            reverse=True,
        )
        used_i, used_j, matched = set(), set(), {}
        for sim, i, j in pairs:
            if sim < min_similarity or i in used_i or j in used_j:
                continue
            used_i.add(i)
            used_j.add(j)
            matched[j] = (i, sim)
        for i in left:
            if i not in used_i:
                out.append(Alignment(REMOVED, i, None, 0.0, "none"))
        for j in right:
            if j in matched:
                i, sim = matched[j]
                out.append(Alignment(MODIFIED, i, j, round(sim, 4), "similarity"))
            else:
                out.append(Alignment(ADDED, None, j, 0.0, "none"))
    return out


def document_similarity(base: list[Paragraph], target: list[Paragraph]) -> float:
    a = " ".join(p.text for p in base)
    b = " ".join(p.text for p in target)
    if not a and not b:
        return 1.0
    return round(fuzz.ratio(a, b) / 100.0, 4)
