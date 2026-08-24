"""Grafana provider — bearer-token auth + http-proxy target + enable gating.

Grafana service-account tokens are plain bearer tokens (unlike GitLab's
PRIVATE-TOKEN header), so the default credential kind applies. Proves: the token
is injected as `Authorization: Bearer …` so the agent never sees it; the upstream
is the configured stack URL with any trailing slash stripped; and the provider is
enabled only when BOTH the url and the token are present.
"""

from __future__ import annotations

import httpx
import pytest

from broker.core.types import Identity
from broker.sources.static_token import StaticTokenSource


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.mark.asyncio
async def test_token_is_injected_as_a_bearer_header():
    src = StaticTokenSource(token="glsa_secret")
    cred = await src.get(_identity())

    req = httpx.Request("GET", "https://myorg.grafana.net/api/datasources")
    cred.inject(req)
    assert req.headers["Authorization"] == "Bearer glsa_secret"


def _provider(monkeypatch, *, url: str, token: str):
    from broker import config as cfg
    from broker.providers.grafana import grafana

    monkeypatch.setattr(cfg.settings, "grafana_url", url, raising=False)
    monkeypatch.setattr(cfg.settings, "grafana_token", token, raising=False)
    return grafana()


def test_proxies_to_the_configured_stack(monkeypatch):
    p = _provider(monkeypatch, url="https://myorg.grafana.net", token="glsa_secret")
    assert p.name == "grafana"
    assert p.enabled is True
    assert p.transports[0].upstream == "https://myorg.grafana.net"


def test_trailing_slash_is_stripped(monkeypatch):
    # The upstream is joined with the proxied path, so a trailing slash would
    # produce a double slash ("…grafana.net//api/datasources").
    p = _provider(monkeypatch, url="https://myorg.grafana.net/", token="glsa_secret")
    assert p.transports[0].upstream == "https://myorg.grafana.net"


def test_whitespace_only_url_does_not_enable(monkeypatch):
    p = _provider(monkeypatch, url="   ", token="glsa_secret")
    assert p.enabled is False


@pytest.mark.parametrize(
    "url,token",
    [
        ("", "glsa_secret"),   # token but no stack URL
        ("https://myorg.grafana.net", ""),  # URL but no token
        ("", ""),              # neither
    ],
)
def test_requires_both_url_and_token(monkeypatch, url, token):
    # Enabled iff BOTH are configured — otherwise the /grafana/* routes must not
    # mount (a half-configured provider would proxy without auth, or to nowhere).
    p = _provider(monkeypatch, url=url, token=token)
    assert p.enabled is False
