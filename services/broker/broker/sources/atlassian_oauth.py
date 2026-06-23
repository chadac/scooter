"""Atlassian OAuth credential source — client-credentials -> access token.

Exchanges client_id/secret for a short-lived Atlassian access token (cached,
refreshed early). Used by the Jira provider. Logic lifted from openhands-nix
jira.py.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import httpx

from ..core.types import Credential, CredentialSource, Identity

TOKEN_URL = "https://auth.atlassian.com/oauth/token"


@dataclass
class AtlassianOAuthSource(CredentialSource):
    client_id: str
    client_secret: str
    cloud_id: str

    _cache: tuple[str, float] | None = field(default=None, repr=False)

    async def get(self, identity: Identity) -> Credential:
        if self._cache and time.time() < self._cache[1] - 60:
            token, expires_at = self._cache
            return Credential(kind="bearer", value=token, expires_at=expires_at)

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                TOKEN_URL,
                json={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        token = data["access_token"]
        expires_at = time.time() + data.get("expires_in", 3600)
        self._cache = (token, expires_at)
        return Credential(kind="bearer", value=token, expires_at=expires_at)
