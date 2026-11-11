"""The http-proxy turns upstream transport failures into a 504 or 502 instead of a traceback."""

from __future__ import annotations

import logging

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity, Provider

IDENT = Identity(conversation_id="c1", namespace="ns", service_account="system:serviceaccount:ns:sandbox-c1")


def _client(monkeypatch, exc: Exception) -> TestClient:
    async def failing_send(self, request, **kw):
        raise exc

    monkeypatch.setattr(httpx.AsyncClient, "send", failing_send)
    provider = Provider(name="gitlab", transports=[HttpProxy(upstream="https://gitlab.com")])

    async def authed() -> Identity:
        return IDENT

    app = FastAPI()
    app.include_router(provider.transports[0].routes(provider, authed=authed), prefix="/gitlab")
    return TestClient(app)


@pytest.mark.parametrize(
    ("exc", "status", "name"),
    [
        (httpx.ReadTimeout("timed out"), 504, "ReadTimeout"),
        (httpx.ConnectTimeout("timed out"), 504, "ConnectTimeout"),
        (httpx.ConnectError("refused"), 502, "ConnectError"),
        (httpx.RemoteProtocolError("reset"), 502, "RemoteProtocolError"),
    ],
)
def test_upstream_transport_failure_is_mapped(monkeypatch, caplog, exc, status, name):
    client = _client(monkeypatch, exc)

    with caplog.at_level(logging.WARNING):
        resp = client.get("/gitlab/api/v4/projects/1/pipelines?private_token=secret")

    assert resp.status_code == status
    assert resp.json() == {"message": f"gitlab upstream failed: {name}", "provider": "gitlab", "error": name}
    assert resp.headers["X-Broker-Upstream-Url"] == "https://gitlab.com/api/v4/projects/1/pipelines"
    [record] = [r for r in caplog.records if r.message == "http-proxy upstream failed"]
    assert record.levelno == logging.WARNING and record.exc_info is None
