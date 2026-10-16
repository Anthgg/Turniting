import asyncio
import sys
from io import BytesIO
from types import SimpleNamespace

import httpx
import numpy as np
import pymupdf
import pytest
from PIL import Image, ImageDraw, ImageFont

from app.core.config import get_settings
from app.main import app
from app.services.ocr.exceptions import OcrProcessingError
from app.services.ocr.paddle_engine import PaddleOcrEngine, _bbox_from_result, engine
from app.services.ocr.processor import (
    _weighted_page_confidence,
    analyze_document,
    process_document_ocr,
)
from app.services.ocr.quality import character_error_rate, word_error_rate
from app.services.ocr.renderer import render_pdf_page
from app.services.ocr.schemas import OcrBlock, PageClassification


def _font(size: int = 42) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype("C:/Windows/Fonts/arial.ttf", size=size)
    except OSError:
        return ImageFont.load_default(size=size)


def _scan_image(text: str = "Texto sintético para probar OCR local") -> bytes:
    image = Image.new("RGB", (1400, 900), "white")
    draw = ImageDraw.Draw(image)
    draw.text((90, 130), text, font=_font(), fill=(10, 10, 10))
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _pdf_with_pages(
    *, digital: bool = True, scan: bool = True, blank: bool = True
) -> bytes:
    document = pymupdf.open()
    if digital:
        page = document.new_page()
        page.insert_text(
            (72, 96),
            "This page has enough selectable digital text to skip OCR safely.",
            fontsize=12,
        )
    if scan:
        page = document.new_page()
        page.insert_text((72, 96), "Índice", fontsize=12)
        page.insert_image(page.rect, stream=_scan_image())
    if blank:
        document.new_page()
    result = document.tobytes()
    document.close()
    return result


def test_pdf_classification_marks_digital_scanned_hybrid_and_blank_pages() -> None:
    pages = analyze_document("application/pdf", _pdf_with_pages(), get_settings())

    assert [page.classification for page in pages] == [
        PageClassification.DIGITAL_OK,
        PageClassification.HYBRID_CANDIDATE,
        PageClassification.BLANK,
    ]
    assert [page.requires_ocr for page in pages] == [False, True, False]


def test_ocr_analyze_api_returns_per_page_classifications() -> None:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
        ) as client:
            return await client.post(
                "/ocr/analyze",
                files={"file": ("synthetic.pdf", _pdf_with_pages(), "application/pdf")},
            )

    response = asyncio.run(send())
    assert response.status_code == 200
    payload = response.json()
    assert payload["pageCount"] == 3
    assert [page["classification"] for page in payload["pages"]] == [
        "DIGITAL_OK",
        "HYBRID_CANDIDATE",
        "BLANK",
    ]


def test_selective_ocr_only_calls_engine_for_visual_hybrid_page(monkeypatch) -> None:
    calls: list[tuple[float, float]] = []
    monkeypatch.setattr(engine, "_pipeline", object())

    def recognize(_image, *, settings, page_width=None, page_height=None):
        calls.append((page_width, page_height))
        return (
            [
                OcrBlock(
                    text="Texto recuperado del escaneo",
                    confidence=0.96,
                    bbox={"x0": 30, "y0": 60, "x1": 350, "y1": 90},
                    readingOrder=1,
                )
            ],
            0,
        )

    monkeypatch.setattr(engine, "recognize", recognize)
    result = process_document_ocr("application/pdf", _pdf_with_pages(), get_settings())

    assert len(calls) == 1
    assert [page.extraction_method.value for page in result.pages] == [
        "DIGITAL",
        "HYBRID",
        "NONE",
    ]
    assert result.pages_requested == 1
    assert result.pages_processed == 1
    assert result.pages_skipped == 2
    assert "Índice" in result.pages[1].canonical_text
    assert "Texto recuperado del escaneo" in result.pages[1].canonical_text


def test_paddle_warmup_disables_mkldnn_for_cpu_compatibility(
    monkeypatch, tmp_path
) -> None:
    constructor_args: dict[str, object] = {}

    def paddle_ocr(**kwargs):
        constructor_args.update(kwargs)
        return object()

    monkeypatch.setitem(
        sys.modules,
        "paddleocr",
        SimpleNamespace(PaddleOCR=paddle_ocr),
    )
    paddle = PaddleOcrEngine()
    settings = SimpleNamespace(
        ocr_model_dir=tmp_path,
        ocr_language="es",
        ocr_cpu_threads=2,
    )

    paddle.warmup(settings)

    assert constructor_args["device"] == "cpu"
    assert constructor_args["enable_mkldnn"] is False
    assert constructor_args["cpu_threads"] == 2
    assert constructor_args["text_detection_model_name"] == "PP-OCRv5_mobile_det"
    assert (
        constructor_args["text_recognition_model_name"] == "latin_PP-OCRv5_mobile_rec"
    )
    assert constructor_args["use_doc_orientation_classify"] is True
    assert constructor_args["use_textline_orientation"] is False


