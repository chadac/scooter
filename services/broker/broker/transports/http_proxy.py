"""http-proxy transport — transparent reverse proxy with credential injection.

Mounts `/{provider}/{path:path}` (all methods). Injects the provider's
credential into the outbound request to `upstream`; forwards; returns the
upstream response. The agent sees normal API responses and never the token.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

import httpx
from fastapi import APIRouter, Depends, Request, Response

from ..core.autolink import Link, LinkRule, post_link
from ..core.types import AuthDependency, Identity, Provider, Transport

logger = logging.getLogger(__name__)

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
    # Auto-link rules: when a proxied request matches one AND returns 2xx, the
    # created resource (PR/MR/issue) is associated with the agent's conversation
    # by POSTing to agent_host_url/conversations/{id}/links. Empty = no auto-link.
    link_rules: list[LinkRule] = field(default_factory=list)
    # Where to POST the link. Set from settings (broker's agent-host URL).
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
                # Build the outbound request, then let the credential mutate it in
                # place (headers, and in future params/body). Passing the whole
                # request — not just a header dict — is what lets a provider like
                # Datadog set MULTIPLE auth headers (DD-API-KEY + DD-APPLICATION-KEY).
                outbound = client.build_request(
                    request.method,
                    f"{upstream}/{path}",
                    headers=headers,
                    content=body or None,
                    params=dict(request.query_params),
                )
                if credential_source is not None:
                    cred = await credential_source.get(identity)
                    cred.inject(outbound)
                upstream_resp = await client.send(outbound)

            # Auto-link: if this was a create-a-resource request that succeeded,
            # associate the created PR/MR/issue with the caller's conversation.
            # Best-effort — never let it affect the response the agent gets back.
            if self.link_rules and 200 <= upstream_resp.status_code < 300 and identity.conversation_id:
                await self._maybe_autolink(request.method, path, upstream_resp, identity.conversation_id)

            return Response(
                content=upstream_resp.content,
                status_code=upstream_resp.status_code,
                headers={
                    k: v for k, v in upstream_resp.headers.items()
                    if k.lower() not in {"transfer-encoding", "content-encoding", "content-length"}
                },
            )

        return router

    async def _maybe_autolink(
        self, method: str, path: str, resp: httpx.Response, conversation_id: str
    ) -> None:
        """Try each link rule against a successful proxied request; on the first
        match, extract the created resource and post it as a conversation link.
        Fully best-effort: any parse/extract error is swallowed."""
        rule = next((r for r in self.link_rules if r.matches(method, path)), None)
        if rule is None:
            return
        try:
            data = json.loads(resp.content)
        except (json.JSONDecodeError, ValueError):
            logger.debug("auto-link: response for %s %s wasn't JSON — skipping", method, path)
            return
        if not isinstance(data, dict):
            return
        try:
            link: Link | None = rule.extract(data)
        except Exception as e:  # a bad response shape must not break the proxy
            logger.warning("auto-link extract failed for %s %s: %s", method, path, e)
            return
        if link is not None and link.url:
            await post_link(self.agent_host_url, conversation_id, link)
