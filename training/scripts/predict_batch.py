"""Batch scoring for CSV or JSONL inputs (local only; not wired to the Turniting API).

    python scripts/predict_batch.py --model models/transformer/best --input in.csv --output out.jsonl
    python scripts/predict_batch.py --model models/baseline/best --input in.jsonl --text-field content
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.detector import Detector  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--input", required=True, help=".csv or .jsonl")
    ap.add_argument("--output", help=".jsonl or .csv (default: stdout jsonl)")
    ap.add_argument("--text-field", default="text")
    ap.add_argument("--id-field", default="id")
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--threshold", default="BALANCED",
                    choices=["BALANCED", "LOW_FALSE_POSITIVE", "HIGH_PRECISION_AI"])
    args = ap.parse_args()
    path = Path(args.input)
    if path.suffix.lower() == ".csv":
        df = pd.read_csv(path, dtype=str, keep_default_na=False)
    elif path.suffix.lower() in (".jsonl", ".json"):
        df = pd.read_json(path, lines=True, dtype=False)
    else:
        raise SystemExit("input must be .csv or .jsonl")
    if args.text_field not in df:
        raise SystemExit(f"missing column {args.text_field!r}")
    detector = Detector(args.model, args.threshold)
    results = []
    texts = df[args.text_field].fillna("").astype(str).tolist()
    for start in range(0, len(texts), args.batch_size):
        results.extend(detector.predict(texts[start:start + args.batch_size]))
    out = pd.DataFrame(results)
    if args.id_field in df:
        out.insert(0, "id", df[args.id_field].values)
    if args.output and args.output.lower().endswith(".csv"):
        out.to_csv(args.output, index=False)
    else:
        lines = "\n".join(json.dumps(r, ensure_ascii=False) for r in out.to_dict("records")) + "\n"
        if args.output:
            Path(args.output).write_text(lines, encoding="utf-8")
        else:
            sys.stdout.write(lines)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
