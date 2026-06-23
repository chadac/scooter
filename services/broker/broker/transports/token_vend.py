"""token-vend transport — returns a short-lived raw token to an authorized
caller.

Mounts `/{provider}/token`. For callers that must briefly hold the token
themselves (vs. proxying through the broker). Use sparingly — the token is
exposed to the caller, unlike http-proxy.

Design stage: interface only.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter

from ..core.types import AuthDependency, Provider, Transport


@dataclass
class TokenVend(Transport):
    name: str = "token-vend"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        """Mount GET /token: authenticate -> credential.get ->
        return {token, expires_at}.
        """
        ...
