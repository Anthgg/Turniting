import json
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.core.config import get_settings
from app.services.ocr.paddle_engine import engine


def main() -> None:
    settings = get_settings()
    settings.ocr_model_dir.mkdir(parents=True, exist_ok=True)
    canvas = Image.new("RGB", (960, 256), "white")
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (48, 88),
        "OCR LOCAL ESPANOL 123",
        fill="black",
        font=ImageFont.load_default(size=32),
    )
    image = np.asarray(canvas)
    started = time.perf_counter()
    engine.warmup(settings)
    blocks, _ = engine.recognize(
        image,
        settings=settings,
        page_width=float(image.shape[1]),
        page_height=float(image.shape[0]),
    )
    if not blocks:
        raise SystemExit("The local OCR warmup image produced no text blocks.")
    marker = settings.ocr_model_dir / ".f003-model-ready"
    temporary_marker = marker.with_suffix(".tmp")
    temporary_marker.write_text("f003-v1\n", encoding="utf-8")
    temporary_marker.replace(marker)
    metadata = engine.metadata(settings)
    print(
        json.dumps(
            {
                **metadata,
                "modelReady": engine.ready,
                "warmupMs": round((time.perf_counter() - started) * 1000),
                "syntheticBlocks": len(blocks),
                "cacheMarker": str(marker),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
