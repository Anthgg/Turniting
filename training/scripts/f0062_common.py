"""F006.2 shared constants and text helpers (Track A only: AI writing detection).

Drive layout (new, independent of every historical path):
  MyDrive/turniting/f006_2/{datasets/{raw,normalized,splits,manifests},models/{checkpoints,final},reports,logs}
Historical inputs are read-only: V2 master (v3/datasets/master_v2), F006.1.1 train_extra / validation, the F006.1.1 model.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path

DRIVE = Path("/content/drive/MyDrive/turniting")
D = DRIVE / "f006_2"
RAW, NORM, SPLITS, MANI = D / "datasets" / "raw", D / "datasets" / "normalized", D / "datasets" / "splits", D / "datasets" / "manifests"
CKPT, FINAL, REPORTS, LOGS = D / "models" / "checkpoints", D / "models" / "final", D / "reports", D / "logs"
D611 = DRIVE / "f006_1_1"
V3D = DRIVE / "v3"
F611_MODEL = D611 / "models" / "experimental_f006_1_1"  # EXPERIMENTAL_F006_1_1_MODEL (baseline, frozen, never overwritten)
F611_LOCKED_CKPT = D611 / "models" / "f006_1_1_locked"
MASTER = Path("/content/f006work/master_v2")
REPO = Path(__file__).resolve().parents[1]
SEED = 62006

# historical families: never presented as new data (task rule)
HISTORICAL = ["iberautextification", "autextification2023", "semeval2024_task8", "m4", "mage", "hc3", "hc3_chinese", "raid", "turingbench",
              "ghostbuster_essay", "cc_news_es_2019", "xlsum_es_bbcmundo", "multitude"]

# new sources (license audit in reports/F006_2_LICENSE_AUDIT.json; only TRAIN_OK sources may enter TRAIN)
SOURCES = {
    "tdx_thesis_es": {"url": "https://zenodo.org/records/7313149/files/tdx_es.txt?download=1", "doi": "10.5281/zenodo.7313149",
                      "md5": "c38ee282c65aee890db1d2491e5a45d7", "license_status": "NON_COMMERCIAL", "train_ok": True},
    "spanish_synthetic_2026": {"url": "https://zenodo.org/records/19449815/files/dataset.zip?download=1", "doi": "10.5281/zenodo.19449815",
                               "md5": "59472f449791c0ff690a0cc473a43049", "license_status": "ALLOWED", "train_ok": False,
                               "note": "kept OUT of TRAIN by design: unseen domain (news descriptions) + unseen small generators -> OOD / FINAL holdout"},
    "txd22": {"url": "https://data.mendeley.com/public-files/datasets/prcjcggtjf/files/1e842f9d-4ff8-4986-bc7c-cde460f806ee/file_downloaded",
              "doi": "10.17632/prcjcggtjf.1", "sha256": "232c260f8caf7ea61a331f39fa730956862afbe0c5fc554720daa07d215a2f7d",
              "license_status": "ALLOWED", "train_ok": False,
              "note": "NOT NEW: already a TURNITING_DATASET_V2 source (adapters_v2.txd22); historical replay only, not downloaded again"},
}
A3_LLM = {1: "ministral-3b", 2: "qwen-2.5-0.5b", 3: "llama-3.2-1b"}
A3_TEMP = {1: 1.0, 2: 0.75, 3: 0.5}
# TXD-22 generators kept out of TRAIN entirely (unseen-generator evaluation); the rest may train (capped share)
TXD_HOLDOUT_GENERATORS = {"Pi", "Nova", "Z.ai", "Poe"}
TXD_VAL_GENERATORS = {"Copilot"}  # validation-only proxy for unseen generators (never TRAIN, never FINAL)
TXD_MIXED = {"AI-generated + Human-written": ("MIXED", 0.5), "Human-written + AI-refined": ("AI_EDITED", 0.6),
             "AI-generated + AI-refined": ("PARAPHRASED_AI", 1.0), "AI-generated + AI-refined + Human-written": ("MIXED", 0.6)}
TXD_MAX_TRAIN_SHARE = 0.12  # of the global training batch (task: 10-15 % max)

MIN_WORDS, MAX_WORDS = 40, 700

_WS = re.compile(r"[ \t ]+")
_ZW = re.compile("[​‌‍⁠﻿]")


def norm_text(t: str) -> str:
    """Conservative normalisation for non-adversarial sources: NFC, LF, no NUL / zero-width, collapsed spaces."""
    t = unicodedata.normalize("NFC", t.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", ""))
    t = _ZW.sub("", t)
    return "\n".join(_WS.sub(" ", ln).strip() for ln in t.split("\n")).strip()


def sha256_text(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def stable_id(*parts) -> str:
    return hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:24]


def unit(key: str, seed: int = SEED) -> float:
    return int(hashlib.sha256(f"{seed}:{key}".encode()).hexdigest()[:12], 16) / float(1 << 48)


def write_json(path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str), encoding="utf-8")


# ------------------------------------------------------------------ thesis cleaning (HUMAN_ACADEMIC_STRONG)

_REF_HEAD = re.compile(r"^\s*(referencias|bibliograf[ií]a|references|bibliography|obras citadas|fuentes consultadas|"
                       r"[ií]ndice|tabla de contenidos?|agradecimientos|anexos?|ap[eé]ndices?|lista de (tablas|figuras))\b", re.I)
_CITE_LINE = re.compile(r"(\(\d{4}[a-z]?\)|\b\d{4}[a-z]?\.\s|et al\.|doi:|https?://|ISBN|ISSN|pp\.\s*\d|vol\.\s*\d|n[ºo°]\.?\s*\d)", re.I)
_ADMIN = re.compile(r"(tesis doctoral|director[a]? de (la )?tesis|universitat|universidad .{0,40}(facultad|departament)|programa de doctorado|"
                    r"dip[oò]sit legal|isbn|todos los derechos|creative commons|firmad[oa]|fdo\.|presentada por|para optar al grado|"
                    r"dedic(o|ado|atoria)|agradec(er|imiento|emos|ezco)|q\.e\.p\.d)", re.I)
_TOC = re.compile(r"(\.{4,}|…{2,}|\s\d{1,3}\s*$)")
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])")


def ocr_bad(t: str) -> bool:
    if not t:
        return True
    letters = sum(c.isalpha() for c in t)
    if letters / max(len(t), 1) < 0.70:
        return True
    words = t.split()
    if not words:
        return True
    short = sum(len(w) == 1 and w.isalpha() and w.lower() not in "yaeouo" for w in words) / len(words)
    long_ = sum(len(w) > 25 for w in words) / len(words)
    hy = t.count("- ") / max(len(words), 1)
    digits = sum(c.isdigit() for c in t) / max(len(t), 1)
    return short > 0.06 or long_ > 0.02 or hy > 0.03 or digits > 0.08


def clean_thesis(doc: str) -> tuple[list[str], dict]:
    """Thesis document -> clean candidate paragraphs of 120-700 words (sentence groups; the corpus is sentence-split
    text, so paragraphs are rebuilt from consecutive sentences). Drops everything after a references / bibliography
    heading, TOC / index lines, citation-dense spans, administrative boilerplate and OCR-damaged spans."""
    stats = {"sentences": 0, "dropped_after_refs": 0, "dropped_admin": 0, "dropped_toc": 0, "dropped_cite": 0, "dropped_ocr": 0}
    # tdx_es.txt: one sentence per line, documents separated by a blank line
    sents = [s.strip() for ln in doc.split("\n") for s in _SENT_SPLIT.split(ln) if s.strip()]
    stats["sentences"] = len(sents)
    keep: list[str] = []
    cut = None
    for i, s in enumerate(sents):
        if i > len(sents) * 0.5 and _REF_HEAD.match(s):  # back matter: stop
            cut = i
            break
    if cut is not None:
        stats["dropped_after_refs"] = len(sents) - cut
        sents = sents[:cut]
    front = max(10, len(sents) // 20)  # cover / dedication / acknowledgements / abstract-page front matter
    stats["dropped_front_matter"] = min(front, len(sents))
    sents = sents[front:]
    for s in sents:
        if _ADMIN.search(s):
            stats["dropped_admin"] += 1
            continue
        if _TOC.search(s) and len(s.split()) < 25:
            stats["dropped_toc"] += 1
            continue
        if len(_CITE_LINE.findall(s)) >= 2:
            stats["dropped_cite"] += 1
            continue
        keep.append(s)
    paras, cur, words = [], [], 0
    target = 0
    for s in keep:
        if not cur:
            target = (160, 320, 520)[len(paras) % 3]  # 120-250 / 250-450 / 450-700 buckets
        cur.append(s)
        words += len(s.split())
        if words >= target:
            p = " ".join(cur)
            if ocr_bad(p):
                stats["dropped_ocr"] += 1
            elif 120 <= words <= MAX_WORDS:
                paras.append(p)
            cur, words = [], 0
    return paras, stats


def length_bucket(n: int) -> str:
    return "120-250" if n < 250 else "250-450" if n < 450 else "450-700"
