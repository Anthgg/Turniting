from dataclasses import dataclass

import cv2
import numpy as np

from app.core.config import Settings


@dataclass(frozen=True)
class PreprocessResult:
    image: np.ndarray
    deskew_angle: float
    contrast_enhanced: bool


def preprocess_image(image: np.ndarray, settings: Settings) -> PreprocessResult:
    if image.ndim == 2:
        gray = image
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)

    low, high = np.percentile(gray, (5, 95))
    contrast_enhanced = high - low < settings.ocr_contrast_range
    if contrast_enhanced:
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)

    angle = _estimate_skew(gray)
    if abs(angle) >= settings.ocr_deskew_min_angle:
        height, width = gray.shape[:2]
        transform = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1)
        gray = cv2.warpAffine(
            gray,
            transform,
            (width, height),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=255,
        )
    else:
        angle = 0.0

    return PreprocessResult(
        image=cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR),
        deskew_angle=round(float(angle), 3),
        contrast_enhanced=contrast_enhanced,
    )


def visual_ink_ratio(image: np.ndarray) -> float:
    if image.ndim == 2:
        gray = image
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    return float(np.count_nonzero(gray < 245) / max(gray.size, 1))


def _estimate_skew(gray: np.ndarray) -> float:
    height, width = gray.shape[:2]
    scale = min(1.0, 1200 / max(width, height))
    small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    binary = cv2.threshold(small, 190, 255, cv2.THRESH_BINARY_INV)[1]
    lines = cv2.HoughLinesP(
        binary,
        rho=1,
        theta=np.pi / 1800,
        threshold=80,
        minLineLength=max(30, int(small.shape[1] * 0.08)),
        maxLineGap=10,
    )
    if lines is None:
        return 0.0

    angles: list[float] = []
    for line in np.asarray(lines).reshape(-1, 4):
        x1, y1, x2, y2 = (int(value) for value in line)
        if x1 == x2:
            continue
        angle = float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
        if -12 <= angle <= 12:
            angles.append(angle)
    if len(angles) < 2:
        return 0.0
    return float(np.median(angles))
