"""F006.3 MULTILINGUAL ACADEMIC + MODERN GENERATOR HARDENING (Track A only: AI writing detection).

Every rule that decides a split, a generator role or a gate is fixed HERE, before any F006.3 training, and is not changed after
results are seen. Drive (new area): MyDrive/turniting/f006_3/{datasets/{raw,normalized,multilingual,mixed_language,splits,manifests},
models/{checkpoints,final},evaluation,reports,logs}. Historical artefacts (V2, V3, F006.1, F006.1.1, F006.2, F008*) are read-only.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path

DRIVE = Path(os.environ.get("TURNITING_DRIVE", "/content/drive/MyDrive/turniting"))
D = DRIVE / "f006_3"
DS = D / "datasets"
RAW, NORM, MULTI, MIXED, SPLITS, MANI = DS / "raw", DS / "normalized", DS / "multilingual", DS / "mixed_language", DS / "splits", DS / "manifests"
CKPT, FINAL, EVAL, REPORTS, LOGS = D / "models" / "checkpoints", D / "models" / "final", D / "evaluation", D / "reports", D / "logs"
D611, D62 = DRIVE / "f006_1_1", DRIVE / "f006_2"
F611_MODEL = D611 / "models" / "experimental_f006_1_1"                      # PRIMARY BASELINE (frozen)
F62_A = D62 / "models" / "final" / "experimental_f006_2"                   # F006.2 Candidate A (comparison only)
F62_B = D62 / "models" / "checkpoints" / "runs" / "F0062_B" / "best"        # F006.2 Candidate B (init of B1-B5; never modified)
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]
SEED = 63006

LANGS = ["es", "en", "pt", "fr", "de"]
EXTRA_LANGS = ["it", "nl"]
LANG_WEIGHT = {"es": 0.36, "en": 0.26, "pt": 0.12, "fr": 0.13, "de": 0.13}      # orientative, not a hard quota
LANG_NAME = {"es": "español", "en": "English", "pt": "português", "fr": "français", "de": "Deutsch", "it": "italiano", "nl": "Nederlands"}

# ---------------------------------------------------------------- generator roles (fixed before training)
OPEN_GENERATORS = {
    "qwen2.5-14b": {"hf": "Qwen/Qwen2.5-14B-Instruct", "provider": "Alibaba (Qwen)", "role": "TRAIN", "license": "Apache-2.0"},
    "mistral-nemo-12b": {"hf": "mistralai/Mistral-Nemo-Instruct-2407", "provider": "Mistral AI", "role": "TRAIN", "license": "Apache-2.0"},
    "olmo2-7b": {"hf": "allenai/OLMo-2-1124-7B-Instruct", "provider": "AI2", "role": "VAL_UNSEEN_PROXY", "license": "Apache-2.0"},
    "phi3.5-mini": {"hf": "microsoft/Phi-3.5-mini-instruct", "provider": "Microsoft", "role": "FINAL_ONLY", "license": "MIT"},
    "granite3.1-8b": {"hf": "ibm-granite/granite-3.1-8b-instruct", "provider": "IBM", "role": "FINAL_ONLY", "license": "Apache-2.0"},
}
# Claude (Claude Code subagents) is auxiliary TRAIN / VALIDATION / CALIBRATION data only, never FINAL.

CLASSES = ["HUMAN", "AI_GENERATED", "AI_REVISED", "HUMAN_REVISED_BY_AI", "AI_WITH_HUMAN_INSERTS", "HUMAN_WITH_AI_INSERTS", "MIXED"]
FINE = {"HUMAN": "HUMAN", "AI_GENERATED": "AI_GENERATED", "AI_REVISED": "PARAPHRASED_AI", "HUMAN_REVISED_BY_AI": "AI_EDITED",
        "AI_WITH_HUMAN_INSERTS": "MIXED", "HUMAN_WITH_AI_INSERTS": "MIXED", "MIXED": "MIXED"}
SECTION_TYPES = ["TITLE", "RESUMEN", "ABSTRACT", "KEYWORDS", "INTRODUCTION", "THEORETICAL_FRAMEWORK", "RELATED_WORK", "METHODS",
                 "RESULTS", "DISCUSSION", "QUOTATION", "CONCLUSION", "EXECUTIVE_SUMMARY", "REFERENCES", "APPENDIX"]
EXCLUDED_SECTIONS = {"TITLE", "KEYWORDS", "REFERENCES"}  # PRESENTATION_EXCLUDED: never HUMAN / MACHINE training samples

# ---------------------------------------------------------------- split rules
def unit(key: str, seed: int = SEED) -> float:
    return int(hashlib.sha256(f"{seed}:{key}".encode()).hexdigest()[:12], 16) / float(1 << 48)


def venue_side(venue: str) -> str:
    """Human academic split by WHOLE venue (journal / repository): TRAIN 62 / VAL 12 / CAL 8 / FINAL 18."""
    u = unit("venue:" + str(venue))
    return "TRAIN" if u < 0.62 else "VAL" if u < 0.74 else "CAL" if u < 0.82 else "FINAL"


def topic_side(topic: str) -> str:
    """Generated-text topics: TRAIN 70 / VAL 12 / CAL 8 / FINAL 10 (FINAL topics only ever used by FINAL_ONLY generators)."""
    u = unit("topic:" + str(topic))
    return "TRAIN" if u < 0.70 else "VAL" if u < 0.82 else "CAL" if u < 0.90 else "FINAL"


# ---------------------------------------------------------------- pre-registered gates (F006_3_GATES, fixed 2026-10-25 before training)
GATES = {
    "historical_forgetting_macro_f1_pp_max": 1.0,      # drop of historical-validation macro F1 vs F006.1.1, in points
    "historical_fpr_rise_pp_max": 1.0,
    "unseen_generator_recall_min": "F006.1.1",        # >= baseline on the VALIDATION unseen-generator proxy
    "macro_f1_min": "F006.1.1",                        # >= baseline (new VALIDATION)
    "academic_human_fpr_max": "F006.1.1",              # <= baseline (new VALIDATION, academic humans)
    "per_language_f1_drop_pp_max": {"es": 3.0, "en": 3.0, "pt": 5.0, "fr": 5.0, "de": 5.0},
    "mixed_language_f1_drop_pp_max": 3.0,
    "rule_if_none_pass": "lock the candidate with the highest F006_3_SELECTION_SCORE among those passing the forgetting gate, flag "
                         "GATES_FAILED; if none passes forgetting, NO_MODEL_LOCK. Final holdout evaluated once for the locked model and the "
                         "baselines only.",
}

_WS = re.compile(r"[ \t ]+")
_ZW = re.compile("[​‌‍⁠﻿]")


def norm_text(t: str) -> str:
    t = unicodedata.normalize("NFC", str(t).replace("\r\n", "\n").replace("\r", "\n").replace("\x00", ""))
    t = _ZW.sub("", t)
    return "\n".join(_WS.sub(" ", ln).strip() for ln in t.split("\n")).strip()


def sha256_text(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def stable_id(*parts) -> str:
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:24]


def write_json(path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str), encoding="utf-8")


def detect_lang(text: str) -> tuple[str, float]:
    """Paragraph-level language id (langid, normalised probabilities). Never used as an AI signal."""
    import langid

    if not hasattr(detect_lang, "_id"):
        from langid.langid import LanguageIdentifier, model

        detect_lang._id = LanguageIdentifier.from_modelstring(model, norm_probs=True)
    lang, p = detect_lang._id.classify(text[:2000])
    return lang, float(p)


_DOI = re.compile(r"(doi\s*:?\s*10\.\S+|\b10\.\d{4,9}/\S+|https?://\S+|www\.\S+)", re.I)


def is_presentation(text: str) -> bool:
    """Reference / bibliography / metadata-like text -> PRESENTATION_EXCLUDED."""
    t = text.strip()
    if _DOI.search(t):
        return True
    cites = len(re.findall(r"\(\d{4}[a-z]?\)|\b(19|20)\d{2}[a-z]?\.", t))
    return cites >= 2 and len(t.split()) < 80
