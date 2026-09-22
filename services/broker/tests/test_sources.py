"""The provider-SPECIFIC credential sources — mocked HTTP, no real GitHub.

Proves the JWT/installation-token and client-credentials flows produce the right
Credential, cache it, and serve the cache on the second call.

These live with their providers rather than in the extension surface: a GitHub
App token minter is github implementation, and it travels into the github
contrib with the rest of github in the integration slices. The generic
`static_token` is tested in scooter_broker_lib. See PR #567.
"""

from __future__ import annotations

import time

import httpx
import pytest

from broker.sources.github_app import GitHubAppSource
from scooter_broker_lib.types import Identity


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


