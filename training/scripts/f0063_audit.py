"""F006.3 (Track A) audits, local:  python training/scripts/f0063_audit.py

reports/F006_3_EXISTING_DATA_AUDIT.json  everything used up to F006.2 (historical: never "new")
reports/F006_3_LICENSE_AUDIT.json        F006.3 candidates and decisions (UNDECLARED / PENDING_REVIEW / BLOCKED => NO_TRAIN)
"""

from __future__ import annotations

import json
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main() -> int:
    prev = json.loads((REPO / "reports" / "F006_2_EXISTING_DATA_AUDIT.json").read_text(encoding="utf-8"))["sources"]
    hist = [{**s, "historical_only": True, "phase_last_used": "<= F006.1.1"} for s in prev]
    hist += [
        {"dataset_id": "tdx_thesis_es", "source": "zenodo 7313149", "license": "CC-BY-NC-SA-4.0 (README) / CC-BY-4.0 (record)", "rows": 20791,
         "language": "es", "domain": "academic theses", "generator": "human", "used_for_train": True, "used_for_validation": True, "used_for_test": False,
         "used_for_holdout": True, "historical_only": True, "blocked": False, "eligible_for_reuse": "CONTROLLED_REPLAY_ONLY (F006.2 train side)",
         "notes": "F006.2 HUMAN_ACADEMIC_STRONG; never presented as new", "phase_last_used": "F006.2"},
        {"dataset_id": "spanish_synthetic_2026", "source": "zenodo 19449815", "license": "CC-BY-4.0", "rows": 56576, "language": "es",
         "domain": "news descriptions", "generator": "Ministral-3B, Qwen-2.5-0.5B, Llama-3.2-1B", "used_for_train": False, "used_for_validation": False,
         "used_for_test": True, "used_for_holdout": True, "historical_only": True, "blocked": False, "eligible_for_reuse": "REGRESSION_ONLY",
         "notes": "F006.2 OOD + FINAL (observed)", "phase_last_used": "F006.2"},
        {"dataset_id": "claude_es_academic_f006_2", "source": "Claude Code subagents", "license": "own generation", "rows": 1173, "language": "es",
         "domain": "academic", "generator": "claude-code-subagent/{opus,sonnet,haiku}", "used_for_train": True, "used_for_validation": True,
         "used_for_test": False, "used_for_holdout": False, "historical_only": True, "blocked": False, "eligible_for_reuse": "REPLAY",
         "notes": "F006.2 auxiliary data", "phase_last_used": "F006.2"},
        {"dataset_id": "f006_2_final_external_holdout", "source": "MyDrive/turniting/f006_2/datasets/splits", "license": "derived", "rows": 7017,
         "language": "es", "domain": "academic + news", "generator": "human + SLMs", "used_for_train": False, "used_for_validation": False,
         "used_for_test": True, "used_for_holdout": True, "historical_only": True, "blocked": False, "eligible_for_reuse": "REGRESSION_HOLDOUT_ONLY",
         "notes": "observed once at F006.2 final", "phase_last_used": "F006.2"},
    ]
    (REPO / "reports" / "F006_3_EXISTING_DATA_AUDIT.json").write_text(json.dumps({"auditedAt": NOW, "track": "A", "rule": "historical sources are never new",
                                                                                 "sources": hist}, indent=2, ensure_ascii=False), encoding="utf-8")
    lic = [
        {"dataset_id": "openalex_academic", "source": "https://api.openalex.org (works, 2012-2020, has_abstract)", "license": "CC0 (OpenAlex data)",
         "license_status": "ALLOWED", "train": "ALLOWED", "languages": "es,en,pt,fr,de,it,nl", "use": "HUMAN academic (split by venue; FINAL venues held out)",
         "notes": "abstract text reconstructed from the OpenAlex inverted index; exact / near dedup against every historical source "
                  "(academic_abstracts_es, scielo_es may overlap)"},
        {"dataset_id": "aigtbench", "source": "https://huggingface.co/datasets/tarryzhang/AIGTBench", "revision": "6f1557d800b69df1a445ff5fff254971e8c45380",
         "license": "Apache-2.0", "license_status": "ALLOWED", "train": "ALLOWED (GPT-4o / GPT-4o-mini / Llama-3.1 rows FINAL_ONLY)", "languages": "en",
         "use": "modern generators, social-media domain (unseen domain)", "notes": "not part of F004-F006.2"},
        {"dataset_id": "open_llm_multilingual", "source": "generated on Colab with open models", "license": "model licences: Apache-2.0 (Qwen2.5, Mistral-Nemo, "
         "OLMo-2, Granite-3.1), MIT (Phi-3.5)", "license_status": "ALLOWED", "train": "TRAIN roles only (Qwen2.5-14B, Mistral-Nemo-12B)",
         "use": "AI_GENERATED / AI_REVISED / HUMAN_REVISED_BY_AI / inserts in ES EN PT FR DE; OLMo-2 = validation unseen proxy; Phi-3.5 + Granite-3.1 = "
                "FINAL_ONLY unseen generators"},
        {"dataset_id": "claude_multilingual", "source": "Claude Code subagents", "license": "own generation", "license_status": "ALLOWED",
         "train": "TRAIN / VAL / CAL only, never FINAL", "use": "multilingual paragraphs + structured mixed-language documents"},
        {"dataset_id": "coling2025_mgt_multilingual", "source": "https://huggingface.co/datasets/Jinyan1/COLING_2025_MGT_multingual",
         "license": "none declared for the data (repository code Apache-2.0)", "license_status": "UNDECLARED", "train": "NO_TRAIN",
         "notes": "also built largely from M4 / MULTITuDE families already used historically"},
        {"dataset_id": "multitude", "license_status": "BLOCKED", "train": "NO_TRAIN", "notes": "gated; still PENDING_ACCESS"},
        {"dataset_id": "multisocial", "license_status": "BLOCKED", "train": "NO_TRAIN", "notes": "restricted access"},
        {"dataset_id": "detectrl_x", "license_status": "ALLOWED", "train": "NOT_NEW", "notes": "already a V2 / F006.1 source (historical replay only)"},
        {"dataset_id": "pan_generative_ai_2025_2026", "license_status": "BLOCKED", "train": "NO_TRAIN", "notes": "Zenodo restricted records"},
        {"dataset_id": "robust_finegrained_aigt_2504_11952", "source": "arXiv 2504.11952", "license": "no dataset release / licence found", "license_status": "PENDING_REVIEW",
         "train": "NO_TRAIN"},
        {"dataset_id": "medaid_ml", "license_status": "BLOCKED", "train": "NO_TRAIN", "notes": "restricted files (F006.2 audit)"},
        {"dataset_id": "robot_talk", "license_status": "PENDING_REVIEW", "train": "NO_TRAIN", "notes": "no public download / licence (F006.2 audit)"},
        {"dataset_id": "tdx_thesis_es", "license_status": "NON_COMMERCIAL", "train": "CONTROLLED_REPLAY_ONLY", "notes": "not new (F006.2)"},
    ]
    (REPO / "reports" / "F006_3_LICENSE_AUDIT.json").write_text(json.dumps({"auditedAt": NOW, "track": "A", "states": ["ALLOWED", "NON_COMMERCIAL",
                                                                                                                     "RESEARCH_ONLY", "UNDECLARED",
                                                                                                                     "PENDING_REVIEW", "BLOCKED"],
                                                                           "candidates": lic}, indent=2, ensure_ascii=False), encoding="utf-8")
    print(len(hist), len(lic))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
