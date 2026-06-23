"""GitHub App credential source — JWT -> installation access token.

Generates a short-lived App JWT (RS256) from the App private key, exchanges it
for an installation access token, caches the token (~50 min), refreshes before
expiry. Lifted from openhands-nix github_app.py.

Design stage: interface only.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..core.types import Credential, CredentialSource, Identity


@dataclass
class GitHubAppSource(CredentialSource):
    app_id: str
    private_key: str                   # PEM content or path
    installation_id: int

    async def get(self, identity: Identity) -> Credential:
        """Return a cached/fresh installation token as a bearer Credential."""
        ...
