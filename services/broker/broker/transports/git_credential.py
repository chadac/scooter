"""git-credential transport — vends a git credential blob.

Mounts `/{provider}/git-credentials`. The in-pod `git-credential-broker` helper
calls it with the pod's SA token and gets back
`{protocol, host, username, password}` for HTTPS git operations.

Generalizes the openhands-nix one-off `/git-credentials` endpoint into a
transport any provider can declare.

Design stage: interface only.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter

from ..core.types import AuthDependency, Provider, Transport


@dataclass
class GitCredential(Transport):
    """Git credential-helper transport for one git host."""

    host: str                          # e.g. "github.com"
    username: str = "x-access-token"   # git username paired with the token
    protocol: str = "https"
    name: str = "git-credential"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        """Mount GET /git-credentials: authenticate -> credential.get ->
        return {protocol, host, username, password=credential.value}.
        """
        ...
