"""GitHub App credential source — JWT -> installation access token.

Generates a short-lived App JWT (RS256) from the App private key, exchanges it
for an installation access token, caches the token (~50 min), refreshes before
expiry. Logic lifted from openhands-nix github_app.py.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import httpx
import jwt

from ..core.types import Credential, CredentialSource, Identity

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
_TOKEN_TTL = 50 * 60  # tokens last 1h; refresh at 50m


@dataclass
class GitHubAppSource(CredentialSource):
    app_id: str
    private_key: str                   # PEM content or path
    installation_id: int

    # (token, expires_at) cache, per source instance.
    _cache: tuple[str, float] | None = field(default=None, repr=False)

    def _load_private_key(self) -> str:
        key = self.private_key
        # A path (not inline PEM) -> read the file.
        if not key.startswith("-----") and "/" in key:
            with open(key) as f:
                return f.read()
        return key

    def _generate_jwt(self) -> str:
        now = int(time.time())
        payload = {"iat": now - 60, "exp": now + 10 * 60, "iss": self.app_id}
        return jwt.encode(payload, self._load_private_key(), algorithm="RS256")

    async def get(self, identity: Identity) -> Credential:
        if self._cache and time.time() < self._cache[1]:
            token = self._cache[0]
            return Credential(kind="bearer", value=token, expires_at=self._cache[1])

        app_jwt = self._generate_jwt()
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{GITHUB_API}/app/installations/{self.installation_id}/access_tokens",
                headers={
                    "Authorization": f"Bearer {app_jwt}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            resp.raise_for_status()
            token = resp.json()["token"]

        expires_at = time.time() + _TOKEN_TTL
        self._cache = (token, expires_at)
        return Credential(kind="bearer", value=token, expires_at=expires_at)
