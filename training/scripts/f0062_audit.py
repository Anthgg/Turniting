"""F006.2 (Track A) audits, run locally from the repository manifests (no data download):

    python training/scripts/f0062_audit.py

  reports/F006_2_EXISTING_DATA_AUDIT.json  every historical Track A source and how it was used (all historical: never "new")
  reports/F006_2_LICENSE_AUDIT.json        new candidate sources, license status and the train decision
License states: ALLOWED, NON_COMMERCIAL, RESEARCH_ONLY, UNDECLARED, BLOCKED, PENDING_REVIEW. UNDECLARED / PENDING_REVIEW => NO_TRAIN.
"Downloadable" never implies "trainable".
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MAN = REPO / "datasets" / "manifests"
AUDITED = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def git_json(ref: str, path: str):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, cwd=REPO)
    return json.loads(r.stdout.decode("utf-8")) if r.returncode == 0 else None


def v3_sources() -> dict:
    sys.path.insert(0, str(REPO / "src"))
    sys.path.insert(0, str(REPO / "scripts"))
    import v3_download  # noqa: E402

    return v3_download.SOURCES


def existing() -> list[dict]:
    rows = []
    v1 = json.loads((MAN / "datasets.json").read_text(encoding="utf-8"))["datasets"]
    lic = {d["dataset"]: d for d in json.loads((MAN / "licenses.json").read_text(encoding="utf-8"))["datasets"]}
    for k, v in v1.items():
        blocked = k == "multitude"
        rows.append({"dataset_id": k, "source": v.get("source"), "revision": v.get("version"), "license": (lic.get(k) or {}).get("license") or v.get("license"),
                     "rows": v.get("rows"), "language": "multilingual (see datasets.json)", "domain": "mixed (see datasets.json)", "generator": "multiple",
                     "used_for_train": not blocked, "used_for_validation": not blocked, "used_for_test": not blocked, "used_for_holdout": not blocked,
                     "historical_only": True, "blocked": blocked, "eligible_for_reuse": "REPLAY_ONLY" if not blocked else "NO",
                     "notes": ("PENDING/BLOCKED: no access; F006.2 does not wait for it" if blocked else
                               "TURNITING_DATASET_V1 family; train split replayed through master_v2; its eval sets were observed many times")})
    for k, v in v3_sources().items():
        gated = bool(v.get("gated"))
        rows.append({"dataset_id": k, "source": v.get("url") or v.get("repo"), "revision": None, "license": v.get("license"), "rows": None,
                     "language": ",".join(v.get("language") or []), "domain": v.get("domain"), "generator": ",".join(v.get("generators") or []),
                     "used_for_train": not gated, "used_for_validation": not gated, "used_for_test": not gated, "used_for_holdout": not gated,
                     "historical_only": True, "blocked": gated, "eligible_for_reuse": "NO (gated, no HF token)" if gated else "REPLAY_ONLY",
                     "notes": "TURNITING_DATASET_V2 (V3) source" + ("; gated -> BLOCKED_ACCESS without HF_TOKEN" if gated else "")})
    f61 = json.loads((MAN / "f006_1_train_extra.json").read_text(encoding="utf-8"))
    for k in ("cc_news_es_2019", "xlsum_es_bbcmundo"):
        rows.append({"dataset_id": k, "source": {"cc_news_es_2019": "CC-NEWS-ES", "xlsum_es_bbcmundo": "csebuetnlp/xlsum (BBC Mundo)"}[k], "revision": None,
                     "license": "see reports/new_spanish_sources.json", "rows": sum(v for kk, v in f61["by_dataset_label"].items() if kk.startswith(k)),
                     "language": "es", "domain": "news", "generator": "human", "used_for_train": True, "used_for_validation": True, "used_for_test": True,
                     "used_for_holdout": True, "historical_only": True, "blocked": False, "eligible_for_reuse": "REPLAY_ONLY",
                     "notes": "F006.1 Spanish human sources (train_extra + F006.1 / F006.1.1 holdouts)"})
    f611 = json.loads((MAN / "F006_1_1_DATASET_MANIFEST.json").read_text(encoding="utf-8"))["datasets"]
    for k, v in f611.items():
        ok = v.get("status") == "DOWNLOADED"
        rows.append({"dataset_id": k, "source": v.get("source"), "revision": v.get("revision"), "license": v.get("license"), "rows": v.get("rows_after_dedup"),
                     "language": ",".join(v.get("language", {}).keys()) if isinstance(v.get("language"), dict) else v.get("language"), "domain": None,
                     "generator": ",".join(v.get("fine_labels", {}).keys()) if isinstance(v.get("fine_labels"), dict) else None,
                     "used_for_train": bool(v.get("trainEligible")), "used_for_validation": bool(v.get("validationEligible")),
                     "used_for_test": False, "used_for_holdout": bool(v.get("holdoutEligible")), "historical_only": True, "blocked": not ok,
                     "eligible_for_reuse": "REPLAY_ONLY" if ok else "NO", "notes": f"F006.1.1 source ({v.get('status')})"})
    cat = git_json("origin/exp/f006-1-3r-independent-unified", "training/reports/NEW_DATASETS_CATALOG.json")
    for c in (cat or {}).get("candidates", cat if isinstance(cat, list) else []) or []:
        if not isinstance(c, dict) or c.get("track", "A") != "A":
            continue
        rows.append({"dataset_id": c.get("dataset") or c.get("name"), "source": c.get("url"), "revision": c.get("revision"), "license": c.get("license"),
                     "rows": c.get("sample_rows"), "language": "es", "domain": None, "generator": None, "used_for_train": False, "used_for_validation": False,
                     "used_for_test": False, "used_for_holdout": False, "historical_only": True, "blocked": True, "eligible_for_reuse": "NO",
                     "notes": "F006.1.3R candidate: catalogued and sampled only, independence not certified; not part of F006.2"})
    rows.append({"dataset_id": "f006_1_1_final_holdout", "source": "MyDrive/turniting/f006_1_1/datasets/f006_1_1_final_holdout.parquet", "revision": None,
                 "license": "derived", "rows": 30363, "language": "multi (5,530 es humans)", "domain": "mixed", "generator": "multiple",
                 "used_for_train": False, "used_for_validation": False, "used_for_test": True, "used_for_holdout": True, "historical_only": True, "blocked": False,
                 "eligible_for_reuse": "REGRESSION_HOLDOUT_ONLY", "notes": "observed once at F006.1.1 final; F006.2 reports it for continuity, never for decisions"})
    return rows


LICENSES = [
    {"id": "A1", "dataset_id": "medaid_ml", "name": "MedAID-ML", "source": "https://researchdata.tuwien.ac.at/records/xr34x-tsp12 (DOI 10.20350/digitalCSIC/17276)",
     "license": "CC-BY-4.0 (record)", "license_status": "BLOCKED", "access": "RESTRICTED (files require an access request)", "train": "NO_TRAIN",
     "use": "none until access is granted", "status": "PENDING_ACCESS", "language": "en,es,de,fr", "generators": "gpt4o, mistral-7b, llama3.1",
     "notes": "official TRAIN/TEST split would be respected; license is permissive but the data is not obtainable without approval"},
    {"id": "A2", "dataset_id": "robot_talk", "name": "ROBOT-TALK (UCM)", "source": "https://www.ucm.es/robottalk/corpus-robot-talk-english",
     "license": "not stated", "license_status": "PENDING_REVIEW", "access": "no public download", "train": "NO_TRAIN", "use": "catalogue only",
     "status": "PENDING_REVIEW", "language": "es", "generators": "human, Gemini/Bard, Claude, GPT-3.5, GPT-4, Mixtral, DeepSeek",
     "notes": "3,282 texts (scientific linguistics 982, news 1,250, film reviews 1,050); high priority but rights unclear -> NO_TRAIN"},
    {"id": "A3", "dataset_id": "spanish_synthetic_2026", "name": "Spanish Synthetic Text Dataset (RAG / NO_RAG)", "source": "https://zenodo.org/records/19449815",
     "doi": "10.5281/zenodo.19449815", "license": "CC-BY-4.0", "license_status": "ALLOWED", "access": "open", "train": "ALLOWED_BUT_NOT_USED_FOR_TRAIN",
     "use": "OOD (unseen domain + unseen generators) and FINAL_EXTERNAL_HOLDOUT, split by headline", "status": "USED_EVAL_ONLY", "language": "es",
     "generators": "Ministral-3B, Qwen-2.5-0.5B, Llama-3.2-1B; RAG / NO_RAG; t = 1.0 / 0.75 / 0.5", "rows": 61374,
     "notes": "machine-only short news descriptions (median 43 words); file md5 59472f449791c0ff690a0cc473a43049"},
    {"id": "A4", "dataset_id": "txd22", "name": "TXD-22", "source": "https://data.mendeley.com/datasets/prcjcggtjf/1", "doi": "10.17632/prcjcggtjf.1",
     "license": "CC-BY-4.0", "license_status": "ALLOWED", "access": "open", "train": "NOT_NEW (historical replay only)",
     "use": "none as a new source: TXD-22 is already in TURNITING_DATASET_V2 (v3_download.SOURCES['txd22'], adapters_v2.txd22), so its rows are "
            "replayed through master_v2 like every V2 source", "status": "HISTORICAL_ALREADY_USED_IN_V2", "language": "en",
     "generators": "17 AI systems + human + 4 mixed classes", "rows": 66000,
     "notes": "single CSV sha256 232c260f8caf7ea61a331f39fa730956862afbe0c5fc554720daa07d215a2f7d; grouped by question"},
    {"id": "A5", "dataset_id": "tdx_thesis_es", "name": "TDX Thesis Spanish Corpus", "source": "https://zenodo.org/records/7313149", "doi": "10.5281/zenodo.7313149",
     "license": "Zenodo record: CC-BY-4.0; README: CC-BY-NC-SA-4.0 (the stricter one applies)", "license_status": "NON_COMMERCIAL", "access": "open",
     "train": "ALLOWED_RESEARCH (non-commercial; review before any commercial use)", "use": "HUMAN_ACADEMIC_STRONG: sampled theses, cleaned, split by whole thesis",
     "status": "USED", "language": "es", "generators": "human (theses published before 2022)", "rows": "9,790 documents / 246M tokens (sampled, not fully used)",
     "notes": "md5 c38ee282c65aee890db1d2491e5a45d7; one sentence per line, documents separated by a blank line"},
    {"id": "A6", "dataset_id": "claude_es_academic", "name": "Claude-generated Spanish academic paragraphs (this project)", "source": "Anthropic Messages Batches API",
     "license": "own generation (Anthropic usage terms)", "license_status": "ALLOWED", "access": "API key from Colab secret", "train": "ALLOWED (TRAIN / VALIDATION / CALIBRATION only)",
     "use": "AI_GENERATED / AI_REVISED / HUMAN_REVISED_BY_AI / AI_WITH_HUMAN_INSERTS / HUMAN_WITH_AI_INSERTS", "status": "USED", "language": "es",
     "generators": "newest Opus / Sonnet / Haiku from the Models API (not hardcoded)", "notes": "never used in the final holdout"},
    {"id": "H", "dataset_id": "multitude", "name": "MULTITuDE", "source": "historical", "license": "CC-BY-4.0", "license_status": "BLOCKED", "access": "gated",
     "train": "NO_TRAIN", "use": "none", "status": "PENDING_ACCESS", "notes": "kept PENDING/BLOCKED; F006.2 does not wait for it"},
]


def main() -> int:
    ex = existing()
    out = REPO / "reports"
    (out / "F006_2_EXISTING_DATA_AUDIT.json").write_text(json.dumps({"auditedAt": AUDITED, "track": "A (AI writing detection)", "rule": "none of these is presented as new data",
                                                                     "sources": ex}, indent=2, ensure_ascii=False), encoding="utf-8")
    (out / "F006_2_LICENSE_AUDIT.json").write_text(json.dumps({"auditedAt": AUDITED, "track": "A", "states": ["ALLOWED", "NON_COMMERCIAL", "RESEARCH_ONLY", "UNDECLARED",
                                                                                                             "BLOCKED", "PENDING_REVIEW"],
                                                               "rule": "UNDECLARED / PENDING_REVIEW / BLOCKED => NO_TRAIN; download != train",
                                                               "candidates": LICENSES}, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"existing sources: {len(ex)}; license candidates: {len(LICENSES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