@pytest.mark.parametrize(
    ("content_type", "image_format"),
    [("image/png", "PNG"), ("image/jpeg", "JPEG")],
)
def test_raster_formats_are_detected_as_single_ocr_pages(
    content_type, image_format
) -> None:
    output = BytesIO()
    Image.new("RGB", (500, 300), "white").save(output, format=image_format)
    page = analyze_document(content_type, output.getvalue(), get_settings())[0]
    assert page.page_number == 1
    assert page.classification == PageClassification.BLANK
    assert page.requires_ocr is False


def test_raster_mime_and_signature_mismatch_is_rejected() -> None:
    output = BytesIO()
    Image.new("RGB", (300, 200), "white").save(output, format="JPEG")
    with pytest.raises(OcrProcessingError, match="declared MIME"):
        analyze_document("image/png", output.getvalue(), get_settings())


def test_digital_and_blank_only_documents_do_not_initialize_or_call_ocr(
    monkeypatch,
) -> None:
    calls = 0

    def fail_if_called(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise AssertionError("OCR must be skipped")

    monkeypatch.setattr(engine, "warmup", fail_if_called)
    monkeypatch.setattr(engine, "recognize", fail_if_called)
    for content in (
        _pdf_with_pages(scan=False, blank=False),
        _pdf_with_pages(digital=False, scan=False),
    ):
        with pytest.raises(OcrProcessingError, match="No pages require OCR"):
            process_document_ocr("application/pdf", content, get_settings())
    assert calls == 0


def test_ocr_page_limit_rejects_large_explicit_forced_selection() -> None:
    settings = get_settings().model_copy(update={"ocr_max_pages_per_run": 1})
    with pytest.raises(
        OcrProcessingError, match="request exceeds the 1-page OCR limit"
    ) as error:
        process_document_ocr(
            "application/pdf",
            _pdf_with_pages(),
            settings,
            requested_pages=[1, 2],
            force=True,
        )
    assert error.value.code == "OCR_PAGE_LIMIT_EXCEEDED"


def test_pdf_render_pixel_limit_returns_controlled_error() -> None:
    document = pymupdf.open(stream=_pdf_with_pages(), filetype="pdf")
    try:
        with pytest.raises(OcrProcessingError) as error:
            render_pdf_page(document[1], dpi=250, max_pixels=100_000)
    finally:
        document.close()
    assert error.value.code == "OCR_IMAGE_TOO_LARGE"


def test_image_pixel_limit_returns_controlled_error() -> None:
    output = BytesIO()
    Image.new("RGB", (400, 300), "white").save(output, format="PNG")
    settings = get_settings().model_copy(update={"ocr_max_render_pixels": 100_000})
    with pytest.raises(OcrProcessingError) as error:
        analyze_document("image/png", output.getvalue(), settings)
    assert error.value.code == "OCR_IMAGE_TOO_LARGE"


def test_document_confidence_is_weighted_by_recognized_characters() -> None:
    confidence, characters = _weighted_page_confidence(
        [
            OcrBlock(
                text="x",
                confidence=0.30,
                bbox={"x0": 0, "y0": 0, "x1": 1, "y1": 1},
                readingOrder=1,
            ),
            OcrBlock(
                text="yyyy",
                confidence=0.90,
                bbox={"x0": 0, "y0": 2, "x1": 4, "y1": 3},
                readingOrder=2,
            ),
            OcrBlock(
                text="ignored",
                confidence=None,
                bbox={"x0": 0, "y0": 4, "x1": 7, "y1": 5},
                readingOrder=3,
            ),
        ]
    )
    assert confidence == pytest.approx(0.78)
    assert characters == 5


def test_paddle_result_bbox_is_parsed_and_scaled_to_pdf_points() -> None:
    assert _bbox_from_result(
        0,
        [[[10, 20], [110, 20], [110, 60], [10, 60]]],
        [],
    ) == {"x0": 10.0, "y0": 20.0, "x1": 110.0, "y1": 60.0}

    fake_result = SimpleNamespace(
        json={
            "res": {
                "rec_texts": ["Texto"],
                "rec_scores": [0.91],
                "rec_polys": [[[10, 20], [110, 20], [110, 60], [10, 60]]],
            }
        }
    )
    paddle = PaddleOcrEngine()
    paddle._pipeline = SimpleNamespace(predict=lambda _image: [fake_result])
    blocks, _ = paddle.recognize(
        np.zeros((100, 200, 3), dtype=np.uint8),
        settings=get_settings(),
        page_width=100,
        page_height=50,
    )
    assert len(blocks) == 1
    assert blocks[0].bbox == {"x0": 5, "y0": 10, "x1": 55, "y1": 30}
    assert blocks[0].confidence == pytest.approx(0.91)


def test_quality_metrics_are_unicode_normalized_and_report_real_edits() -> None:
    assert character_error_rate("Información útil", "información   útil") == 0
    assert word_error_rate(
        "el análisis está listo", "el análisis esta listo"
    ) == pytest.approx(0.25)
    assert character_error_rate("turnitin", "turnitln") == pytest.approx(0.125)
