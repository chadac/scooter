"""The generic credential sources; provider-specific ones are tested with their contribs."""

from __future__ import annotations

import time

import httpx
import pytest

from scooter_broker_lib.sources.client_credentials import ClientCredentialsSource
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.types import Identity


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


def _req() -> httpx.Request:
    """A throwaway outbound request for inject() to mutate."""
    return httpx.Request("GET", "https://example.test/x")


@pytest.mark.asyncio
async def test_static_token_source():
    src = StaticTokenSource(token="abc", kind="bearer")
    cred = await src.get(_identity())
    assert cred.kind == "bearer"
    assert cred.value == "abc"
    req = _req()
    cred.inject(req)
    assert req.headers["Authorization"] == "Bearer abc"


@pytest.mark.asyncio
async def test_static_token_header_kind():
    src = StaticTokenSource(token="glpat-x", kind="header", header_name="PRIVATE-TOKEN")
    cred = await src.get(_identity())
    req = _req()
    cred.inject(req)
    assert req.headers["PRIVATE-TOKEN"] == "glpat-x"


@pytest.mark.asyncio
async def test_client_credentials_source_mints_and_caches(monkeypatch):
    calls = []

    async def fake_post(self, url, **kwargs):  # noqa: ANN001
        calls.append((url, kwargs["json"]))
        return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    src = ClientCredentialsSource(token_url="https://auth.example/oauth/token", client_id="cid", client_secret="sec")
    cred = await src.get(_identity())
    assert (cred.kind, cred.value) == ("bearer", "tok")
    assert cred.expires_at and cred.expires_at > time.time()
    await src.get(_identity())
    assert calls == [("https://auth.example/oauth/token",
                      {"grant_type": "client_credentials", "client_id": "cid", "client_secret": "sec"})]
