"""http-proxy transport — transparent reverse proxy with credential injection.

Mounts `/{provider}/{path:path}` (all methods). Injects the provider's
credential into the outbound request to `upstream`; forwards; returns the
upstream response. The agent sees normal API responses and never the token.

A transport may mount multiple routes — http-proxy mounts the catch-all proxy
route (and could add provider-specific sub-routes later).

Design stage: interface only. Implementation lifts openhands-nix proxy.py
(hop-by-hop header filtering, inspect_request/response hooks).
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter

from ..core.types import AuthDependency, Provider, Transport


@dataclass
class HttpProxy(Transport):
    """Reverse-proxy transport bound to one upstream base URL."""

    upstream: str                      # e.g. "https://api.github.com"
    name: str = "http-proxy"
    methods: tuple[str, ...] = ("GET", "POST", "PUT", "PATCH", "DELETE")

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        """Mount /{path:path}: authenticate -> credential.get -> inject ->
        forward to {upstream}/{path} -> return response.
        """
        ...
