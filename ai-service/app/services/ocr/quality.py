import re
import unicodedata


def character_error_rate(expected: str, actual: str) -> float:
    reference = _normalize(expected)
    hypothesis = _normalize(actual)
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return _edit_distance(reference, hypothesis) / len(reference)


def word_error_rate(expected: str, actual: str) -> float:
    reference = _words(expected)
    hypothesis = _words(actual)
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return _edit_distance(reference, hypothesis) / len(reference)


def _normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).casefold().split())


def _words(value: str) -> list[str]:
    return re.findall(r"\w+", unicodedata.normalize("NFC", value).casefold())


def _edit_distance(reference: str | list[str], hypothesis: str | list[str]) -> int:
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference
    previous = list(range(len(hypothesis) + 1))
    for ref_index, ref_item in enumerate(reference, start=1):
        current = [ref_index]
        for hyp_index, hyp_item in enumerate(hypothesis, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[hyp_index] + 1,
                    previous[hyp_index - 1] + (ref_item != hyp_item),
                )
            )
        previous = current
    return previous[-1]
