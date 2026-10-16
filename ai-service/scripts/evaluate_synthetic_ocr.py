import json
import resource
import sys
import time
from pathlib import Path

from app.core.config import get_settings
from app.services.ocr.exceptions import OcrProcessingError
from app.services.ocr.paddle_engine import engine
from app.services.ocr.processor import analyze_document, process_document_ocr
from app.services.ocr.quality import character_error_rate, word_error_rate
from app.services.turnitin.parser import parse_turnitin_ocr_pages

CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
}


def _max_memory_mb() -> float | None:
    if sys.platform == "win32":
        return None
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def evaluate(directory: Path) -> dict[str, object]:
    settings = get_settings()
    expected: dict[str, list[str]] = json.loads(
        (directory / "ground_truth.json").read_text(encoding="utf-8")
    )
    results: dict[str, object] = {}
    total_ocr_pages = 0
    total_ocr_ms = 0
    classifications: dict[str, int] = {}
    recognition_calls = 0
    original_recognize = engine.recognize

    def counted_recognize(*args, **kwargs):
        nonlocal recognition_calls
        recognition_calls += 1
        return original_recognize(*args, **kwargs)

    engine.recognize = counted_recognize

    try:
        for name, expected_pages in expected.items():
            path = directory / name
            content = path.read_bytes()
            media_type = CONTENT_TYPES[path.suffix.lower()]
            analysis = analyze_document(media_type, content, settings)
            for page in analysis:
                key = page.classification.value
                classifications[key] = classifications.get(key, 0) + 1

            calls_before = recognition_calls
            try:
                processed = process_document_ocr(media_type, content, settings)
                actual_pages = [page.canonical_text for page in processed.pages]
                pages_requested = processed.pages_requested
                pages_processed = processed.pages_processed
                pages_skipped = processed.pages_skipped
                pages_failed = processed.pages_failed
                page_processing_ms = [page.processing_ms for page in processed.pages]
                extraction_methods = [
                    page.extraction_method.value for page in processed.pages
                ]
                confidences = [page.confidence for page in processed.pages]
                deskew_angles = [page.deskew_angle for page in processed.pages]
                bbox_count = sum(len(page.blocks) for page in processed.pages)
                invalid_bbox_count = sum(
                    not (
                        block.bbox["x0"] < block.bbox["x1"]
                        and block.bbox["y0"] < block.bbox["y1"]
                        and block.bbox["x0"] >= 0
                        and block.bbox["y0"] >= 0
                        and block.bbox["x1"] <= page.width
                        and block.bbox["y1"] <= page.height
                    )
                    for page in processed.pages
                    for block in page.blocks
                )
                low_confidence_blocks = sum(
                    block.low_confidence
                    for page in processed.pages
                    for block in page.blocks
                )
                warnings = processed.warnings
                page_pairs = list(zip(processed.pages, analysis, strict=True))
                status = "success"
            except OcrProcessingError as error:
                if error.code != "OCR_NOT_REQUIRED":
                    raise
                actual_pages = [page.canonical_text for page in analysis]
                pages_requested = pages_processed = pages_failed = 0
                pages_skipped = len(analysis)
                page_processing_ms = [0] * len(analysis)
                extraction_methods = [page.extraction_method.value for page in analysis]
                confidences = [None] * len(analysis)
                deskew_angles = [0.0] * len(analysis)
                bbox_count = 0
                invalid_bbox_count = 0
                low_confidence_blocks = 0
                warnings = []
                page_pairs = []
                status = "OCR_NOT_REQUIRED"

            compared = [
                (truth, actual)
                for truth, actual in zip(expected_pages, actual_pages, strict=True)
                if truth
            ]
            cer = sum(
                character_error_rate(truth, actual) for truth, actual in compared
            ) / max(len(compared), 1)
            wer = sum(
                word_error_rate(truth, actual) for truth, actual in compared
            ) / max(len(compared), 1)
            total_ocr_pages += pages_processed
            total_ocr_ms += sum(page_processing_ms)
            unnecessary_ocr = [
                page.page_number
                for page, classified in page_pairs
                if classified.classification.value in {"DIGITAL_OK", "BLANK"}
                and page.processing_ms > 0
            ]
            results[name] = {
                "status": status,
                "classification": [page.classification.value for page in analysis],
                "pagesRequested": pages_requested,
                "pagesProcessed": pages_processed,
                "pagesSkipped": pages_skipped,
                "pagesFailed": pages_failed,
                "ocrCallCount": recognition_calls - calls_before,
                "unnecessaryOcrPages": unnecessary_ocr,
                "extractionMethods": extraction_methods,
                "cer": round(cer, 4),
                "wer": round(wer, 4),
                "confidence": confidences,
                "deskewAngles": deskew_angles,
                "bboxCount": bbox_count,
                "invalidBboxCount": invalid_bbox_count,
                "lowConfidenceBlocks": low_confidence_blocks,
                "warnings": warnings,
                "pageProcessingMs": page_processing_ms,
                "canonicalText": actual_pages,
                "canonicalWordCount": sum(
                    len(actual.split()) for actual in actual_pages
                ),
                "canonicalCharacterCount": sum(map(len, actual_pages)),
            }
    finally:
        engine.recognize = original_recognize

    clean = results["clean.pdf"]
    rotated_90 = results["rotated_90.pdf"]
    digital = results["digital.pdf"]
    turnitin_text = results["turnitin_scanned.pdf"]["canonicalText"]
    turnitin_fallback = parse_turnitin_ocr_pages(turnitin_text)
    ai_score = turnitin_fallback.scores.get("aiWriting")
    report = {
        "engine": engine.metadata(settings),
        "modelInitMs": engine.load_duration_ms,
        "averageOcrPageMs": round(total_ocr_ms / max(total_ocr_pages, 1)),
        "maxMemoryMb": _max_memory_mb(),
        "classifications": classifications,
        "results": results,
        "turnitinOcrFallback": {
            "status": turnitin_fallback.status,
            "reportType": turnitin_fallback.reportType,
            "aiWritingScore": ai_score.model_dump(mode="json", by_alias=True)
            if ai_score
            else None,
            "sourceCount": len(turnitin_fallback.sources),
            "segmentCount": len(turnitin_fallback.segments),
            "bboxCount": sum(
                bool(segment.bbox) for segment in turnitin_fallback.segments
            ),
            "warnings": turnitin_fallback.warnings,
        },
        "acceptance": {
            "cleanCerLe005": clean["cer"] <= 0.05,
            "cleanWerLe010": clean["wer"] <= 0.10,
            "rotated90CerLe010": rotated_90["cer"] <= 0.10,
            "rotated90WerLe015": rotated_90["wer"] <= 0.15,
            "digitalOcrCallsZero": digital["ocrCallCount"] == 0,
            "hybridUsesHybridMethod": "HYBRID"
            in results["hybrid.pdf"]["extractionMethods"],
            "turnitinOcrScoreRecovered": ai_score is not None
            and turnitin_fallback.reportType == "AI_WRITING",
            "turnitinOcrGeometryNotInvented": not turnitin_fallback.segments
            and not turnitin_fallback.sources,
            "digitalAndBlankSkipped": all(
                not result["unnecessaryOcrPages"] for result in results.values()
            ),
            "noPageFailures": all(
                result["pagesFailed"] == 0 for result in results.values()
            ),
        },
    }
    return report


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: evaluate_synthetic_ocr.py FIXTURE_DIRECTORY")
    started = time.perf_counter()
    report = evaluate(Path(sys.argv[1]))
    report["evaluationMs"] = round((time.perf_counter() - started) * 1000)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
