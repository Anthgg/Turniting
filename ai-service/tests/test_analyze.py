import asyncio

import httpx

from app.main import app


def post_json(path: str, payload: dict[str, object]) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
        ) as client:
            return await client.post(path, json=payload)

    return asyncio.run(send())


def test_analyze_test_returns_text_metrics() -> None:
    response = post_json(
        "/analyze/test",
        {"text": "Este es un texto de prueba"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "characters": 26,
        "words": 6,
    }


def test_analyze_test_counts_empty_text() -> None:
    response = post_json("/analyze/test", {"text": ""})

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "characters": 0, "words": 0}


def test_analyze_test_rejects_extra_fields() -> None:
    response = post_json("/analyze/test", {"text": "hello", "extra": True})

    assert response.status_code == 422
