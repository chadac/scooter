"""git-credential transport — vends a git credential blob.

Mounts `/{provider}/git-credentials`. The in-pod `git-credential-broker` helper
calls it with the pod's SA token and gets back
`{protocol, host, username, password}` for HTTPS git operations.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException

from ..core.types import AuthDependency, Identity, Provider, Transport


@dataclass
class GitCredential(Transport):
    host: str = ""                     # e.g. "github.com"
    username: str = "x-access-token"   # git username paired with the token
    protocol: str = "https"
    name: str = "git-credential"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        host, username, protocol = self.host, self.username, self.protocol
        credential_source = provider.credential

        @router.get("/git-credentials")
        async def git_credentials(identity: Identity = Depends(authed)) -> dict[str, str]:
            if credential_source is None:
                raise HTTPException(status_code=503, detail="no credential source")
            cred = await credential_source.get(identity)
            return {
                "protocol": protocol,
                "host": host,
                "username": username,
                "password": cred.value,
            }

        return router
