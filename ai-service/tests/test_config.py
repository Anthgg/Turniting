from app.core.config import get_settings


def test_settings_read_service_name_from_environment(monkeypatch) -> None:
    monkeypatch.setenv("AI_SERVICE_NAME", "test-ai-service")
    get_settings.cache_clear()

    try:
        assert get_settings().name == "test-ai-service"
    finally:
        get_settings.cache_clear()
