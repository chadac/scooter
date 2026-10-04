"""Brave Search provider — header auth + http-proxy target + enable gating.

Proves: the key is injected as `X-Subscription-Token: …` (NOT a bearer header,
which Brave ignores) so the agent never sees it; the upstream is Brave's bare
API host, so the proxy stays transparent; and the provider is enabled only when
the key is configured.

Driven through the ENVIRONMENT rather than by patching settings, so the test
covers the real configuration path — including that the variable name is the one
a deployment sets.
"""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity
from scooter_contrib_brave.broker_provider import brave


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)


def _upstream(provider):
    return next(t for t in provider.transports if isinstance(t, HttpProxy)).upstream


def test_disabled_without_a_key():
    # Nothing configured -> the /brave/* routes must not mount.
    assert brave().enabled is False


def test_whitespace_only_key_does_not_enable(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "   ")

    assert brave().enabled is False


def test_enabled_and_proxies_to_brave(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "bsa_secret")

    p = brave()
    assert p.name == "brave"
    assert p.enabled is True
    assert _upstream(p) == "https://api.search.brave.com"


@pytest.mark.asyncio
async def test_key_is_injected_as_the_subscription_header(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "bsa_secret")

    cred = await brave().credential.get(_identity())
    assert cred.kind == "header"
    assert cred.meta["header_name"] == "X-Subscription-Token"
    assert cred.value == "bsa_secret"

    req = httpx.Request("GET", "https://api.search.brave.com/res/v1/web/search?q=nix")
    cred.inject(req)
    assert req.headers["X-Subscription-Token"] == "bsa_secret"
    # The key must NOT also leak into Authorization.
    assert "Authorization" not in req.headers
