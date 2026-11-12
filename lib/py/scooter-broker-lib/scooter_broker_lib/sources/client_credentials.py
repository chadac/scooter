"""OAuth 2.0 client-credentials source: a short-lived token minted from a client id and secret, cached and refreshed early."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import httpx

from ..types import Credential, CredentialSource, Identity


@dataclass
class ClientCredentialsSource(CredentialSource):
    token_url: str
    client_id: str
    client_secret: str

    _cache: tuple[str, float] | None = field(default=None, repr=False)

    async def get(self, identity: Identity, request=None) -> Credential:
        if self._cache and time.time() < self._cache[1] - 60:
            token, expires_at = self._cache
            return Credential(kind="bearer", value=token, expires_at=expires_at)

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                self.token_url,
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
