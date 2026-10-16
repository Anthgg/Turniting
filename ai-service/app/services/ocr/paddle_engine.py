import importlib.metadata
import os
import threading
from typing import Any

import numpy as np

from app.core.config import Settings
from app.services.ocr.exceptions import OcrProcessingError
from app.services.ocr.reading_order import sort_reading_order
from app.services.ocr.schemas import OcrBlock


class PaddleOcrEngine:
    def __init__(self) -> None:
        self._pipeline: Any | None = None
        self._lock = threading.RLock()
        self._settings: Settings | None = None
        self._load_duration_ms: int | None = None

    @property
    def ready(self) -> bool:
        return self._pipeline is not None

    @property
    def load_duration_ms(self) -> int | None:
        return self._load_duration_ms

    def metadata(self, settings: Settings) -> dict[str, str]:
        try:
            version = importlib.metadata.version("paddleocr")
        except importlib.metadata.PackageNotFoundError:
            version = "unavailable"
        return {
            "engine": settings.ocr_engine,
            "engineVersion": version,
            "model": settings.ocr_model,
            "language": settings.ocr_language,
            "pipelineVersion": settings.ocr_pipeline_version,
        }

    def warmup(self, settings: Settings) -> int:
        import time

        with self._lock:
            if self._pipeline is not None:
                return self._load_duration_ms or 0
            started = time.perf_counter()
            try:
                settings.ocr_model_dir.mkdir(parents=True, exist_ok=True)
                model_root = str(settings.ocr_model_dir.resolve())
                os.environ["PADDLE_PDX_CACHE_HOME"] = model_root
                from paddleocr import PaddleOCR

                self._pipeline = PaddleOCR(
                    text_detection_model_name="PP-OCRv5_mobile_det",
                    text_recognition_model_name="latin_PP-OCRv5_mobile_rec",
                    device="cpu",
                    enable_mkldnn=False,
                    cpu_threads=settings.ocr_cpu_threads,
                    use_doc_orientation_classify=True,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                )
                self._settings = settings
                self._load_duration_ms = round((time.perf_counter() - started) * 1000)
                return self._load_duration_ms
            except Exception as error:
                self._pipeline = None
                error_type = type(error).__name__
                raise OcrProcessingError(
                    "OCR_ENGINE_NOT_READY",
                    "The local PaddleOCR engine could not be initialized "
                    f"({error_type}).",
                    503,
                ) from None

    def recognize(
        self,
        image: np.ndarray,
        *,
        settings: Settings,
        page_width: float | None = None,
        page_height: float | None = None,
    ) -> tuple[list[OcrBlock], int | None]:
        if self._pipeline is None:
            self.warmup(settings)
        if self._pipeline is None:
            raise OcrProcessingError(
                "OCR_ENGINE_NOT_READY", "The OCR engine is not ready.", 503
            )
        try:
            raw_results = self._pipeline.predict(image)
            if raw_results is None:
                raw_results = []
            if not isinstance(raw_results, (list, tuple)):
                raw_results = [raw_results]
            result_data = _extract_result_data(raw_results[0]) if raw_results else {}
            texts = result_data.get("rec_texts", [])
            scores = result_data.get("rec_scores", [])
            polygons = result_data.get("rec_polys", [])
            boxes = result_data.get("rec_boxes", [])

            width = page_width or float(image.shape[1])
            height = page_height or float(image.shape[0])
            blocks: list[dict[str, Any]] = []
            for index, text in enumerate(texts):
                safe_text = str(text).replace("\x00", "").strip()
                if not safe_text:
                    continue
                confidence = _confidence(scores[index]) if index < len(scores) else None
                bbox = _bbox_from_result(index, polygons, boxes)
                if bbox is None:
                    continue
                bbox = {
                    "x0": max(0.0, min(bbox["x0"], float(image.shape[1]))),
                    "y0": max(0.0, min(bbox["y0"], float(image.shape[0]))),
                    "x1": max(0.0, min(bbox["x1"], float(image.shape[1]))),
                    "y1": max(0.0, min(bbox["y1"], float(image.shape[0]))),
                }
                blocks.append(
                    {
                        "text": safe_text,
                        "confidence": confidence,
                        "bbox": {
                            "x0": bbox["x0"] * width / max(image.shape[1], 1),
                            "y0": bbox["y0"] * height / max(image.shape[0], 1),
                            "x1": bbox["x1"] * width / max(image.shape[1], 1),
                            "y1": bbox["y1"] * height / max(image.shape[0], 1),
                        },
                    }
                )
            ordered = sort_reading_order(blocks, width)
            ocr_blocks = [
                OcrBlock(
                    text=block["text"],
                    confidence=block["confidence"],
                    bbox=block["bbox"],
                    readingOrder=index,
                    lowConfidence=(
                        block["confidence"] is not None
                        and block["confidence"] < settings.ocr_low_confidence_threshold
                    ),
                )
                for index, block in enumerate(ordered, start=1)
            ]
            angle = _orientation_angle(result_data)
            return ocr_blocks, angle
        except OcrProcessingError:
            raise
        except Exception as error:
            raise OcrProcessingError(
                "OCR_PROCESSING_FAILED",
                f"PaddleOCR failed to process a page ({type(error).__name__}).",
                422,
            ) from None


def _extract_result_data(result: Any) -> dict[str, Any]:
    data: Any = result
    if hasattr(result, "json"):
        data = result.json
        if callable(data):
            data = data()
    if isinstance(data, dict) and isinstance(data.get("res"), dict):
        data = data["res"]
    return data if isinstance(data, dict) else {}


def _bbox_from_result(
    index: int,
    polygons: Any,
    boxes: Any,
) -> dict[str, float] | None:
    try:
        if len(polygons) > index:
            points = np.asarray(polygons[index], dtype=float).reshape(-1, 2)
            return {
                "x0": float(points[:, 0].min()),
                "y0": float(points[:, 1].min()),
                "x1": float(points[:, 0].max()),
                "y1": float(points[:, 1].max()),
            }
        if len(boxes) > index:
            values = np.asarray(boxes[index], dtype=float).reshape(-1)
            if values.size >= 4:
                return {
                    "x0": float(values[0]),
                    "y0": float(values[1]),
                    "x1": float(values[2]),
                    "y1": float(values[3]),
                }
    except (TypeError, ValueError, IndexError):
        return None
    return None


def _confidence(value: Any) -> float | None:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return None
    if not 0 <= confidence <= 1:
        if 0 <= confidence <= 100:
            confidence /= 100
        else:
            return None
    return confidence


def _orientation_angle(data: dict[str, Any]) -> int | None:
    preprocessing = data.get("doc_preprocessor_res")
    if not isinstance(preprocessing, dict):
        return None
    value = preprocessing.get("angle")
    try:
        angle = int(value)
    except (TypeError, ValueError):
        return None
    return angle if angle in {0, 90, 180, 270} else None


engine = PaddleOcrEngine()
