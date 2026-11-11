"""http-proxy transport: a transparent reverse proxy with credential injection.

Mounts `/{provider}/{path:path}`, injects the provider's credential into the
outbound request to `upstream` and returns the upstream response, so the agent
sees normal API responses and never the token.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

import httpx
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse

from ..autolink import Link, LinkRule, post_link
from ..forge.hosts import api_forge_request
from ..forge.policy import DENY_HEADER, denial_message, enforce
from ..types import AuthDependency, Identity, Provider, Transport
from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)

# Headers never forwarded upstream.
_HOP_BY_HOP = frozenset({
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailer",
    "upgrade", "proxy-authorization", "proxy-authenticate", "authorization",
})


def _upstream_failure(provider: str, outbound: httpx.Request, e: httpx.TransportError) -> JSONResponse:
    """A 504 for an upstream timeout, else a 502, naming the provider and error class."""
    status = 504 if isinstance(e, httpx.TimeoutException) else 502
    url = str(outbound.url.copy_with(query=None))
    logger.warning(
        "http-proxy upstream failed",
        extra={"provider": provider, "http_method": outbound.method, "url": url, "error": format_error(e)},
    )
    return JSONResponse(
        {"message": f"{provider} upstream failed: {type(e).__name__}", "provider": provider, "error": type(e).__name__},
        status_code=status,
        headers={"X-Broker-Upstream-Url": url},
    )


@dataclass
class HttpProxy(Transport):
    upstream: str = ""                  # e.g. "https://api.github.com"
    name: str = "http-proxy"
    methods: tuple[str, ...] = ("GET", "POST", "PUT", "PATCH", "DELETE")
    # A proxied request matching a rule and returning 2xx links the created resource to the conversation.
    link_rules: list[LinkRule] = field(default_factory=list)
    # Where the link is POSTed.
    agent_host_url: str = ""

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
            body = await request.body()
            async with httpx.AsyncClient(timeout=30) as client:
                # The credential mutates the built request in place, so a provider can set several auth headers.
                outbound = client.build_request(
                    request.method,
                    f"{upstream}/{path}",
                    headers=headers,
                    content=body or None,
                    params=dict(request.query_params),
                )
                forge_req = api_forge_request(
                    provider, identity, via="http-proxy",
                    method=request.method, url=outbound.url, body=body,
                )
                if forge_req is not None:
                    decision = await enforce(provider.forge_policy, forge_req)
                    if not decision.allowed:
                        return JSONResponse(
                            {"message": denial_message(decision)},
                            status_code=403,
                            headers={DENY_HEADER: decision.reason or "denied"},
                        )
                if credential_source is not None:
                    cred = await credential_source.get(identity, forge_req)
                    cred.inject(outbound)
                try:
                    upstream_resp = await client.send(outbound)
                except httpx.TransportError as e:
                    return _upstream_failure(provider.name, outbound, e)

            # Best-effort auto-link that never affects the response the agent gets back.
            if self.link_rules and 200 <= upstream_resp.status_code < 300 and identity.conversation_id:
                await self._maybe_autolink(request.method, path, upstream_resp, identity.conversation_id)

            resp_headers = {
                k: v for k, v in upstream_resp.headers.items()
                if k.lower() not in {"transfer-encoding", "content-encoding", "content-length"}
            }
            # On a failure, surface the URL the proxy requested (path only, since the query may carry secrets) so a mis-prefixed path is visible.
            if upstream_resp.status_code >= 400:
                resp_headers["X-Broker-Upstream-Url"] = str(outbound.url.copy_with(query=None))

            return Response(
                content=upstream_resp.content,
                status_code=upstream_resp.status_code,
                headers=resp_headers,
            )

        return router

    async def _maybe_autolink(
        self, method: str, path: str, resp: httpx.Response, conversation_id: str
    ) -> None:
        """Post the created resource of the first matching link rule as a conversation link, swallowing any parse or extract error."""
        rule = next((r for r in self.link_rules if r.matches(method, path)), None)
        if rule is None:
            return
        try:
            data = json.loads(resp.content)
        except (json.JSONDecodeError, ValueError):
            logger.debug(
                "auto-link skipped; response was not JSON",
                extra={
                    "conversation_id": conversation_id,
                    "http_method": method,
                    "path": path,
                    "status": resp.status_code,
                },
            )
            return
        if not isinstance(data, dict):
            return
        try:
            link: Link | None = rule.extract(data)
        except Exception as e:
            logger.warning(
                "auto-link extract failed",
                extra={
                    "conversation_id": conversation_id,
                    "http_method": method,
                    "path": path,
                    "status": resp.status_code,
                    "error": format_error(e),
                },
            )
            return
        if link is not None and link.url:
            await post_link(self.agent_host_url, conversation_id, link)
