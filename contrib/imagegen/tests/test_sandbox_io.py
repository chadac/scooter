"""The broker authenticates its agent-host calls to the router."""

from __future__ import annotations

import base64

import httpx
import pytest

from scooter_contrib_imagegen import sandbox_io


@pytest.fixture
def seen(monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(200, json={"path": "/workspace/images/a.jpg"})
        return httpx.Response(200, json={"data": base64.b64encode(b"img").decode()})

    real = httpx.AsyncClient
    monkeypatch.setattr(sandbox_io, "router_headers", lambda: {"Authorization": "Bearer t"})
    monkeypatch.setattr(
        sandbox_io.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    )
    return requests


async def test_write_and_read_send_the_router_token(seen: list[httpx.Request]) -> None:
    assert await sandbox_io.write_image("http://agent-host", "c1", "a.jpg", b"img") == "/workspace/images/a.jpg"
    assert await sandbox_io.read_reference_image("http://agent-host", "c1", "/workspace/a.jpg") == b"img"
    assert [r.headers["authorization"] for r in seen] == ["Bearer t", "Bearer t"]
