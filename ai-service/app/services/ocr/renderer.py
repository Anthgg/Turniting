import math
import warnings
from io import BytesIO

import numpy as np
import pymupdf
from PIL import Image, ImageOps

from app.services.ocr.exceptions import OcrProcessingError


def render_pdf_page(
    page: pymupdf.Page,
    *,
    dpi: int,
    max_pixels: int,
) -> tuple[np.ndarray, int]:
    rectangle = page.rect
    expected_width = rectangle.width * dpi / 72
    expected_height = rectangle.height * dpi / 72
    expected_pixels = expected_width * expected_height
    actual_dpi = dpi
    if expected_pixels > max_pixels:
        actual_dpi = math.floor(dpi * math.sqrt(max_pixels / expected_pixels))
    if actual_dpi < 72:
        raise OcrProcessingError(
            "OCR_IMAGE_TOO_LARGE",
            "The page cannot be rendered within the configured pixel limit.",
            413,
        )

    pixmap = page.get_pixmap(
        matrix=pymupdf.Matrix(actual_dpi / 72, actual_dpi / 72),
        colorspace=pymupdf.csRGB,
        alpha=False,
    )
    try:
        if pixmap.width * pixmap.height > max_pixels:
            raise OcrProcessingError(
                "OCR_IMAGE_TOO_LARGE",
                "The rendered page exceeds the configured pixel limit.",
                413,
            )
        samples = np.frombuffer(pixmap.samples, dtype=np.uint8)
        return samples.reshape(pixmap.height, pixmap.width, pixmap.n).copy(), actual_dpi
    finally:
        del pixmap


def load_image(content: bytes, *, max_pixels: int) -> tuple[np.ndarray, str]:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as source:
                image_format = (source.format or "").upper()
                if image_format not in {"PNG", "JPEG"}:
                    raise OcrProcessingError(
                        "OCR_UNSUPPORTED_FORMAT",
                        "Only PNG and JPEG images are supported for OCR.",
                        415,
                    )
                width, height = source.size
                if width < 1 or height < 1 or width * height > max_pixels:
                    raise OcrProcessingError(
                        "OCR_IMAGE_TOO_LARGE",
                        "The image exceeds the configured pixel limit.",
                        413,
                    )
                source.verify()
            with Image.open(BytesIO(content)) as source:
                oriented = ImageOps.exif_transpose(source).convert("RGB")
                if oriented.width * oriented.height > max_pixels:
                    raise OcrProcessingError(
                        "OCR_IMAGE_TOO_LARGE",
                        "The oriented image exceeds the configured pixel limit.",
                        413,
                    )
                return np.asarray(oriented).copy(), image_format.lower()
    except OcrProcessingError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise OcrProcessingError(
            "OCR_IMAGE_TOO_LARGE",
            "The image exceeds the configured pixel limit.",
            413,
        ) from None
    except Exception:
        raise OcrProcessingError(
            "OCR_CORRUPT_IMAGE",
            "The image file is corrupt or could not be decoded.",
            422,
        ) from None
