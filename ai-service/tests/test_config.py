from app.core.config import get_settings


def test_settings_read_service_name_from_environment(monkeypatch) -> None:
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai-service")
    get_settings.cache_clear()

    try:
        assert get_settings().name == "test-ai-service"
    finally:
        get_settings.cache_clear()


def test_extraction_settings_use_compose_environment_names(monkeypatch) -> None:
    monkeypatch.setenv("MAX_UPLOAD_MB", "5")
    monkeypatch.setenv("OCR_MIN_CHARS_PER_PAGE", "30")
    monkeypatch.setenv("OCR_MIN_LOW_TEXT_PAGE_RATIO", "0.25")
    get_settings.cache_clear()

    try:
        settings = get_settings()
        assert settings.max_upload_mb == 5
        assert settings.ocr_min_chars_per_page == 30
        assert settings.ocr_min_low_text_page_ratio == 0.25
    finally:
        get_settings.cache_clear()


def test_extraction_settings_default_values(monkeypatch) -> None:
    monkeypatch.delenv("MAX_UPLOAD_MB", raising=False)
    monkeypatch.delenv("OCR_MIN_CHARS_PER_PAGE", raising=False)
    monkeypatch.delenv("OCR_MIN_LOW_TEXT_PAGE_RATIO", raising=False)
    get_settings.cache_clear()

    try:
        settings = get_settings()
        assert settings.max_upload_mb == 20
        assert settings.ocr_min_chars_per_page == 20
        assert settings.ocr_min_low_text_page_ratio == 0.5
    finally:
        get_settings.cache_clear()
