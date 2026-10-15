import asyncio

import httpx

from app.main import app


def request_health(path: str) -> httpx.Response:
    async def send() -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
        ) as client:
            return await client.get(path)

    return asyncio.run(send())


def test_health_returns_service_status() -> None:
    response = request_health("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ai-service"}


def test_root_service_endpoint_is_preserved() -> None:
    response = request_health("/")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ai-service"}
