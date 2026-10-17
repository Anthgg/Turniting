"""Bundle what a GPU host needs to train/evaluate without rebuilding the dataset:
master parquet shards, manifests, frozen eval-set ids and the Spanish-weight selection.

    python scripts/export_for_colab.py            # -> datasets/cache/turniting_colab_bundle.zip

Upload the zip to Google Drive (e.g. MyDrive/turniting/) and open notebooks/colab_train.ipynb.
Only public-dataset material is included; no Turnitin reports or private files.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from turniting_train.common import CACHE_DIR, MANIFEST_DIR, MODELS_DIR, NORMALIZED_DIR, TRAINING_DIR, ensure_disk  # noqa: E402


def main() -> int:
    files = sorted((NORMALIZED_DIR / "master").rglob("*.parquet"))
    files += sorted(MANIFEST_DIR.glob("*.json"))
    files += [MODELS_DIR / "eval_sets.parquet", MODELS_DIR / "baseline" / "spanish_weight_selection.json"]
    size = sum(f.stat().st_size for f in files)
    ensure_disk(size / 1e9, "colab bundle")
    out = CACHE_DIR / "turniting_colab_bundle.zip"
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as zf:  # parquet is already compressed
        for f in files:
            zf.write(f, f.relative_to(TRAINING_DIR).as_posix())
    print(f"{out} ({out.stat().st_size / 1e9:.2f} GB, {len(files)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
