"""Score one text with a saved detector.

    python scripts/predict.py --model models/transformer/best --text "..."
    python scripts/predict.py --model models/baseline/best --file sample.txt
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.detector import Detector  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--text")
    group.add_argument("--file")
    ap.add_argument("--threshold", default="BALANCED",
                    choices=["BALANCED", "LOW_FALSE_POSITIVE", "HIGH_PRECISION_AI"])
    args = ap.parse_args()
    text = args.text if args.text is not None else Path(args.file).read_text(encoding="utf-8")
    result = Detector(args.model, args.threshold).predict([text])[0]
    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
