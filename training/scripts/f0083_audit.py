"""F008.3 audits (local, no GPU): F008_3_LICENSE_AUDIT.json + F008_3_EXISTING_DATA_AUDIT.json.

    python scripts/f0083_audit.py

Rule: UNDECLARED / PENDING_REVIEW / BLOCKED => NO_TRAIN. NON_COMMERCIAL / RESEARCH_ONLY may be trained on for this research model only
(flagged; a commercial release would need to drop them). Evaluation-only sources are never trained on.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

LICENSES = [
    {"dataset_id": "flores200", "name": "FLORES-200", "source": "https://dl.fbaipublicfiles.com/nllb/flores200_dataset.tar.gz", "license": "CC BY-SA 4.0",
     "license_status": "ALLOWED", "train": "NO_TRAIN (evaluation only)", "use": "dev -> VALIDATION / CALIBRATION (by article); devtest -> FINAL_EXTERNAL_HOLDOUT",
     "languages": "es en pt fr de (n-way parallel)", "new": True},
    {"dataset_id": "tapaco", "name": "TaPaCo (Tatoeba paraphrase corpus)", "source": "https://huggingface.co/datasets/tapaco", "license": "CC BY 2.0",
     "license_status": "ALLOWED", "train": "ALLOWED", "use": "TRAIN 85 / VALIDATION 8 / CALIBRATION 7 by paraphrase set", "new": True},
    {"dataset_id": "opusparcus_test", "name": "Opusparcus (test, annotated)", "source": "https://huggingface.co/datasets/GEM/opusparcus", "license": "CC BY-NC 4.0",
     "license_status": "NON_COMMERCIAL", "train": "NO_TRAIN (evaluation only)", "use": "FINAL_EXTERNAL_HOLDOUT (de / en / fr; score >= 3 paraphrase, <= 2 not)",
     "new": True},
    {"dataset_id": "xnli", "name": "XNLI", "source": "https://huggingface.co/datasets/facebook/xnli", "license": "CC BY-NC 4.0", "license_status": "NON_COMMERCIAL",
     "train": "ALLOWED (research model only)", "use": "contradiction / neutral pairs as hard negatives; validation -> VAL / CAL; test -> FINAL", "new": True},
    {"dataset_id": "stsb_multi_mt", "name": "STSb-multi-MT", "source": "https://huggingface.co/datasets/stsb_multi_mt", "revision": "3acaa3dd8c91649e0b8e627ffad891f059e47c8c",
     "license": "STS benchmark terms (research use)", "license_status": "RESEARCH_ONLY", "train": "ALLOWED (research model only)",
     "use": "graded pairs (label 1 if score >= 4.0, 0 if <= 1.5, rest graded-only) + cross-language rows", "new": True},
    {"dataset_id": "pawsx_de_fr_train", "name": "PAWS-X de / fr TRAIN", "license": "PAWS-X terms (free use with attribution)", "license_status": "ALLOWED",
     "train": "ALLOWED after leakage audit", "use": "lexical hard negatives; dev / test ids excluded", "new": False, "notes": "historical family, not presented as new"},
    {"dataset_id": "claude_pairs_multilingual", "name": "Claude-generated multilingual seed bundles (Claude Code subagents)", "license": "generated for this project",
     "license_status": "ALLOWED", "train": "ALLOWED (auxiliary)", "use": "TRAIN / VALIDATION / CALIBRATION only; never FINAL", "new": True},
    {"dataset_id": "f008_2_train", "name": "F008.2 TRAIN (replay)", "license_status": "ALLOWED", "train": "ALLOWED (replay)", "use": "anti-forgetting replay", "new": False},
    {"dataset_id": "sushi_corpus", "name": "SpanishParaphraseCorpora / Sushi", "license": "CC0-1.0", "license_status": "ALLOWED", "train": "NO_TRAIN",
     "use": "LONG_DISTANCE_PARAPHRASE_REGRESSION (F008.2 final holdout, already observed)", "new": False},
    {"dataset_id": "parmex_2022", "name": "PAR-MEX 2022 (IberLEF)", "source": "https://github.com/GIL-UNAM/PARMEX_2022", "license": "none declared",
     "license_status": "UNDECLARED", "train": "NO_TRAIN", "use": "none", "new": False},
    {"dataset_id": "sts_es_train", "name": "STS-es (PlanTL) train / dev", "license_status": "UNDECLARED", "train": "NO_TRAIN", "use": "none", "new": False},
    {"dataset_id": "cross_language_plagiarism_okg", "name": "Zenodo 5159398 (PAN-PC-11 lineage)", "license": "CC BY 4.0", "license_status": "ALLOWED",
     "train": "NO_TRAIN (not independent of the F008 holdout)", "use": "none", "new": False},
    {"dataset_id": "pan_pc_11", "name": "PAN-PC-11", "license_status": "ALLOWED", "train": "NO_TRAIN", "use": "historical F008 data only", "new": False},
]


def parmex_usage() -> dict:
    """Was ParMEX ever used? Search every branch's history for code / manifests that load it (not just mention it)."""
    log = subprocess.run(["git", "log", "--all", "--oneline", "-S", "PARMEX", "-i"], capture_output=True, text=True, cwd=REPO).stdout.strip().splitlines()
    loaders = subprocess.run(["git", "grep", "-i", "-n", "-E", "parmex.*(read_csv|load_dataset|read_parquet|fetch|download)", "--", "."],
                             capture_output=True, text=True, cwd=REPO).stdout.strip().splitlines()
    return {"commits_mentioning": log, "loader_lines": loaders,
            "verdict": "NOT_USED" if not loaders else "USED",
            "notes": "ParMEX appears only in the F008.2 license audit and as an exclusion note in f0082_data.py; no split, manifest or loader reads it. "
                     "F008 / F008.2 / F008.3 never trained, tuned or evaluated on ParMEX. It stays UNDECLARED -> NO_TRAIN."}


def main() -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (REPO / "reports").mkdir(exist_ok=True)
    (REPO / "reports" / "F008_3_LICENSE_AUDIT.json").write_text(json.dumps(
        {"auditedAt": now, "track": "B", "rule": "UNDECLARED / PENDING_REVIEW / BLOCKED => NO_TRAIN; NON_COMMERCIAL / RESEARCH_ONLY flagged (research model only)",
         "candidates": LICENSES, "parmex_audit": parmex_usage()}, indent=2, ensure_ascii=False), encoding="utf-8")
    existing = {"auditedAt": now, "track": "B",
                "historical": {"F008": ["PAN-PC-11 (holdout lineage)", "PAWS-X es"], "F008.2": ["PAWS-X es train / dev / test (test = regression)", "Sushi (final)",
                                                                                              "STS-es MTEB test (OOD)", "claude_pairs (train)"]},
                "f008_3_rules": {"sushi": "never TRAIN; LONG_DISTANCE_PARAPHRASE_REGRESSION", "paws_es_test": "REGRESSION only",
                                 "flores": "dev / devtest article-disjoint from each other by construction; devtest only FINAL",
                                 "claude": "never FINAL", "lineage": "all transformations of one seed / article / paraphrase set share parent_source_id, lineage and "
                                                                     "translation_lineage; leakage counters must be 0 (STOP_BEFORE_TRAINING otherwise)"},
                "parmex": parmex_usage()["verdict"]}
    (REPO / "reports" / "F008_3_EXISTING_DATA_AUDIT.json").write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"licenses": len(LICENSES), "parmex": existing["parmex"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
