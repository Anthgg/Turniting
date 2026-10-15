from app.services.turnitin.alignment import align_report_to_document


def test_exact_alignment_returns_original_offsets() -> None:
    report_segment = "The biometric model combines facial and behavioral signals."
    document = "Preface text.\n" + report_segment + "\n" + report_segment * 5 + "\nEnd."
    result = align_report_to_document(
        document,
        document,
        [{"segmentIndex": 4, "text": report_segment}],
    )

    assert result.matchStatus == "EXACT"
    assert result.method == "normalized_exact"
    alignment = result.segmentAlignments[0]
    assert alignment.documentStartOffset == document.index(report_segment)
    assert alignment.documentEndOffset == document.index(report_segment) + len(
        report_segment
    )


def test_accent_insensitive_content_alignment_is_high() -> None:
    document = (
        "La autenticación continua protege la sesión del usuario durante toda "
        "la jornada académica. " * 8
    )
    report = document.replace("autenticación", "autenticacion")
    result = align_report_to_document(document, report)

    assert result.matchStatus == "EXACT"
    assert result.method == "normalized_exact"


def test_partial_and_mismatched_content_are_distinguished() -> None:
    source = (
        "La autenticación continua protege la sesión del usuario y evita "
        "accesos indebidos. " * 12
    )
    partial = source[: int(len(source) * 0.7)]
    unrelated = (
        "La arquitectura del sistema organiza datos y operaciones de manera modular. "
        * 12
    )

    partial_result = align_report_to_document(source, partial)
    mismatch_result = align_report_to_document(source, unrelated)

    assert partial_result.matchStatus == "PARTIAL"
    assert partial_result.method == "paragraph_similarity"
    assert mismatch_result.matchStatus == "MISMATCH"


def test_short_content_remains_unverified() -> None:
    result = align_report_to_document("short text", "short text")
    assert result.matchStatus == "UNVERIFIED"


def test_counts_and_title_are_recorded_as_secondary_match_signals() -> None:
    document = (
        "The same thesis paragraph describes the system and its research objectives. "
        * 8
    )
    result = align_report_to_document(
        document,
        document[: int(len(document) * 0.82)],
        document_metadata={
            "wordCount": 1000,
            "characterCount": 5600,
            "originalName": "Thesis final.docx",
        },
        report_metadata={
            "wordCount": 1004,
            "characterCount": 5700,
            "submissionFileName": "Thesis final.docx",
        },
    )

    assert "word_count_close" in result.signals
    assert "character_count_close" in result.signals
    assert "title_exact" in result.signals
