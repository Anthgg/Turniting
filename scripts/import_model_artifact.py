#!/usr/bin/env python3
"""Import a trained model directory into the local, Git-ignored model store (F005).

    python scripts/import_model_artifact.py --model CANDIDATE_MODEL_V3 --source "C:\\ruta\\al\\modelo"

Checks the manifest and required files, copies them unchanged (weights are never modified)
to data/models/<slug>/, writes per-file SHA-256 to data/models/<slug>/IMPORT_MANIFEST.json
and prints the AI_MODEL_*_PATH value to configure. Credentials-like files are refused.
Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STORE = REPO / "data" / "models"
TOKENIZER = ("spm.model", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
             "added_tokens.json")
MODELS = {
    "CANDIDATE_MODEL_V2": {
        "slug": "candidate-v2", "env": "AI_MODEL_V2_PATH",
        "required": ["config.json", "model.safetensors", "inference_config.json", "thresholds.json",
                     "model_manifest.json"],
        "optional": ["calibration.json", *TOKENIZER],
        "tokenizer_dir": "",
    },
    "CANDIDATE_MODEL_V3": {
        "slug": "candidate-v3", "env": "AI_MODEL_V3_PATH",
        "required": ["backbone/config.json", "backbone/model.safetensors", "heads.pt", "v3_config.json",
                     "inference_config.json", "thresholds.json", "model_manifest.json"],
        "optional": ["calibration.json", *[f"backbone/{t}" for t in TOKENIZER]],
        "tokenizer_dir": "backbone/",
    },
    "BEST_BASELINE": {
        "slug": "baseline", "env": "AI_BASELINE_MODEL_PATH",
        "required": ["model.joblib"],
        "optional": ["thresholds.json", "model_manifest.json"],
        "tokenizer_dir": None,
    },
}
FORBIDDEN = ("token", "credential", "secret", ".env", "service-account", ".pem", ".key")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while block := handle.read(8 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=sorted(MODELS))
    ap.add_argument("--source", required=True, type=Path)
    ap.add_argument("--force", action="store_true", help="replace an existing import")
    args = ap.parse_args()
    spec = MODELS[args.model]
    src = args.source.expanduser().resolve()
    if not src.is_dir():
        print(f"ERROR: source directory not found: {src}", file=sys.stderr)
        return 2
    missing = [rel for rel in spec["required"] if not (src / rel).is_file()]
    if spec["tokenizer_dir"] is not None and not any(
            (src / f"{spec['tokenizer_dir']}{t}").is_file() for t in ("spm.model", "tokenizer.json")):
        missing.append(f"{spec['tokenizer_dir']}spm.model or tokenizer.json")
    if missing:
        print(f"ERROR: missing required files: {missing}", file=sys.stderr)
        return 3
    if spec["tokenizer_dir"] is not None:
        manifest = json.loads((src / "model_manifest.json").read_text(encoding="utf-8"))
        icfg = json.loads((src / "inference_config.json").read_text(encoding="utf-8"))
        if "max_length" not in icfg or "aggregation" not in icfg:
            print("ERROR: inference_config.json lacks max_length/aggregation", file=sys.stderr)
            return 4
    else:
        manifest = {}
    files = [rel for rel in spec["required"] + spec["optional"] if (src / rel).is_file()]
    bad = [rel for rel in files if any(f in rel.lower() for f in FORBIDDEN) and "tokenizer" not in rel.lower()
           and "tokens_map" not in rel.lower() and "added_tokens" not in rel.lower()]
    if bad:
        print(f"ERROR: refusing credential-like files: {bad}", file=sys.stderr)
        return 5
    dst = STORE / spec["slug"]
    if dst.exists():
        if not args.force:
            print(f"ERROR: {dst} exists (use --force to replace)", file=sys.stderr)
            return 6
        shutil.rmtree(dst)
    record = {"model": args.model, "importedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "sourceName": src.name, "variant": manifest.get("variant"), "modelVersion": manifest.get("modelVersion"),
              "files": {}}
    for rel in files:
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / rel, target)
        digest = sha256(target)
        if digest != sha256(src / rel):
            print(f"ERROR: copy verification failed for {rel}", file=sys.stderr)
            return 7
        record["files"][rel] = {"sha256": digest, "bytes": target.stat().st_size}
        print(f"  {rel}  {digest[:16]}  {target.stat().st_size / 1e6:.1f} MB")
    (dst / "IMPORT_MANIFEST.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    print(f"imported {args.model} -> {dst}")
    print(f"configure: {spec['env']}={dst}   (Docker: /data/models/local/{spec['slug']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
