"""Unit tests for credential sources — mocked HTTP, no real GitHub/Atlassian.

Proves the JWT/installation-token and client-credentials flows produce the right
Credential, cache it, and serve the cache on the second call.
"""

from __future__ import annotations

import time

import httpx
import pytest

from broker.core.types import Identity
from broker.sources.atlassian_oauth import AtlassianOAuthSource
from broker.sources.github_app import GitHubAppSource
from broker.sources.static_token import StaticTokenSource

# A throwaway RSA key for signing the App JWT in tests.


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


def _rsa_key() -> str:
    # Generate a real RSA key so jwt.encode(RS256) works.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


@pytest.mark.asyncio
async def test_static_token_source():
    src = StaticTokenSource(token="abc", kind="bearer")
    cred = await src.get(_identity())
    assert cred.kind == "bearer"
    assert cred.value == "abc"
    headers = cred.inject({})
    assert headers["Authorization"] == "Bearer abc"


@pytest.mark.asyncio
async def test_static_token_header_kind():
    src = StaticTokenSource(token="glpat-x", kind="header", header_name="PRIVATE-TOKEN")
    cred = await src.get(_identity())
    headers = cred.inject({})
    assert headers["PRIVATE-TOKEN"] == "glpat-x"


@pytest.mark.asyncio
async def test_github_app_source_mints_and_caches(monkeypatch):
    calls = {"n": 0}

    async def fake_post(self, url, **kwargs):  # noqa: ANN001
        calls["n"] += 1
        assert "access_tokens" in url
        assert kwargs["headers"]["Authorization"].startswith("Bearer ")  # the App JWT
        return httpx.Response(200, json={"token": "ghs_installation_token"}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    src = GitHubAppSource(app_id="123", private_key=_rsa_key(), installation_id=42)
    cred = await src.get(_identity())
    assert cred.kind == "bearer"
    assert cred.value == "ghs_installation_token"

    # second call is served from cache (no new HTTP)
    await src.get(_identity())
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_atlassian_oauth_source_mints_and_caches(monkeypatch):
    calls = {"n": 0}

    async def fake_post(self, url, **kwargs):  # noqa: ANN001
        calls["n"] += 1
        assert "oauth/token" in url
        assert kwargs["json"]["grant_type"] == "client_credentials"
        return httpx.Response(200, json={"access_token": "atl_token", "expires_in": 3600}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    src = AtlassianOAuthSource(client_id="cid", client_secret="sec", cloud_id="cloud")
    cred = await src.get(_identity())
    assert cred.value == "atl_token"
    assert cred.expires_at and cred.expires_at > time.time()

    await src.get(_identity())
    assert calls["n"] == 1  # cached
