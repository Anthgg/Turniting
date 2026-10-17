"""Canonical text view for TURNITING_RESEARCH_V3 (dual-view training and inference).

The raw text is never replaced: datasets keep `text_original`, and this module derives a
second view used next to it. Rules (all deterministic, label-independent):

  * remove invisible format characters (zero-width space/joiners, BOM, word joiner, soft
    hyphen, bidi controls, variation selectors, tag characters);
  * map anomalous whitespace (NBSP, thin/hair/ideographic spaces, line/paragraph
    separators) to a plain space or newline and collapse runs of spaces;
  * fold full-width ASCII (U+FF01-FF5E) and mathematical alphanumeric letters to ASCII;
  * map Cyrillic/Greek confusables to Latin only inside words that already mix Latin
    letters with them (a genuine Russian or Greek word is left untouched);
  * NFC (not NFKC: compatibility folding would change legitimate typography).
"""

from __future__ import annotations

import re
import unicodedata

INVISIBLE = re.compile("[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\U000e0000-\U000e007f]")
ODD_SPACE = re.compile("[   -   　\t\x0b\x0c]")
LINE_SEP = re.compile("[  \u0085\r]")
MULTI_SPACE = re.compile(" {2,}")
SPACE_BEFORE_NL = re.compile(" +\n")

# Cyrillic / Greek / other letters that render like Latin ones.
CONFUSABLES = {
    "а": "a",
    "в": "B",
    "е": "e",
    "к": "k",
    "м": "M",
    "н": "H",
    "о": "o",
    "р": "p",
    "с": "c",
    "т": "T",
    "у": "y",
    "х": "x",
    "ѕ": "s",
    "і": "i",
    "ј": "j",
    "ԁ": "d",
    "ԛ": "q",
    "ԝ": "w",
    "һ": "h",
    "А": "A",
    "В": "B",
    "Е": "E",
    "К": "K",
    "М": "M",
    "Н": "H",
    "О": "O",
    "Р": "P",
    "С": "C",
    "Т": "T",
    "У": "Y",
    "Х": "X",
    "Ѕ": "S",
    "І": "I",
    "Ј": "J",
    "Ԁ": "D",
    "α": "a",
    "ο": "o",
    "ρ": "p",
    "ν": "v",
    "υ": "u",
    "ι": "i",
    "κ": "k",
    "τ": "t",
    "χ": "x",
    "Α": "A",
    "Β": "B",
    "Ε": "E",
    "Ζ": "Z",
    "Η": "H",
    "Ι": "I",
    "Κ": "K",
    "Μ": "M",
    "Ν": "N",
    "Ο": "O",
    "Ρ": "P",
    "Τ": "T",
    "Υ": "Y",
    "Χ": "X",
    "ℓ": "l",
    "ⅼ": "l",
    "ⅰ": "i",
    "Ⅰ": "I",
}
_CONF_CLASS = "".join(sorted(CONFUSABLES))
WORD = re.compile(r"[\w" + re.escape(_CONF_CLASS) + r"]+", re.UNICODE)
LATIN = re.compile(r"[A-Za-zÀ-ɏ]")
CONF_RE = re.compile("[" + re.escape(_CONF_CLASS) + "]")


def _fold_char(ch: str) -> str:
    o = ord(ch)
    if 0xFF01 <= o <= 0xFF5E:  # full-width ASCII
        return chr(o - 0xFEE0)
    if (
        0x1D400 <= o <= 0x1D7FF
    ):  # mathematical alphanumerics -> NFKC gives the plain letter/digit
        return unicodedata.normalize("NFKC", ch)
    return ch


_FOLD_RE = re.compile("[！-～\U0001d400-\U0001d7ff]")


def _demix(match: re.Match) -> str:
    word = match.group(0)
    if CONF_RE.search(word) and LATIN.search(word):
        return "".join(CONFUSABLES.get(c, c) for c in word)
    return word


def canonicalize(text: str) -> str:
    if not text:
        return text
    t = unicodedata.normalize("NFC", text.replace("\x00", ""))
    t = INVISIBLE.sub("", t)
    t = LINE_SEP.sub("\n", t)
    t = ODD_SPACE.sub(" ", t)
    t = _FOLD_RE.sub(lambda m: _fold_char(m.group(0)), t)
    t = WORD.sub(_demix, t)
    t = MULTI_SPACE.sub(" ", t)
    t = SPACE_BEFORE_NL.sub("\n", t)
    return t.strip()


# ------------------------------------------------------------ synthetic attacks (training only)

ZW_CHARS = ["​", "‌", "‍", "⁠", "﻿"]
LATIN_TO_CONF = {
    "a": "а",
    "e": "е",
    "o": "о",
    "p": "р",
    "c": "с",
    "x": "х",
    "y": "у",
    "i": "і",
    "A": "А",
    "B": "В",
    "E": "Е",
    "H": "Н",
    "K": "К",
    "M": "М",
    "O": "О",
    "P": "Р",
    "C": "С",
    "T": "Т",
    "X": "Х",
}


def attack_zero_width(text: str, rng, rate: float = 0.15) -> str:
    """Insert zero-width characters after a fraction of the characters (label-independent)."""
    out = []
    for ch in text:
        out.append(ch)
        if ch.isalpha() and rng.random() < rate:
            out.append(ZW_CHARS[rng.randrange(len(ZW_CHARS))])
    return "".join(out)


def attack_homoglyph(text: str, rng, rate: float = 0.2) -> str:
    return "".join(
        LATIN_TO_CONF[ch] if ch in LATIN_TO_CONF and rng.random() < rate else ch
        for ch in text
    )


def attack_whitespace(text: str, rng, rate: float = 0.3) -> str:
    return "".join(
        (" " if rng.random() < 0.5 else " ")
        if ch == " " and rng.random() < rate
        else ch
        for ch in text
    )
