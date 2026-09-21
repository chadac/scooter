"""Airtable provider — bearer-token auth + http-proxy target + enable gating.

Airtable personal access tokens (`pat…`) are plain bearer tokens, so the default
credential kind applies. Proves: the token is injected as `Authorization: Bearer …`
so the agent never sees it; the upstream is Airtable's fixed API host; and the
provider is enabled only when a token is configured (a tokenless provider would
mount /airtable/* routes that proxy unauthenticated and 401 on every call).
"""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.types import Identity
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.mark.asyncio
async def test_token_is_injected_as_a_bearer_header():
    src = StaticTokenSource(token="patSECRET.deadbeef")
    cred = await src.get(_identity())

    req = httpx.Request("GET", "https://api.airtable.com/v0/meta/bases")
    cred.inject(req)
    assert req.headers["Authorization"] == "Bearer patSECRET.deadbeef"


def _provider(monkeypatch, *, token: str):
    from broker import config as cfg
    from broker.providers.airtable import airtable

    monkeypatch.setattr(cfg.settings, "airtable_token", token, raising=False)
    return airtable()


def test_proxies_to_the_airtable_api(monkeypatch):
    p = _provider(monkeypatch, token="patSECRET.deadbeef")
    assert p.name == "airtable"
    assert p.enabled is True
    proxy = next(t for t in p.transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.airtable.com"


def test_write_methods_are_proxied(monkeypatch):
    # Airtable record writes are POST/PATCH/DELETE (and PUT for upserts); a
    # GET-only proxy would silently make the provider read-only.
    p = _provider(monkeypatch, token="patSECRET.deadbeef")
    proxy = next(t for t in p.transports if isinstance(t, HttpProxy))
    for method in ("GET", "POST", "PATCH", "DELETE", "PUT"):
        assert method in proxy.methods


@pytest.mark.parametrize("token", ["", "   "])
def test_requires_a_token(monkeypatch, token):
    # No token -> the /airtable/* routes must not mount at all. Mounting them
    # unauthenticated turns every agent call into an opaque 401 that reads like
    # a broken token rather than an unconfigured provider.
    assert _provider(monkeypatch, token=token).enabled is False
