from collections import Counter
from io import BytesIO

import pymupdf
import pytest
from fastapi import HTTPException

from app.api.routes.turnitin import parse_turnitin_pdf
from app.services.turnitin.parser import TurnitinParseError, parse_turnitin_report


def make_ai_report() -> bytes:
    document = pymupdf.open()
    cover = document.new_page()
    cover.insert_text((40, 40), "Identificador de la entrega trn:oid:::12345:67890")
    cover.insert_text((40, 90), "Sample thesis.docx")
    cover.insert_text((40, 120), "5 páginas 1461 palabras 9191 caracteres")
    cover.insert_text((40, 150), "Nombre del archivo Sample thesis.docx")

    overview = document.new_page()
    overview.insert_text((40, 40), "Descripción general de la escritura con IA")
    overview.insert_text((40, 100), "67 % detectado como IA")
    overview.insert_text((40, 140), "Sólo generado con IA 67%")

    body = document.new_page()
    body.insert_text((40, 24), "Página 3 de 3 - Entrega de escritura con IA")
    body.insert_text((70, 110), "Un primer párrafo resaltado con señales visibles.")
    body.insert_text((70, 170), "Un párrafo intermedio sin resaltado visible.")
    body.insert_text((70, 230), "Un segundo párrafo resaltado de manera independiente.")
    body.draw_rect(
        pymupdf.Rect(66, 92, 470, 122),
        color=None,
        fill=(0.32, 0.78, 0.86),
        overlay=False,
    )
    body.draw_rect(
        pymupdf.Rect(66, 212, 470, 242),
        color=None,
        fill=(0.32, 0.78, 0.86),
        overlay=False,
    )

    output = BytesIO()
    document.save(output)
    document.close()
    return output.getvalue()


def make_similarity_report() -> bytes:
    document = pymupdf.open()
    cover = document.new_page()
    cover.insert_text((40, 40), "Identificador de la entrega trn:oid:::12345:67891")
    cover.insert_text((40, 90), "5 páginas 1495 palabras 9130 caracteres")
    cover.insert_text((40, 120), "Nombre del archivo Similarity sample.docx")

    overview = document.new_page()
    overview.insert_text((40, 40), "Descripción general de integridad")
    overview.insert_text((40, 90), "3% Similitud general")
    overview.insert_text((40, 120), "Filtrado desde el informe")
    overview.insert_text((40, 145), "Bibliografía")
    overview.insert_text((40, 165), "Texto citado")
    overview.insert_text((40, 185), "Texto mencionado")
    overview.insert_text((40, 205), "Coincidencias menores (menos de 8 palabras)")
    overview.insert_text((40, 245), "3% Fuentes de Internet")
    overview.insert_text((40, 265), "0% Publicaciones")
    overview.insert_text((40, 285), "1% Trabajos entregados (trabajos del estudiante)")

    sources_page = document.new_page()
    sources_page.insert_text((40, 35), "Fuentes principales")
    sources_page.insert_text((40, 70), "1")
    sources_page.insert_text((70, 70), "Internet")
    sources_page.insert_text((70, 95), "source.example.org 2%")
    sources_page.insert_text((40, 125), "2")
    sources_page.insert_text((70, 125), "Trabajos")
    sources_page.insert_text((70, 145), "entregados")
    sources_page.insert_text((70, 170), "Student library record <1%")
    sources_page.insert_text((40, 205), "3")
    sources_page.insert_text((70, 205), "Internet")
    sources_page.insert_text((70, 230), "another.example.org <1%")

    body = document.new_page()
    body.insert_text((40, 24), "Página 4 de 4 - Entrega de integridad")
    body.insert_text((70, 110), "A visible source-matched paragraph.")
    body.insert_text((70, 170), "A paragraph without a visible match.")
    body.draw_rect(
        pymupdf.Rect(66, 92, 470, 122),
        color=None,
        fill=(1.0, 0.86, 0.91),
        overlay=False,
    )

    output = BytesIO()
    document.save(output)
    document.close()
    return output.getvalue()


def make_unknown_pdf() -> bytes:
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 60), "A generic document without Turnitin report markers.")
    output = document.tobytes()
    document.close()
    return output


def make_scanned_pdf() -> bytes:
    document = pymupdf.open()
    page = document.new_page()
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 16, 16), False)
    pixmap.clear_with(255)
    page.insert_image(page.rect, stream=pixmap.tobytes("png"))
    output = document.tobytes()
    document.close()
    return output


def test_parses_ai_report_scores_metadata_and_visual_segments() -> None:
    result = parse_turnitin_report(make_ai_report())
    counts = Counter(segment.segmentType for segment in result.segments)

    assert result.status == "PARSED"
    assert result.reportType == "AI_WRITING"
    assert result.parserVersion == "f002-v1"
    assert result.scores["aiWriting"].percentage == 67
    assert result.metadata["submissionId"] == "trn:oid:::12345:67890"
    assert result.metadata["wordCount"] == 1461
    assert result.metadata["characterCount"] == 9191
    assert counts["AI_FLAGGED"] >= 2
    assert counts["NOT_FLAGGED"] >= 1
    assert all(segment.normalizedText for segment in result.segments)
    assert all(segment.bbox[2] >= segment.bbox[0] for segment in result.segments)
    assert all("Página 3 de 3" not in segment.text for segment in result.segments)
    assert "Página 3 de 3" not in result.documentText


def test_parses_similarity_sources_filters_and_less_than_percent() -> None:
    result = parse_turnitin_report(make_similarity_report())

    assert result.status == "PARSED"
    assert result.reportType == "SIMILARITY"
    assert result.scores["similarity"].percentage == 3
    assert result.scores["internet"].percentage == 3
    assert result.scores["publications"].percentage == 0
    assert result.scores["studentPapers"].percentage == 1
    assert result.filters == [
        "BIBLIOGRAPHY",
        "QUOTED_TEXT",
        "CITED_TEXT",
        "MATCHES_UNDER_8_WORDS",
    ]
    assert len(result.sources) == 3
    assert result.sources[0].sourceType == "INTERNET"
    assert result.sources[0].percentage == 2
    assert result.sources[1].percentageRaw == "<1%"
    assert result.sources[1].percentage is None
    assert result.sources[1].percentageIsLessThan is True
    assert result.sources[2].displayName == "another.example.org"
    assert "Página" not in result.sources[2].displayName
    assert any(segment.segmentType == "SIMILARITY_MATCH" for segment in result.segments)


def test_unknown_and_image_only_reports_remain_unclassified_without_ocr() -> None:
    unknown = parse_turnitin_report(make_unknown_pdf())
    scanned = parse_turnitin_report(make_scanned_pdf())

    assert unknown.reportType == "UNKNOWN"
    assert unknown.status == "PARTIAL"
    assert scanned.reportType == "UNKNOWN"
    assert scanned.status == "OCR_REQUIRED"
    assert any("OCR" in warning for warning in scanned.warnings)


def test_rejects_corrupt_pdf_bytes() -> None:
    with pytest.raises(TurnitinParseError):
        parse_turnitin_report(b"%PDF-not a valid PDF")


@pytest.mark.anyio
async def test_endpoint_rejects_wrong_media_type() -> None:
    from fastapi import UploadFile

    file = UploadFile(
        filename="report.txt",
        file=BytesIO(b"text"),
        headers={"content-type": "text/plain"},
    )
    with pytest.raises(HTTPException) as error:
        await parse_turnitin_pdf(file)
    assert error.value.status_code == 415
