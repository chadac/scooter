"""GitLab proxy — bare-host upstream (the /api/v4 double-prefix fix) + the
upstream-URL-on-error diagnostic header.

Regression: the gitlab upstream used to be https://gitlab.com/api/v4, so an agent
calling /gitlab/api/v4/user got forwarded to gitlab.com/api/v4/api/v4/user -> 404.
The upstream is now the bare host (transparent proxy, like GitHub): the path after
/gitlab/ is the full API path.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import broker.transports.http_proxy as http_proxy_mod
from broker.core.types import Identity, Provider
from broker.providers.gitlab import gitlab
from broker.transports.http_proxy import HttpProxy


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


def test_gitlab_upstream_is_bare_host(monkeypatch):
    from broker import config as cfg

    monkeypatch.setattr(cfg.settings, "gitlab_token", "glpat-xxx", raising=False)
    proxy = next(t for t in gitlab().transports if isinstance(t, HttpProxy))
    # Bare host — NOT .../api/v4 (that was the double-prefix bug).
    assert proxy.upstream == "https://gitlab.com"
    assert not proxy.upstream.endswith("/api/v4")


_REAL_ASYNC_CLIENT = httpx.AsyncClient


@pytest.fixture(autouse=True)
def _restore_async_client():
    """Undo the AsyncClient patch each test does, so the module is left pristine."""
    yield
    http_proxy_mod.httpx.AsyncClient = _REAL_ASYNC_CLIENT  # type: ignore[assignment]


def _app_with_proxy(proxy: HttpProxy, captured: dict) -> FastAPI:
    """Mount just the proxy, with a fake auth dep and a mocked upstream that records
    the outbound URL and returns a chosen status. Patches the proxy's
    `httpx.AsyncClient(...)` to use a MockTransport (no network)."""
    async def fake_authed() -> Identity:
        return _identity()

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(captured.get("status", 200), json={"ok": True})

    def patched(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        kwargs.pop("timeout", None)
        return _REAL_ASYNC_CLIENT(*args, **kwargs)

    http_proxy_mod.httpx.AsyncClient = patched  # type: ignore[assignment]

    provider = Provider(name="gitlab", credential=None, transports=[proxy], enabled=True)
    app = FastAPI()
    app.include_router(proxy.routes(provider, authed=fake_authed), prefix="/gitlab")
    return app


def test_gitlab_api_path_is_not_double_prefixed():
    captured: dict = {}
    proxy = HttpProxy(upstream="https://gitlab.com")
    app = _app_with_proxy(proxy, captured)
    client = TestClient(app)

    resp = client.get("/gitlab/api/v4/user")
    assert resp.status_code == 200
    # The outbound URL is gitlab.com/api/v4/user — NOT .../api/v4/api/v4/user.
    assert captured["url"] == "https://gitlab.com/api/v4/user"


def test_failure_surfaces_the_upstream_url_header():
    captured: dict = {"status": 404}
    proxy = HttpProxy(upstream="https://gitlab.com")
    app = _app_with_proxy(proxy, captured)
    client = TestClient(app)

    resp = client.get("/gitlab/api/v4/nope")
    assert resp.status_code == 404
    # The URL the proxy actually requested is echoed back so a mis-prefixed path
    # is self-diagnosing (query stripped).
    assert resp.headers.get("x-broker-upstream-url") == "https://gitlab.com/api/v4/nope"


def test_success_does_not_leak_the_upstream_url_header():
    captured: dict = {"status": 200}
    proxy = HttpProxy(upstream="https://gitlab.com")
    app = _app_with_proxy(proxy, captured)
    client = TestClient(app)

    resp = client.get("/gitlab/api/v4/user")
    assert resp.status_code == 200
    assert "x-broker-upstream-url" not in {k.lower() for k in resp.headers}
