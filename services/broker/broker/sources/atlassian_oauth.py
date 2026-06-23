"""Atlassian OAuth credential source — client-credentials -> access token.

Exchanges client_id/secret for a short-lived Atlassian access token (cached,
refreshed early). Used by the Jira provider. Lifted from openhands-nix jira.py.

Design stage: interface only.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..core.types import Credential, CredentialSource, Identity


@dataclass
class AtlassianOAuthSource(CredentialSource):
    client_id: str
    client_secret: str
    cloud_id: str

    async def get(self, identity: Identity) -> Credential:
        # TODO: lift client-credentials flow from openhands-nix jira.py.
        raise NotImplementedError("AtlassianOAuthSource not implemented yet")
