"""F008.3 pre-training banner; exit 3 (STOP_BEFORE_TRAINING) unless every leakage counter is exactly 0.

    python scripts/f0083_preflight.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from f0082_common import write_json  # noqa: E402

D = Path("/content/drive/MyDrive/turniting/f008_3")
S, M = D / "datasets" / "splits", D / "datasets" / "manifests"
REPO = Path(__file__).resolve().parents[1]
LANGS = ["es", "en", "pt", "fr", "de"]
HARD = ("NEGATIVE", "CONTRADICTION")


def main() -> int:
    hm = json.loads((M / "f008_3_final_external_holdout.json").read_text())
    sp = {k: pd.read_parquet(S / f"f008_3_{k}.parquet") for k in ("train", "validation", "calibration", "final_external_holdout")}
    a = pd.concat(sp.values(), ignore_index=True)
    cross = a["cross_language"].fillna(False).astype(bool)
    pc = a["pair_class"].astype(str)
    try:
        import torch

        p = torch.cuda.get_device_properties(0)
        gpu = f"{p.name} {p.total_memory / 2**30:.1f} GiB ({'bf16' if torch.cuda.is_bf16_supported() else 'fp16'})"
    except Exception as e:  # noqa: BLE001
        gpu = f"NONE ({type(e).__name__})"
    lk = hm["leakage"]
    b = {"PHASE": "F008_3", "GPU": gpu, "BASE_MODEL": "BM25 + BAAI/bge-m3 + F008.2 B_RERANK (bge-reranker-v2-m3 fine-tuned)", "TOTAL_PAIRS": int(len(a)),
         "MONOLINGUAL_PAIRS": int((~cross).sum()), "CROSS_LANGUAGE_PAIRS": int(cross.sum()),
         "LONG_DISTANCE_PAIRS": int(pc.str.contains("LONG_DISTANCE").sum()),
         "TRANSLATED_PAIRS": int(pc.str.contains("TRANSLAT").sum()), "HARD_NEGATIVES": int(pc.str.contains("|".join(HARD)).sum()),
         **{f"{l.upper()}_PAIRS": int(((a["lang_a"] == l) | (a["lang_b"] == l)).sum()) for l in LANGS},
         "TRAIN_PAIRS": int(len(sp["train"])), "VALIDATION_PAIRS": int(len(sp["validation"])), "CALIBRATION_PAIRS": int(len(sp["calibration"])),
         "FINAL_HOLDOUT_PAIRS": int(len(sp["final_external_holdout"])),
         "LEAKAGE": {k: lk[k] for k in ("CROSS_SPLIT_LEAKAGE", "PARENT_LEAKAGE", "SOURCE_LEAKAGE", "TRANSLATION_LINEAGE_LEAKAGE", "CLAUDE_rows_in_FINAL")},
         "SUSHI_IN_TRAIN": int(sp["train"]["dataset"].astype(str).str.contains("sushi", case=False).sum()),
         "DRIVE_OUTPUT": str(D / "models")}
    for k, v in b.items():
        print(f"{k} = {v}")
    write_json(REPO / "reports" / "f008_3" / "preflight.json", b)
    if lk["result"] != "PASS" or any(v != 0 for v in b["LEAKAGE"].values()) or b["SUSHI_IN_TRAIN"]:
        print("STOP_BEFORE_TRAINING")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
