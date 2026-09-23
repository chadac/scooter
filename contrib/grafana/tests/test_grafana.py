"""Grafana provider — bearer-token auth + http-proxy target + enable gating.

Proves: the token is injected as `Authorization: Bearer …` so the agent never
sees it; the upstream is the configured stack URL with any trailing slash
stripped; and the provider is enabled only when BOTH the url and the token are
present.

These drive the provider through the ENVIRONMENT rather than by patching the
broker app's settings singleton, which is what the in-tree copy of this file did.
That is the point of the move: the contrib reads GRAFANA_* itself, so the test
now covers the real configuration path — including that the variable names are
the ones a deployment already sets. Why: PR #573.
"""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_contrib_grafana.broker_provider import grafana


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("GRAFANA_URL", "GRAFANA_TOKEN"):
        monkeypatch.delenv(var, raising=False)


@pytest.mark.asyncio
async def test_token_is_injected_as_a_bearer_header():
    src = StaticTokenSource(token="glsa_secret")
    cred = await src.get(_identity())

    req = httpx.Request("GET", "https://myorg.grafana.net/api/datasources")
    cred.inject(req)
    assert req.headers["Authorization"] == "Bearer glsa_secret"


def _upstream(provider):
    return next(t for t in provider.transports if isinstance(t, HttpProxy)).upstream


def test_proxies_to_the_configured_stack(monkeypatch):
    monkeypatch.setenv("GRAFANA_URL", "https://myorg.grafana.net")
    monkeypatch.setenv("GRAFANA_TOKEN", "glsa_secret")

    p = grafana()
    assert p.name == "grafana"
    assert p.enabled is True
    assert _upstream(p) == "https://myorg.grafana.net"


def test_trailing_slash_is_stripped(monkeypatch):
    # The upstream is joined with the proxied path, so a trailing slash would
    # produce a double slash ("…grafana.net//api/datasources").
    monkeypatch.setenv("GRAFANA_URL", "https://myorg.grafana.net/")
    monkeypatch.setenv("GRAFANA_TOKEN", "glsa_secret")

    assert _upstream(grafana()) == "https://myorg.grafana.net"


def test_whitespace_only_url_does_not_enable(monkeypatch):
    monkeypatch.setenv("GRAFANA_URL", "   ")
    monkeypatch.setenv("GRAFANA_TOKEN", "glsa_secret")

    assert grafana().enabled is False


@pytest.mark.parametrize(
    "url,token",
    [
        ("", "glsa_secret"),                # token but no stack URL
        ("https://myorg.grafana.net", ""),  # URL but no token
        ("", ""),                           # neither
    ],
)
def test_requires_both_url_and_token(monkeypatch, url, token):
    # Enabled iff BOTH are configured — otherwise the /grafana/* routes must not
    # mount (a half-configured provider would proxy without auth, or to nowhere).
    monkeypatch.setenv("GRAFANA_URL", url)
    monkeypatch.setenv("GRAFANA_TOKEN", token)

    assert grafana().enabled is False


@pytest.mark.asyncio
async def test_reads_the_env_vars_the_manifests_already_inject(monkeypatch):
    # modules/broker.nix injects GRAFANA_URL + GRAFANA_TOKEN (the latter from a
    # secret). If this contrib read anything else, a deployed broker would
    # silently lose its grafana provider on upgrade — no error, just a missing
    # route. Why: PR #573.
    monkeypatch.setenv("GRAFANA_URL", "https://myorg.grafana.net")
    monkeypatch.setenv("GRAFANA_TOKEN", "from-secret")

    provider = grafana()
    assert provider.enabled is True
    assert _upstream(provider) == "https://myorg.grafana.net"
    cred = await provider.credential.get(_identity())
    assert cred.value == "from-secret"
