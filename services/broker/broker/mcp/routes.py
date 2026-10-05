"""The /mcp endpoint — authenticate, establish the per-call context, let fastmcp serve.

Three pieces meet here:

  * `authenticate_mcp` (core/auth.py) produces an Identity whose conversation is bound
    to the presented credentials — an allowlisted control-plane SA token plus a signed
    conversation token, or a sandbox's own SA.
  * each enabled provider's `McpTools` transport carries a `FastMCP` server, mounted
    NAMESPACE-LESS so tool names stay flat (`github_comment`, not
    `github_github_comment`) — the skills name these and ui/src/toolCallView.ts
    matches on them.
  * a per-provider middleware establishes the `ToolContext` for the duration of a
    call, and applies the attachment gate when listing.

WHY THE MIDDLEWARE IS PER-PROVIDER rather than one on the parent. A tool needs ITS
provider's credential-injecting upstream, which depends on which tool is executing and
not on the request, so a single parent middleware would need a tool-name→provider map
— and reading a mounted server's tool names is async, which the sync app factory
cannot do. fastmcp's `mount` invokes a mounted server's own middleware ("Mounted
servers now always have their lifespan and middleware invoked"), so binding the
middleware to the provider at mount time removes the map entirely.

STATELESS, because the broker runs 2+ replicas (modules/broker.nix) and a load
balancer will not pin an agent to one of them. The same stance the agent-host's
endpoint takes (`sessionIdGenerator: undefined`), which is proven against goose.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from fastmcp.server.middleware import Middleware

from scooter_broker_lib.autolink import list_links
from scooter_broker_lib.mcp import ToolContext, collect_mcp_servers, gate_for, tool_context
from scooter_broker_lib.types import Identity, Provider
from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)

# Where the authenticated Identity is parked for the middleware to pick up. The ASGI
# scope rather than a ContextVar: the auth middleware and the tool middleware are in
# the same request task, and the scope is the thing ASGI already guarantees is
# per-request.
SCOPE_IDENTITY = "scooter_identity"


class _Upstream:
    """Issue a request to a provider's upstream with its credential injected.

    Mirrors HttpProxy's injection exactly — build the request, let the Credential
    mutate it, send — so a provider's tool and its raw proxy route cannot drift in how
    they authenticate. That matters because the two are meant to be interchangeable:
    the skills tell the agent to prefer the tool and fall back to the raw route.
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
    """The conversation's links, read from the agent-host and cached for ONE call.

    Cached because the attachment gates ask for them once per tool: four providers
    attached to a conversation would otherwise mean four identical HTTP round trips on
    every `tools/list`, on the latency path of the agent's first turn.
    """

    def __init__(self, agent_host_url: str, conversation_id: str) -> None:
        self._agent_host_url = agent_host_url
        self._conversation_id = conversation_id
        self._cached: list[dict[str, Any]] | None = None

    async def list(self) -> list[dict[str, Any]]:
        if self._cached is None:
            try:
                links = await list_links(self._agent_host_url, self._conversation_id)
                # APPENDED, never prepended: the conversation_map is the FALLBACK, so a
                # real link always wins. first_target takes the first COMPLETE target in
                # order, so position is the whole precedence rule.
                self._cached = links + await self._resource_map()
            except httpx.HTTPError as exc:
                # A gate that cannot read the links must not CRASH tools/list — the
                # agent would get no tools at all, including the ungated ones. Degrade
                # to "nothing is attached": the gated tools are absent, which is the
                # same outcome as a genuinely unattached conversation.
                logger.warning(
                    "could not read conversation links; gated tools will be absent",
                    extra={"conversation_id": self._conversation_id, "error": format_error(exc)},
                )
                self._cached = []
        return self._cached

    async def _resource_map(self) -> list[dict[str, Any]]:
        """The webhooks conversation_map rows, shaped as links.

        THE FALLBACK the agent-host's tools had, which this must not silently lose: a
        conversation created before `ref` existed has a link carrying neither a usable
        ref nor a parseable URL, and the mapping is the only record of its target.

        Read from the AGENT-HOST (GET /conversations/{id}/resource-map), not from the
        table — the broker reading the webhooks service's own table would breach the
        per-service split contrib/README.md exists to keep.

        `resource_id` goes in `url` deliberately. Each provider resolves a link with its
        `parse_*_resource_id`, which tries the short form FIRST and then falls back to
        the URL parser — so one field covers both an html_url link and an `o/r#7`
        mapping, with no second code path in any contrib. Slack is the exception: its
        channel/ts are their own columns, so they become a real `ref`.
        """
        if not self._agent_host_url or not self._conversation_id:
            return []
        url = f"{self._agent_host_url.rstrip('/')}/conversations/{self._conversation_id}/resource-map"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(url)
                response.raise_for_status()
                mappings = (response.json() or {}).get("mappings") or []
        except (httpx.HTTPError, ValueError) as exc:
            # Best-effort, exactly as the agent-host's lookup was: a DB blip must not
            # break a tool call, it just means "no fallback target".
            logger.warning(
                "could not read the conversation resource-map; using links alone",
                extra={"conversation_id": self._conversation_id, "error": format_error(exc)},
            )
            return []
        rows: list[dict[str, Any]] = []
        for mapping in mappings:
            if not isinstance(mapping, dict):
                continue
            source = mapping.get("source") or ""
            ref: dict[str, Any] = {}
            if source == "slack":
                channel = mapping.get("slackChannel")
                if channel:
                    ref = {"channel": channel, "threadTs": mapping.get("slackTs")}
            rows.append({
                "source": source,
                "resourceType": mapping.get("resourceType") or "",
                "url": mapping.get("resourceId") or "",
                "ref": ref,
            })
        return rows


