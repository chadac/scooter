"""Kagi provider — `Bot` header auth + http-proxy target + enable gating.

Proves: the key is injected as `Authorization: Bot …` (Kagi's own scheme, not
Bearer) so the agent never sees it; the prefix is carried by the TOKEN, because
kind="header" writes the value verbatim; the upstream is Kagi's bare host, so
the proxy stays transparent; and the provider is enabled only when the key is
configured.

Driven through the ENVIRONMENT rather than by patching settings, so the test
covers the real configuration path — including that the variable name is the one
a deployment sets.
"""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity
from scooter_contrib_kagi.broker_provider import kagi


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("KAGI_API_KEY", raising=False)


def _upstream(provider):
    return next(t for t in provider.transports if isinstance(t, HttpProxy)).upstream


def test_disabled_without_a_key():
    # Nothing configured -> the /kagi/* routes must not mount.
    assert kagi().enabled is False


def test_whitespace_only_key_does_not_enable(monkeypatch):
    # The `Bot ` prefix makes the token truthy even for an empty key, so the
    # gate reads the raw key — this is the regression that would mount an
    # unconfigured provider.
    monkeypatch.setenv("KAGI_API_KEY", "   ")

    assert kagi().enabled is False


def test_enabled_and_proxies_to_kagi(monkeypatch):
    monkeypatch.setenv("KAGI_API_KEY", "kagi_secret")

    p = kagi()
    assert p.name == "kagi"
    assert p.enabled is True
    assert _upstream(p) == "https://kagi.com"


@pytest.mark.asyncio
async def test_token_carries_the_bot_prefix(monkeypatch):
    monkeypatch.setenv("KAGI_API_KEY", "kagi_secret")

    cred = await kagi().credential.get(_identity())
    assert cred.kind == "header"
    assert cred.meta["header_name"] == "Authorization"
    # Verbatim header value, so the scheme has to be part of the token itself.
    assert cred.value == "Bot kagi_secret"


@pytest.mark.asyncio
async def test_key_is_injected_as_an_authorization_bot_header(monkeypatch):
    monkeypatch.setenv("KAGI_API_KEY", "kagi_secret")

    cred = await kagi().credential.get(_identity())
    req = httpx.Request("GET", "https://kagi.com/api/v0/search?q=nix")
    cred.inject(req)
    assert req.headers["Authorization"] == "Bot kagi_secret"
    # A `Bearer` prefix here would be a 401 from Kagi.
    assert not req.headers["Authorization"].startswith("Bearer")
