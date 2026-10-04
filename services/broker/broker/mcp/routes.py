"""The /mcp route — authenticate, assemble the caller's tool set, dispatch.

This is where the three pieces meet: `authenticate_mcp` (core/auth.py) produces an
Identity whose conversation is bound to the presented credentials, `collect_mcp_tools`
(scooter_broker_lib.mcp) gathers what the enabled providers contribute, and the
attachment gates decide which of those THIS conversation may see.

STATELESS, because the broker runs 2+ replicas (modules/broker.nix) and a load
balancer will not pin an agent to one of them. No session id is issued and none is
required — the same stance the agent-host's endpoint takes (`sessionIdGenerator:
undefined`), which is proven against goose.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Request, Response

from scooter_broker_lib.autolink import list_links
from scooter_broker_lib.mcp import McpTool, ToolContext, ToolResult, collect_mcp_tools
from scooter_broker_lib.types import Identity, Provider
from scooter_lib.logging_config import format_error

from .jsonrpc import CallOutcome, ToolDescriptor, handle_payload

logger = logging.getLogger(__name__)


class _Upstream:
    """Issue a request to a provider's upstream with its credential injected.

    Mirrors HttpProxy's injection exactly — build the request, let the Credential
    mutate it, send — so a provider's tool and its raw proxy route cannot drift in
    how they authenticate. That matters because the two are meant to be
    interchangeable: the skills tell the agent to prefer the tool and fall back to
    the raw route.
    """

    def __init__(self, provider: Provider, identity: Identity, upstream: str) -> None:
        self._provider = provider
        self._identity = identity
        self._upstream = (upstream or "").rstrip("/")

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        if not self._upstream:
            raise RuntimeError(
                f"provider {self._provider.name!r} declared MCP tools with no `upstream`; "
                "set McpTools(upstream=...)"
            )
        url = f"{self._upstream}/{path.lstrip('/')}"
        async with httpx.AsyncClient(timeout=30) as client:
            outbound = client.build_request(
                method.upper(), url, json=json, params=params, headers=headers
            )
            if self._provider.credential is not None:
                cred = await self._provider.credential.get(self._identity)
                cred.inject(outbound)
            return await client.send(outbound)


class _Links:
    """The conversation's links, read from the agent-host and cached for ONE request.

    Cached because the attachment gates ask for them once per tool: four providers
    attached to a conversation would otherwise mean four identical HTTP round trips
    on every `tools/list`, on the latency path of the agent's first turn.
    """

    def __init__(self, agent_host_url: str, conversation_id: str) -> None:
        self._agent_host_url = agent_host_url
        self._conversation_id = conversation_id
        self._cached: list[dict[str, Any]] | None = None

    async def list(self) -> list[dict[str, Any]]:
        if self._cached is None:
            try:
                self._cached = await list_links(self._agent_host_url, self._conversation_id)
            except httpx.HTTPError as exc:
                # A gate that cannot read the links must not CRASH tools/list — the
                # agent would get no tools at all, including the ones with no gate.
                # Degrade to "nothing is attached": the gated tools are absent, which
                # is the same outcome as a genuinely unattached conversation.
                logger.warning(
                    "could not read conversation links; gated tools will be absent",
                    extra={"conversation_id": self._conversation_id, "error": format_error(exc)},
                )
                self._cached = []
        return self._cached


def _context(provider: Provider, identity: Identity, agent_host_url: str, links: _Links) -> ToolContext:
    upstream = ""
    for transport in provider.transports:
        candidate = getattr(transport, "upstream", "")
        if candidate:
            upstream = candidate
            break
    return ToolContext(
        identity=identity,
        provider=provider,
        upstream=_Upstream(provider, identity, upstream),
        links=links,
    )


def create_mcp_router(providers: list[Provider], *, authed, agent_host_url: str = "") -> APIRouter:
    """Mount POST/GET /mcp.

    `providers` is the app's already-discovered list, so the tool set is fixed at
    startup and a duplicate tool name fails there (collect_mcp_tools raises) rather
    than on an agent's first tool call.
    """
    router = APIRouter()

    # Raises on a duplicate name — deliberately at startup. See collect_mcp_tools.
    owned: list[tuple[Provider, McpTool]] = collect_mcp_tools(providers)
    logger.info(
        "assembled MCP tools",
        extra={"tools": [t.name for _, t in owned], "providers": sorted({p.name for p, _ in owned})},
    )

    @router.post("/mcp")
    async def mcp(request: Request, identity: Identity = Depends(authed)) -> Response:
        try:
            payload = await request.json()
        except ValueError:
            return Response(
                content='{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}',
                media_type="application/json",
                status_code=400,
            )

        links = _Links(agent_host_url, identity.conversation_id)

        async def visible() -> list[tuple[Provider, McpTool]]:
            """The tools this conversation may see — the attachment gate."""
            out: list[tuple[Provider, McpTool]] = []
            for provider, tool in owned:
                if tool.gate is None:
                    out.append((provider, tool))
                    continue
                try:
                    if await tool.gate(_context(provider, identity, agent_host_url, links)):
                        out.append((provider, tool))
                except Exception as exc:
                    # A gate that throws means "not attached", never "attached": a
                    # tool offered because its gate errored is the ungated-reply-tool
                    # failure the gate exists to prevent.
                    logger.warning(
                        "tool gate FAILED; leaving the tool unregistered",
                        extra={
                            "tool": tool.name,
                            "provider": provider.name,
                            "conversation_id": identity.conversation_id,
                            "error": format_error(exc),
                        },
                    )
            return out

        async def list_tools() -> list[ToolDescriptor]:
            return [
                ToolDescriptor(
                    name=tool.name,
                    description=tool.description,
                    input_schema=tool.input_schema,
                    title=tool.title,
                )
                for _, tool in await visible()
            ]

        async def call_tool(name: str, arguments: dict[str, Any]) -> CallOutcome:
            match = next(((p, t) for p, t in await visible() if t.name == name), None)
            if match is None:
                # Either no such tool, or one whose gate says this conversation may
                # not use it. The message does not distinguish them: "not available
                # to this conversation" is true in both cases and the alternative
                # tells an agent (or a reader of its transcript) which integrations
                # exist on a conversation that cannot use them.
                return CallOutcome(
                    text=f"No tool named {name!r} is available to this conversation.",
                    is_error=True,
                )
            provider, tool = match
            try:
                result: ToolResult = await tool.handler(
                    _context(provider, identity, agent_host_url, links), arguments
                )
            except Exception as exc:
                # Surface it as a tool error, not a 500. A 500 reads to the agent as
                # the platform being broken; an isError reads as its call failing,
                # which is what actually happened and what it can act on.
                logger.exception(
                    "MCP tool raised",
                    extra={
                        "tool": tool.name,
                        "provider": provider.name,
                        "conversation_id": identity.conversation_id,
                    },
                )
                return CallOutcome(text=f"Tool {tool.name!r} failed: {exc}", is_error=True)
            return CallOutcome(text=result.text, is_error=result.is_error)

        response = await handle_payload(payload, list_tools=list_tools, call_tool=call_tool)
        if response is None:
            # An all-notification payload. 202 with no body is what the streamable
            # HTTP spec prescribes; a JSON `null` would be a protocol violation some
            # clients reject.
            return Response(status_code=202)
        import json as _json

        return Response(content=_json.dumps(response), media_type="application/json")

    @router.get("/mcp")
    async def mcp_stream(identity: Identity = Depends(authed)) -> Response:
        """No server-initiated stream. A stateless server has nothing to push, and
        405 is the spec's way of saying so — clients fall back to POST-only, which is
        the mode they use against the agent-host's endpoint today."""
        return Response(status_code=405)

    return router