def _identity_from_scope() -> Identity | None:
    """The Identity the auth middleware stashed, via fastmcp's request accessor."""
    from fastmcp.server.dependencies import get_http_request

    try:
        request = get_http_request()
    except RuntimeError:
        return None
    return request.scope.get(SCOPE_IDENTITY)


class ProviderToolMiddleware(Middleware):
    """Establish the ToolContext for one provider's tools, and apply their gates.

    MUST subclass fastmcp's `Middleware`: the base provides the dispatch that routes a
    message to `on_list_tools` / `on_call_tool`, so a duck-typed object with the right
    method names is simply "not callable" at dispatch time. Worse, `list_tools`
    SWALLOWS that into a warning and returns no tools from the provider — so a broken
    middleware presents as "this integration contributes nothing", not as an error.
    """

    def __init__(self, provider: Provider, upstream: str, agent_host_url: str) -> None:
        super().__init__()
        self.provider = provider
        self.upstream = upstream
        self.agent_host_url = agent_host_url

    def _context(self, identity: Identity) -> ToolContext:
        return ToolContext(
            identity=identity,
            provider=self.provider,
            upstream=_Upstream(self.provider, identity, self.upstream),
            links=_Links(self.agent_host_url, identity.conversation_id),
        )

    async def on_list_tools(self, context, call_next):
        """THE ATTACHMENT GATE. A provider's reply tool is offered only when that
        provider is actually linked to this conversation — the thing that stopped the
        agent raw-curling Slack into the root channel."""
        tools = await call_next(context)
        identity = _identity_from_scope()
        if identity is None:
            return tools
        ctx = self._context(identity)
        kept = []
        for tool in tools:
            gate = gate_for(getattr(tool, "name", "") or "")
            if gate is None:
                kept.append(tool)
                continue
            try:
                with tool_context(ctx):
                    allowed = await gate(ctx)
            except Exception as exc:
                # A gate that throws means "not attached", never "attached": a tool
                # offered because its gate errored is the ungated-reply-tool failure
                # the gate exists to prevent.
                logger.warning(
                    "tool gate FAILED; leaving the tool unlisted",
                    extra={
                        "tool": getattr(tool, "name", "?"),
                        "provider": self.provider.name,
                        "conversation_id": identity.conversation_id,
                        "error": format_error(exc),
                    },
                )
                continue
            if allowed:
                kept.append(tool)
        return kept

    async def on_call_tool(self, context, call_next):
        identity = _identity_from_scope()
        if identity is None:
            # No verified caller: refuse rather than run a tool with no conversation.
            # Unreachable through the mounted app (auth runs first), so this is the
            # belt to that braces.
            raise RuntimeError("no verified identity for this tool call")
        with tool_context(self._context(identity)):
            return await call_next(context)


