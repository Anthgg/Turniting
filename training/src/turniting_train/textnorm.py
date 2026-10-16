"""Conservative text validation/normalization and label/domain/generator canonicalization.

Decision (documented in README): Unicode NFC, not NFKC. NFKC folds full-width forms,
ligatures and some confusables, which would silently undo homoglyph-style attacks and
alter typography that is itself a signal. Adversarial rows keep their original text
(only NUL bytes removed) so attacks such as zero-width-space, whitespace and homoglyph
survive; the conservatively normalized copy goes in `text_normalized`.
"""

from __future__ import annotations

import re
import unicodedata

from .common import HUMAN, MACHINE, sha256_text

ZERO_WIDTH = re.compile("[​‌‍⁠﻿]")
HTML_TAG = re.compile(r"<[^>]{1,200}>")
WS_EDGES = re.compile(r"^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$")
DEDUP_SPACE = re.compile(r"\s+")

HUMAN_LABELS = {"human", "human-written", "0_human", "h"}
MACHINE_LABELS = {"generated", "machine", "machine-generated", "ai", "llm", "m"}


def normalize_label(value, *, scheme: str = "human0") -> int:
    """Map a dataset label to 0=HUMAN, 1=MACHINE.

    scheme: "human0" (0 human / 1 machine), "human1" (1 human / 0 machine, e.g. MAGE),
    "text" (string labels).
    """
    if isinstance(value, str):
        v = value.strip().lower()
        if v in HUMAN_LABELS:
            return HUMAN
        if v in MACHINE_LABELS:
            return MACHINE
        if v.isdigit():
            value = int(v)
        else:
            raise ValueError(f"unknown label {value!r}")
    value = int(value)
    if value not in (0, 1):
        raise ValueError(f"non-binary label {value!r}")
    if scheme == "human0":
        return HUMAN if value == 0 else MACHINE
    if scheme == "human1":
        return HUMAN if value == 1 else MACHINE
    raise ValueError(f"unknown scheme {scheme}")


def normalize_text(text: str, *, adversarial: bool = False) -> str:
    text = text.replace("\x00", "")
    if adversarial:
        return text
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = ZERO_WIDTH.sub("", text)
    return WS_EDGES.sub("", text)


def dedup_key_text(text: str) -> str:
    """Text used for exact-duplicate hashing: NFC, zero-width removed, whitespace collapsed."""
    text = unicodedata.normalize("NFC", text.replace("\x00", ""))
    text = ZERO_WIDTH.sub("", text)
    return DEDUP_SPACE.sub(" ", text).strip()


def normalized_text_hash(text: str) -> str:
    return sha256_text(dedup_key_text(text))


def invalid_reason(text, *, min_chars: int, min_words: int) -> str | None:
    """Return why a text is unusable, or None. Short texts are *not* rejected for being hard."""
    if text is None:
        return "null"
    if not isinstance(text, str):
        return "not_string"
    stripped = text.strip()
    if not stripped:
        return "empty_or_whitespace"
    tags = HTML_TAG.findall(stripped)
    if tags and sum(map(len, tags)) / len(stripped) > 0.5:
        return "broken_html"
    if len(stripped) < min_chars:
        return "below_min_chars"
    # Words for space-delimited scripts; CJK counts characters instead.
    if len(stripped.split()) < min_words and not re.search(r"[぀-ヿ一-鿿]", stripped):
        return "below_min_words"
    return None


# ---------------------------------------------------------------- canonical metadata

DOMAIN_MAP = {
    # academic / scientific / essays
    "abstracts": "academic", "arxiv": "academic", "peerread": "academic",
    "sci_gen": "academic", "scientific": "academic", "essay": "academic",
    "essays": "academic", "academic": "academic",
    # news
    "news": "news", "xsum": "news", "cnn": "news", "tldr": "news",
    "id-newspaper": "news", "bulgarian_true_and_fake_news": "news", "urdu": "news",
    "russian": "news", "turingbench_news": "news",
    # reviews
    "reviews": "reviews", "yelp": "reviews", "imdb": "reviews", "amazon": "reviews",
    # wiki
    "wiki": "wiki", "wikipedia": "wiki", "germanwikipedia": "wiki", "arabic": "wiki",
    "baike": "wiki",
    # how-to
    "how-to": "howto", "wikihow": "howto", "recipes": "recipes",
    # QA / forums / chat
    "reddit": "forum", "eli5": "forum", "reddit_eli5": "forum", "cmv": "forum",
    "open_qa": "qa", "finance": "qa", "medicine": "qa", "wiki_csai": "qa", "law": "qa",
    "psychology": "qa", "nlpcc_dbqa": "qa", "qazh": "qa", "squad": "qa", "chat": "chat",
    "dialogsum": "chat",
    # creative
    "literary": "literary", "books": "literary", "wp": "literary", "roct": "literary",
    "hswag": "literary", "poetry": "poetry",
    # other
    "tweets": "social", "legal": "legal",
}
ACADEMIC_DOMAINS = {"academic"}


def canonical_domain(raw: str | None) -> str:
    if not raw:
        return "unknown"
    key = str(raw).strip().lower()
    return DOMAIN_MAP.get(key, key)


GENERATOR_RULES = [
    (r"gpt-?4", "gpt-4", "gpt"),
    (r"gpt-?3\.5|chatgpt|gpt35|turbo|trubo", "gpt-3.5", "gpt"),
    (r"text-davinci-003|davinci-003|^davinci$|davinci", "gpt-3-davinci", "gpt"),
    (r"curie|babbage|^ada$", "gpt-3-small", "gpt"),
    (r"^gpt3$|gpt-3$", "gpt-3", "gpt"),
    (r"gpt-?2|gpt2|gpt_neo|gpt-neo|gptj|gpt-j|gpt_j|neox", "gpt-2/neo", "gpt-oss-older"),
    (r"gpt1|gpt-1|^gpt$", "gpt-1", "gpt-oss-older"),
    (r"mixtral|mistral", "mistral", "mistral"),
    (r"llama|^7b$|^13b$|^30b$|^65b$|vicuna|alpaca", "llama", "llama"),
    (r"cohere|command", "cohere", "cohere"),
    (r"claude", "claude", "claude"),
    (r"bloom", "bloom", "bloom"),
    (r"flan|t5|t0", "flan-t5/t0", "t5"),
    (r"opt", "opt", "opt"),
    (r"dolly", "dolly", "dolly"),
    (r"j2|ai21|jurassic", "ai21-j2", "ai21"),
    (r"mpt", "mpt", "mpt"),
    (r"grover", "grover", "grover"),
    (r"ctrl", "ctrl", "ctrl"),
    (r"xlnet", "xlnet", "xlnet"),
    (r"xlm", "xlm", "xlm"),
    (r"transfo", "transformer-xl", "transformer-xl"),
    (r"pplm", "pplm", "gpt-oss-older"),
    (r"fair|wmt", "fair-wmt", "fair-wmt"),
    (r"glm", "glm", "glm"),
]


def canonical_generator(raw: str | None) -> tuple[str, str]:
    """(generator, family) for a machine text; ("human","human") for humans."""
    if raw is None:
        return "unknown", "unknown"
    key = str(raw).strip().lower()
    if key in {"human", "no-model", ""}:
        return "human", "human"
    for pattern, name, family in GENERATOR_RULES:
        if re.search(pattern, key):
            # keep the precise checkpoint name while grouping by family
            return key, family
    return key, key
