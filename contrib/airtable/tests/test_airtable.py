"""Airtable provider — bearer-token auth + http-proxy target + enable gating.

Airtable personal access tokens (`pat…`) are plain bearer tokens, so the default
credential kind applies. Proves: the token is injected as `Authorization: Bearer …`
so the agent never sees it; the upstream is Airtable's fixed API host; and the
provider is enabled only when a token is configured (a tokenless provider would
mount /airtable/* routes that proxy unauthenticated and 401 on every call).

These drive the provider through the ENVIRONMENT rather than by patching the
broker app's settings singleton, which is what the broker's copy of this file
did. That is the point of the move: the contrib reads AIRTABLE_TOKEN itself, so
the test now covers the real configuration path — including that the variable
name is the one a deployment already sets. Why: PR #573.
"""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.types import Identity
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_contrib_airtable.broker_provider import airtable


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("AIRTABLE_TOKEN", raising=False)


@pytest.mark.asyncio
async def test_token_is_injected_as_a_bearer_header():
    src = StaticTokenSource(token="patSECRET.deadbeef")
    cred = await src.get(_identity())

    req = httpx.Request("GET", "https://api.airtable.com/v0/meta/bases")
    cred.inject(req)
    assert req.headers["Authorization"] == "Bearer patSECRET.deadbeef"


def test_proxies_to_the_airtable_api(monkeypatch):
    monkeypatch.setenv("AIRTABLE_TOKEN", "patSECRET.deadbeef")

    p = airtable()
    assert p.name == "airtable"
    assert p.enabled is True
    proxy = next(t for t in p.transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.airtable.com"


def test_write_methods_are_proxied(monkeypatch):
    # Airtable record writes are POST/PATCH/DELETE (and PUT for upserts); a
    # GET-only proxy would silently make the provider read-only.
    monkeypatch.setenv("AIRTABLE_TOKEN", "patSECRET.deadbeef")

    proxy = next(t for t in airtable().transports if isinstance(t, HttpProxy))
    for method in ("GET", "POST", "PATCH", "DELETE", "PUT"):
        assert method in proxy.methods


@pytest.mark.parametrize("token", ["", "   "])
def test_requires_a_token(monkeypatch, token):
    # No token -> the /airtable/* routes must not mount at all. Mounting them
    # unauthenticated turns every agent call into an opaque 401 that reads like
    # a broken token rather than an unconfigured provider.
    monkeypatch.setenv("AIRTABLE_TOKEN", token)
    assert airtable().enabled is False


def test_reads_the_env_var_the_manifests_already_inject(monkeypatch):
    # modules/broker.nix injects AIRTABLE_TOKEN from a secret. If this contrib
    # read anything else, a deployed broker would silently lose its airtable
    # provider on upgrade — with no error, just a missing route.
    monkeypatch.setenv("AIRTABLE_TOKEN", "pat-from-secret")

    provider = airtable()
    assert provider.enabled is True
    assert provider.credential.token == "pat-from-secret"