class _AuthMiddleware:
    """Authenticate every request to the mounted MCP app and stash the Identity.

    Pure ASGI rather than BaseHTTPMiddleware: the MCP app streams, and
    BaseHTTPMiddleware buffers the response body, which breaks SSE.
    """

    def __init__(self, app: ASGIApp, authenticate) -> None:
        self.app = app
        self.authenticate = authenticate
        # RE-EXPOSE the wrapped app's lifespan. fastmcp's streamable-HTTP app starts a
        # session-manager task group in its lifespan, and mounting an ASGI app does NOT
        # run that app's lifespan — the parent owns the only lifespan ASGI knows about.
        # Without composing it into the broker's, EVERY tool call fails with "task group
        # was not initialized", which is a runtime failure a mount-time check cannot see.
        # Why: issue #700.
        self.lifespan = getattr(app, "lifespan", None)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive=receive)
        try:
            identity = await self.authenticate(request)
        except HTTPException as exc:
            await JSONResponse({"detail": exc.detail}, status_code=exc.status_code)(
                scope, receive, send
            )
            return
        scope[SCOPE_IDENTITY] = identity
        await self.app(scope, receive, send)


async def assert_tool_names_unique(providers: list[Provider]) -> None:
    """Fail STARTUP if two providers contribute a tool of the same name.

    Tool names are flat (mounted namespace-less, so the skills and
    ui/src/toolCallView.ts can match on a name), so a name is a global identity and a
    collision has nothing to arbitrate it but mount order — which differs between a
    rebuild and a rollback. A contrib that duplicates a capability therefore names the
    tool for its provider (`brave_web_search`), which is also what lets several search
    providers be enabled at once; this catches the case where someone did not.

    Awaited from the lifespan rather than run at mount time: reading a server's tools is
    async and the app factory is sync. Why: PR #707.
    """
    owner_of: dict[str, str] = {}
    for provider, server in collect_mcp_servers(providers):
        # run_middleware=False: the gates need a conversation (none at startup), and a
        # gated-out tool must still count. Why: PR #707.
        for tool in await server.list_tools(run_middleware=False):
            owner = owner_of.get(tool.name)
            if owner is not None and owner != provider.name:
                raise RuntimeError(
                    f"two providers contribute a tool named {tool.name!r}: {owner!r} and "
                    f"{provider.name!r}. Tool names are flat, so this cannot be resolved "
                    "by mount order — rename one of them after its provider (the search "
                    "contribs do: `brave_web_search`, `kagi_web_search`)."
                )
            owner_of[tool.name] = provider.name


def create_mcp_app(providers: list[Provider], *, authenticate, agent_host_url: str = "") -> ASGIApp:
    """The ASGI app serving POST /mcp, with auth in front of it.

    Returns an app to mount rather than an APIRouter: fastmcp serves MCP as its own
    ASGI app, and wrapping it keeps its streaming intact.
    """
    from fastmcp import FastMCP

    parent = FastMCP(name="scooter-broker")

    mounted = collect_mcp_servers(providers)
    for provider, server in mounted:
        upstream = ""
        for transport in provider.transports:
            candidate = getattr(transport, "upstream", "")
            if candidate:
                upstream = candidate
                break
        # Bound to the provider, on the provider's OWN server — which is what removes
        # the need for a tool-name→provider map. See the module docstring.
        server.add_middleware(ProviderToolMiddleware(provider, upstream, agent_host_url))
        # namespace=None: flat tool names.
        parent.mount(server)

    logger.info(
        "assembled MCP tool servers",
        extra={"providers": sorted({p.name for p, _ in mounted})},
    )

    app = parent.http_app(path="/", stateless_http=True)
    return _AuthMiddleware(app, authenticate)
