"""Versioned preprocessing profiles.

Each model must see text exactly as it was evaluated. A profile is immutable: changing
any rule means a new profile name, never a silent edit.
"""

from __future__ import annotations

import unicodedata
from dataclasses import asdict, dataclass

from app.services.analyzer.canon import canonicalize


@dataclass(frozen=True)
class PreprocessingProfile:
    name: str
    unicode_normalization: str
    zero_width_policy: str
    whitespace_policy: str
    confusables_policy: str
    tokenizer: str
    max_length: int
    stride: int
    max_windows: int | None

    def apply(self, text: str) -> str:
        if self.confusables_policy == "map_mixed_script_words":
            return canonicalize(text)
        text = text.replace("\x00", "")
        if self.unicode_normalization == "NFC":
            text = unicodedata.normalize("NFC", text)
        return text

    def describe(self) -> dict:
        return asdict(self)


# CANDIDATE_MODEL_V2: evaluated (V1 GPU report and V3 comparison) on the text as given,
# tokenized by the mDeBERTa tokenizer; 512-token windows, 128 overlap, at most 6 windows.
V2_PREPROCESSING_V1 = PreprocessingProfile(
    name="V2_PREPROCESSING_V1",
    unicode_normalization="NFC",
    zero_width_policy="keep (model input as given)",
    whitespace_policy="keep",
    confusables_policy="none",
    tokenizer="microsoft/mdeberta-v3-base (sentencepiece, saved with the model)",
    max_length=512,
    stride=128,
    max_windows=6,
)

# CANDIDATE_MODEL_V3: dual-view training; the validation-selected inference view is stored
# in the model's inference_config.json ("canonical", "raw" or "avg").
V3_CANONICALIZED_V1 = PreprocessingProfile(
    name="V3_CANONICALIZED_V1",
    unicode_normalization="NFC",
    zero_width_policy="remove invisible format characters",
    whitespace_policy="map anomalous spaces to space, collapse runs",
    confusables_policy="map_mixed_script_words",
    tokenizer="microsoft/mdeberta-v3-base (sentencepiece, saved with the model)",
    max_length=512,
    stride=128,
    max_windows=8,
)

V3_RAW_V1 = PreprocessingProfile(
    name="V3_RAW_V1",
    unicode_normalization="none",
    zero_width_policy="keep",
    whitespace_policy="keep",
    confusables_policy="none",
    tokenizer="microsoft/mdeberta-v3-base (sentencepiece, saved with the model)",
    max_length=512,
    stride=128,
    max_windows=8,
)

PROFILES = {p.name: p for p in (V2_PREPROCESSING_V1, V3_CANONICALIZED_V1, V3_RAW_V1)}


def profile_for_view(view: str) -> list[PreprocessingProfile]:
    """V3 inference views -> profiles whose scores are averaged in log-odds."""
    if view == "raw":
        return [V3_RAW_V1]
    if view == "avg":
        return [V3_CANONICALIZED_V1, V3_RAW_V1]
    return [V3_CANONICALIZED_V1]
