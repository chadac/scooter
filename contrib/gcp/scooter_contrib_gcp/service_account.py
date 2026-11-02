"""Service-account credential source: a signed JWT exchanged for a short-lived access token, cached until near expiry."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

import httpx
import jwt

from scooter_broker_lib.types import Credential, CredentialSource, Identity

DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
# Google caps an assertion at one hour.
ASSERTION_TTL = 3600


class GoogleCredential(Credential):
    """A bearer token that strips any `key=` API key; Google rejects a token sent with one."""

    def inject(self, req: httpx.Request) -> None:
        # gsutil adds its own API key when it thinks it has no credential.
        req.url = req.url.copy_remove_param("key")
        super().inject(req)


@dataclass
class ServiceAccountSource(CredentialSource):
    info: dict
    scopes: list[str]

    _cached: tuple[str, float] | None = field(default=None, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    @property
    def token_uri(self) -> str:
        return self.info.get("token_uri") or DEFAULT_TOKEN_URI

    def assertion(self, now: int) -> str:
        claims = {
            "iss": self.info["client_email"],
            "scope": " ".join(self.scopes),
            "aud": self.token_uri,
            "iat": now,
            "exp": now + ASSERTION_TTL,
        }
        headers = {"kid": self.info["private_key_id"]} if self.info.get("private_key_id") else None
        return jwt.encode(claims, self.info["private_key"], algorithm="RS256", headers=headers)

    async def get(self, identity: Identity, request=None) -> Credential:
        # One identity for every caller, so one cached token.
        async with self._lock:
            if self._cached and time.time() < self._cached[1] - 60:
                return GoogleCredential(kind="bearer", value=self._cached[0], expires_at=self._cached[1])

            now = int(time.time())
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    self.token_uri,
                    data={"grant_type": JWT_BEARER, "assertion": self.assertion(now)},
                )
                resp.raise_for_status()
                data = resp.json()

            token = data["access_token"]
            expires_at = now + int(data.get("expires_in", ASSERTION_TTL))
            self._cached = (token, expires_at)
            return GoogleCredential(kind="bearer", value=token, expires_at=expires_at)
