"""http-proxy transport — transparent reverse proxy with credential injection.

Mounts `/{provider}/{path:path}` (all methods). Injects the provider's
credential into the outbound request to `upstream`; forwards; returns the
upstream response. The agent sees normal API responses and never the token.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import APIRouter, Depends, Request, Response

from ..core.types import AuthDependency, Identity, Provider, Transport

# Headers we never forward upstream.
_HOP_BY_HOP = frozenset({
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailer",
    "upgrade", "proxy-authorization", "proxy-authenticate", "authorization",
})


@dataclass
class HttpProxy(Transport):
    upstream: str = ""                  # e.g. "https://api.github.com"
    name: str = "http-proxy"
    methods: tuple[str, ...] = ("GET", "POST", "PUT", "PATCH", "DELETE")

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        upstream = self.upstream.rstrip("/")
        credential_source = provider.credential

        @router.api_route("/{path:path}", methods=list(self.methods))
        async def proxy(
            path: str, request: Request, identity: Identity = Depends(authed)
        ) -> Response:
            headers = {
                k: v for k, v in request.headers.items()
                if k.lower() not in _HOP_BY_HOP
            }
            if credential_source is not None:
                cred = await credential_source.get(identity)
                headers = cred.inject(headers)
            body = await request.body()
            async with httpx.AsyncClient(timeout=30) as client:
                upstream_resp = await client.request(
                    request.method,
                    f"{upstream}/{path}",
                    headers=headers,
                    content=body or None,
                    params=dict(request.query_params),
                )
            return Response(
                content=upstream_resp.content,
                status_code=upstream_resp.status_code,
                headers={
                    k: v for k, v in upstream_resp.headers.items()
                    if k.lower() not in {"transfer-encoding", "content-encoding", "content-length"}
                },
            )

        return router
