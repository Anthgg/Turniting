import argparse
import json
from io import BytesIO
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFont

GROUND_TRUTH = [
    "Informe de investigación documental",
    "El análisis de datos confirma la información del estudio.",
    "Los resultados son claros y reproducibles.",
    "Universidad Nacional de San Marcos, 2026.",
]
TURNITIN_GROUND_TRUTH = [
    "67% AI writing",
    "trn:oid:::12345:67890",
    "12 páginas",
    "500 palabras",
    "3000 caracteres",
]


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _render_text_image(
    lines: list[str] = GROUND_TRUTH,
    *,
    foreground: tuple[int, int, int] = (12, 12, 12),
    background: tuple[int, int, int] = (255, 255, 255),
    rotation: float = 0,
) -> Image.Image:
    image = Image.new("RGB", (1600, 1100), background)
    draw = ImageDraw.Draw(image)
    font = _font(54)
    line_spacing = 112
    for index, line in enumerate(lines):
        draw.text(
            (100, 170 + index * line_spacing),
            line,
            font=font,
            fill=foreground,
            stroke_width=0,
        )
    return image.rotate(
        rotation,
        resample=Image.Resampling.BICUBIC,
        expand=abs(rotation) in {90, 270},
        fillcolor=background,
    )


def _encode_image(image: Image.Image, file_format: str) -> bytes:
    output = BytesIO()
    image.save(output, format=file_format, quality=95)
    return output.getvalue()


def _write_image_pdf(path: Path, image: Image.Image, *, dpi: int = 250) -> None:
    document = pymupdf.open()
    width_points = image.width * 72 / dpi
    height_points = image.height * 72 / dpi
    page = document.new_page(width=width_points, height=height_points)
    page.insert_image(page.rect, stream=_encode_image(image, "PNG"))
    document.save(path)
    document.close()


def _write_hybrid_pdf(path: Path, image: Image.Image, *, dpi: int = 250) -> None:
    document = pymupdf.open()
    width_points = image.width * 72 / dpi
    height_points = image.height * 72 / dpi

    digital = document.new_page(width=width_points, height=height_points)
    digital.insert_text(
        (72, 80),
        "Este contenido digital tiene texto suficiente para omitir OCR.",
        fontsize=12,
    )

    scanned = document.new_page(width=width_points, height=height_points)
    scanned.insert_image(scanned.rect, stream=_encode_image(image, "PNG"))

    document.new_page(width=width_points, height=height_points)

    hybrid = document.new_page(width=width_points, height=height_points)
    hybrid.insert_image(hybrid.rect, stream=_encode_image(image, "PNG"))
    hybrid.insert_text((72, 80), "Anexo digital", fontsize=12)

    document.save(path)
    document.close()


def _write_digital_pdf(path: Path) -> str:
    text = "Este documento contiene texto digital suficiente para omitir OCR."
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((72, 96), text, fontsize=12)
    document.save(path)
    document.close()
    return text


def create_fixtures(directory: Path) -> dict[str, object]:
    directory.mkdir(parents=True, exist_ok=True)
    clean_image = _render_text_image()
    rotated_image = _render_text_image(rotation=3.0)
    rotated_90_image = _render_text_image(rotation=90)
    low_contrast_image = _render_text_image(
        foreground=(215, 215, 215),
        background=(244, 244, 244),
    )
    turnitin_image = _render_text_image(lines=TURNITIN_GROUND_TRUTH)

    _write_image_pdf(directory / "clean.pdf", clean_image)
    _write_image_pdf(directory / "rotated.pdf", rotated_image)
    _write_image_pdf(directory / "rotated_90.pdf", rotated_90_image)
    _write_image_pdf(directory / "low_contrast.pdf", low_contrast_image)
    _write_hybrid_pdf(directory / "hybrid.pdf", clean_image)
    _write_image_pdf(directory / "turnitin_scanned.pdf", turnitin_image)
    digital_text = _write_digital_pdf(directory / "digital.pdf")
    (directory / "clean.png").write_bytes(_encode_image(clean_image, "PNG"))
    (directory / "clean.jpg").write_bytes(_encode_image(clean_image, "JPEG"))

    expected = {
        "clean.pdf": ["\n".join(GROUND_TRUTH)],
        "rotated.pdf": ["\n".join(GROUND_TRUTH)],
        "rotated_90.pdf": ["\n".join(GROUND_TRUTH)],
        "low_contrast.pdf": ["\n".join(GROUND_TRUTH)],
        "digital.pdf": [digital_text],
        "turnitin_scanned.pdf": ["\n".join(TURNITIN_GROUND_TRUTH)],
        "clean.png": ["\n".join(GROUND_TRUTH)],
        "clean.jpg": ["\n".join(GROUND_TRUTH)],
        "hybrid.pdf": [
            "Este contenido digital tiene texto suficiente para omitir OCR.",
            "\n".join(GROUND_TRUTH),
            "",
            "Anexo digital\n" + "\n".join(GROUND_TRUTH),
        ],
    }
    (directory / "ground_truth.json").write_text(
        json.dumps(expected, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "directory": str(directory),
        "fixtures": sorted(path.name for path in directory.iterdir()),
        "syntheticOnly": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(create_fixtures(arguments.directory), ensure_ascii=False))


if __name__ == "__main__":
    main()
