"""F008.2 (Track B) audits from the repository manifests (local, no download):  python training/scripts/f0082_audit.py

  reports/F008_2_EXISTING_DATA_AUDIT.json   historical similarity sources and how they were used (never "new")
  reports/F008_2_LICENSE_AUDIT.json         candidate sources, license status and the train decision (UNDECLARED / PENDING_REVIEW => NO_TRAIN)
"""

from __future__ import annotations

import json
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main() -> int:
    man = json.loads((REPO / "reports" / "f008" / "f008_dataset_manifest.json").read_text(encoding="utf-8"))["datasets"]
    hold = json.loads((REPO / "reports" / "f008" / "manifest_f008_final_holdout.json").read_text(encoding="utf-8"))
    uses = {"pan2011_pan_pc_11": ("en,es (translated cases)", "books / simulated plagiarism", True, True, True),
            "miracl_es": ("es", "Wikipedia passages (Spanish synthetic copy / paraphrase corpus)", False, True, True),
            "mmarco_es": ("es", "web passages (retrieval check)", False, True, False),
            "pawsx_es": ("es", "Wikipedia sentence pairs (paraphrase / adversarial overlap)", False, True, True)}
    rows = []
    for k, v in man.items():
        lang, dom, trn, val, hol = uses.get(k, ("?", "?", False, False, False))
        blocked = v.get("status") != "DOWNLOADED"
        rows.append({"dataset_id": k, "source": v.get("source"), "revision": None, "license": v.get("license"),
                     "rows": v.get("pairs") or v.get("passages") or v.get("suspicious_docs") or v.get("queries"), "language": lang, "domain": dom,
                     "generator": "human / machine translation", "used_for_train": trn and not blocked, "used_for_validation": val and not blocked,
                     "used_for_test": hol and not blocked, "used_for_holdout": hol and not blocked, "historical_only": True, "blocked": blocked,
                     "eligible_for_reuse": ("PAWS-X TRAIN only, after leakage audit (no row / parent / source shared with F008 dev / test)" if k == "pawsx_es"
                                            else "DISTRACTOR_ONLY (no labels used)" if k == "miracl_es" else "NO" if blocked else "REGRESSION_ONLY"),
                     "notes": ("F008 zero-shot: never fine-tuned on; PAWS-X test sampled into F008_FINAL_HOLDOUT (1,000), dev into validation (600)" if k == "pawsx_es"
                               else f"status {v.get('status')}")})
    out = REPO / "reports"
    (out / "F008_2_EXISTING_DATA_AUDIT.json").write_text(json.dumps({"auditedAt": NOW, "track": "B (textual similarity / paraphrase)",
                                                                     "f008_final_holdout": hold, "sources": rows}, indent=2, ensure_ascii=False), encoding="utf-8")
    lic = [
        {"id": "B1", "dataset_id": "parmex_2022", "name": "PAR-MEX 2022 (IberLEF)", "source": "https://github.com/GIL-UNAM/PARMEX_2022",
         "license": "none declared in the repository / task site", "license_status": "UNDECLARED", "train": "NO_TRAIN", "use": "none",
         "rows": "10,298 pairs (train 7,382 / val 97 / test 2,819)", "notes": "public CSVs but no license: download != train"},
        {"id": "B2", "dataset_id": "sushi_corpus", "name": "SpanishParaphraseCorpora / Sushi", "source": "https://huggingface.co/datasets/GIL-UNAM/SpanishParaphraseCorpora",
         "revision": "03c26e2c0988b39a7de605a70d86d4d9169e9954", "license": "CC0-1.0 (card + LICENSE file)", "license_status": "ALLOWED",
         "train": "ALLOWED but NOT trained on", "use": "FINAL_EXTERNAL_HOLDOUT (human low / high paraphrase, same-topic and vocabulary-overlap negatives)",
         "rows": "6,896 sentence pairs (314 paraphrase) + document-level files", "notes": "raw files read directly (no dataset loader); one article family -> held out entirely"},
        {"id": "B3", "dataset_id": "sts_es", "name": "STS-es (PlanTL) / MTEB STSES", "source": "https://huggingface.co/datasets/mteb/STSES",
         "revision": "d104c9ae8e5c820b9f79337a74410b06c6d14e6c", "license": "MTEB test: CC-BY-4.0; PlanTL train / dev: no license (hashed, SemEval upstream)",
         "license_status": "ALLOWED (test) / UNDECLARED (train)", "train": "NO_TRAIN", "use": "HARD_NEGATIVE_OOD + graded Spearman check (scores kept continuous; "
         "label 1 only for score >= 4, 0 for score <= 1, the rest graded-only)"},
        {"id": "B4", "dataset_id": "cross_language_plagiarism_okg", "name": "Detecting Cross-Language Plagiarism using Open Knowledge Graphs",
         "source": "https://zenodo.org/records/5159398", "license": "CC-BY-4.0", "license_status": "ALLOWED", "train": "NO_TRAIN (not independent)",
         "use": "none", "notes": "its English-Spanish sub-corpus is sampled from PAN-PC-11, already used by F008 (source / lineage overlap with the F008 holdout)"},
        {"id": "B5", "dataset_id": "pawsx_es_train", "name": "PAWS-X es TRAIN (historical F008 family)", "license": "PAWS-X terms (free use with attribution)",
         "license_status": "ALLOWED", "train": "ALLOWED after leakage audit", "use": "TRAIN pairs (lexical hard negatives); dev -> VALIDATION / CALIBRATION; "
         "test -> REGRESSION only", "notes": "not presented as new data"},
        {"id": "B6", "dataset_id": "claude_pairs", "name": "Claude-generated seed bundles (this project)", "license": "own generation", "license_status": "ALLOWED",
         "train": "TRAINING DATA ONLY", "use": "faithful / strong / partial / structural / translated paraphrases and lexical / negation / number / entity / "
         "causality / same-topic negatives of the same seed (parent_source_id = seed)"},
    ]
    (out / "F008_2_LICENSE_AUDIT.json").write_text(json.dumps({"auditedAt": NOW, "track": "B", "rule": "UNDECLARED / PENDING_REVIEW / BLOCKED => NO_TRAIN",
                                                               "candidates": lic}, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"existing {len(rows)}, candidates {len(lic)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
