"""Static token credential source — a PAT / bot token from config.

The simplest source: a fixed secret injected as a bearer/header. Used as the
GitHub PAT fallback, GitLab PRIVATE-TOKEN, Slack bot token.

Design stage: interface only.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..core.types import Credential, CredentialSource, Identity


@dataclass
class StaticTokenSource(CredentialSource):
    token: str
    kind: str = "bearer"               # "bearer" | "header"
    header_name: str | None = None     # for kind="header" (e.g. PRIVATE-TOKEN)

    async def get(self, identity: Identity) -> Credential:
        ...
