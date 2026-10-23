"""F008.2 shared constants (Track B only: textual similarity / paraphrase; never mixed with Track A data or models).

Drive (new, independent): MyDrive/turniting/f008_2/{datasets/{raw,pairs,splits,manifests},models/{biencoder,reranker,checkpoints,final},reports,logs}
Frozen references (never modified): BM25, BAAI/bge-m3, intfloat/multilingual-e5-large-instruct, BAAI/bge-reranker-v2-m3 and every F008 result.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path

DRIVE = Path("/content/drive/MyDrive/turniting")
D = DRIVE / "f008_2"
RAW, PAIRS, SPLITS, MANI = D / "datasets" / "raw", D / "datasets" / "pairs", D / "datasets" / "splits", D / "datasets" / "manifests"
BIENC, RERANK, CKPT, FINAL, REPORTS, LOGS = (D / "models" / "biencoder", D / "models" / "reranker", D / "models" / "checkpoints", D / "models" / "final",
                                             D / "reports", D / "logs")
D8 = DRIVE / "f008"
REPO = Path(__file__).resolve().parents[1]
SEED = 82008

BASE_BIENCODER = "BAAI/bge-m3"
BASE_RERANKER = "BAAI/bge-reranker-v2-m3"
PAWSX = "https://huggingface.co/datasets/google-research-datasets/paws-x/resolve/4cd8187c404bda33cb1f62b49b001115862acf37/{lang}/{split}-00000-of-00001.parquet"
SUSHI = "https://huggingface.co/datasets/GIL-UNAM/SpanishParaphraseCorpora/resolve/03c26e2c0988b39a7de605a70d86d4d9169e9954/Sushi/{f}"
STSES = "https://huggingface.co/datasets/mteb/STSES/resolve/d104c9ae8e5c820b9f79337a74410b06c6d14e6c/data/test-00000-of-00001.parquet"

POSITIVE = {"FAITHFUL_PARAPHRASE": 1.0, "STRONG_PARAPHRASE": 1.0, "STRUCTURAL_REWRITE": 1.0, "TRANSLATED_PARAPHRASE": 1.0, "PARTIAL_PARAPHRASE": 0.5}
NEGATIVE = ["LEXICAL_HARD_NEGATIVE", "NEGATION_HARD_NEGATIVE", "NUMBER_CHANGED_NEGATIVE", "ENTITY_CHANGED_NEGATIVE", "CAUSALITY_CHANGED_NEGATIVE",
            "SAME_TOPIC_NEGATIVE"]

_WS = re.compile(r"\s+")


def norm_text(t: str) -> str:
    t = unicodedata.normalize("NFC", str(t).replace("\x00", ""))
    return _WS.sub(" ", t).strip()


def key(t: str) -> str:
    """normalised hash used for every overlap check (casefold, punctuation-insensitive)"""
    t = unicodedata.normalize("NFKC", t).casefold()
    t = re.sub(r"[^\w]+", " ", t)
    return hashlib.sha256(_WS.sub(" ", t).strip().encode()).hexdigest()


def sha256_text(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def unit(k: str, seed: int = SEED) -> float:
    return int(hashlib.sha256(f"{seed}:{k}".encode()).hexdigest()[:12], 16) / float(1 << 48)


def write_json(path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str), encoding="utf-8")


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for c in iter(lambda: fh.read(8 << 20), b""):
            h.update(c)
    return h.hexdigest()
