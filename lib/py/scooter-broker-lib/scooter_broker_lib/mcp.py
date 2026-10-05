"""MCP tools — the surface a provider contributes AGENT TOOLS through.

A contrib already owns its credential source, its routes, its webhooks handler, its
UI row and its skills. It could not own its TOOL: `github_comment` lived in the
agent-host, so enabling or disabling `contrib/github` did nothing to the agent's tool
surface, and `contrib/gitlab/default.nix` declared `ui.tools.gitlab_comment` — UI
metadata for a tool the contrib neither owned nor gated. See issue #700.

A tool declared here ships iff its provider is enabled, which is the same gate
`skills` already uses and for the same stated reason: a tool for an integration that
isn't wired teaches the agent to call something that 404s, and then to read that 404
as the feature being broken.

A CONTRIB DECLARES TOOLS ON ITS OWN `FastMCP` SERVER, with the decorator and the
schema derived from type hints:

    mcp = FastMCP(name="echo")

    @mcp.tool
    async def echo_say(message: str, ctx: ToolContext = ToolContextDep) -> str:
        '''Echo a message back.'''
        return f"echo: {message}"

and hands it to the broker via `McpTools(server=mcp, upstream=...)`. The broker mounts
it NAMESPACE-LESS, so names stay flat (`echo_say`, not `echo_echo_say`) — the skills
name these tools and `ui/src/toolCallView.ts` matches on the tool name.

WHAT THIS MODULE IS AND IS NOT. fastmcp owns the protocol, the schema generation, the
tool registry and the per-request middleware; there is no reason for us to own any of
that (an earlier revision of this PR hand-wrote a JSON-RPC layer on the wrong premise
that per-caller tool lists didn't fit the library — `on_list_tools` middleware is
built for exactly that). What stays here is the part fastmcp has no opinion about:

  * `ToolContext` — the VERIFIED caller, a credential-injecting upstream caller, and
    the conversation's links, injected per call.
  * `ToolResult.from_upstream` — the "never hide an error" rule.

Both are carried over verbatim from the agent-host implementation this replaces
(services/agent-host/src/agent/agentTools.ts), because both were learned the hard way:
the agent used to hand-run `curl -sf`, which fails SILENTLY — and a silent failure is
how it retried and posted duplicate Slack messages; and an ungated reply tool is what
led it to raw-curl Slack into the root channel.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable, Iterator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from fastmcp.dependencies import Depends

if TYPE_CHECKING:  # avoid a runtime import cycle (types imports nothing from here)
    import httpx
    from fastmcp import FastMCP

    from .types import Credential, Identity, Provider

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# What a tool returns
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ToolResult:
    """A tool's outcome: one text block plus the error flag.

    A tool may also just `return` a string — fastmcp wraps it — but a tool that can
    FAIL should return one of these, because `is_error` is what tells the model the
    call did not do what it asked for.
    """

    text: str
    is_error: bool = False

    @staticmethod
    def ok(text: str) -> "ToolResult":
        return ToolResult(text=text)

    @staticmethod
    def error(text: str) -> "ToolResult":
        return ToolResult(text=text, is_error=True)

    @staticmethod
    def from_upstream(
        response: "httpx.Response",
        *,
        success_text: str,
        ok_field_check: bool = False,
        idempotent_errors: Sequence[str] = (),
    ) -> "ToolResult":
        """Map an upstream response to a result, surfacing failures VERBATIM.

        THE "never hide an error" rule, and the single place it is enforced. The real
        status and the upstream body go to the agent unmodified: the abstraction must
        not swallow, rewrite or generic-ify an error, because the agent's recovery
        depends on the actual message (and because a hidden error gets retried, which
        for a `respond` tool means posting twice).

        `ok_field_check` additionally handles APIs that report logical failure with a
        200 — Slack's `{"ok": false, "error": "..."}`. Without it a failed Slack post
        reads as a success.

        `idempotent_errors` are logical errors that mean "the desired state already
        exists", which is SUCCESS: reacting with an emoji the message already carries
        (`already_reacted`) achieved the goal. The webhooks handler posts a 👀 before
        dispatch, so without this the agent's own ack-react always failed.
        """
        if not 200 <= response.status_code < 300:
            return ToolResult.error(
                f"Request FAILED (HTTP {response.status_code}). The service returned:\n{response.text}"
            )
        if ok_field_check:
            try:
                data = response.json()
            except (ValueError, json.JSONDecodeError):
                data = None
            if isinstance(data, dict) and data.get("ok") is False:
                err = data.get("error")
                if err and err in idempotent_errors:
                    return ToolResult.ok(f"{success_text} (already done — {err}.)")
                return ToolResult.error(
                    f"The service rejected the request: {err or 'unknown error'}\n"
                    f"Full response:\n{response.text}"
                )
        return ToolResult.ok(success_text)


# ---------------------------------------------------------------------------
# What a tool is given
# ---------------------------------------------------------------------------

@runtime_checkable
class UpstreamCaller(Protocol):
    """Issue a request to the provider's upstream with its credential injected.

    The same build-request-then-`Credential.inject` path `HttpProxy` uses, so a
    provider's tool and its raw proxy route authenticate identically by construction.
    `path` is relative to the provider's upstream, with no leading slash required.
    """

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> "httpx.Response": ...


@runtime_checkable
class LinkLookup(Protocol):
    """The conversation's links, for attachment gating and inferred targets.

    Returns the agent-host's link rows (`source`, `resourceType`, `url`, `ref`,
    `title`). The broker reads these from the agent-host rather than keeping its own
    copy — the agent-host owns conversation state.
    """

    async def list(self) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class ToolContext:
    """What a tool is handed, beyond its own arguments.

    Injected, never assembled by the contrib: `upstream` needs the provider's
    credential source and `identity` is the output of the broker's two-token check, so
    a contrib that built its own could get either wrong — and an `identity` a contrib
    constructed would be an identity nobody verified.
    """

    identity: "Identity"
    provider: "Provider"
    upstream: UpstreamCaller
    links: LinkLookup

    async def credential(self) -> "Credential":
        """The provider's resolved credential, for a tool that must hold it directly
        (rare — prefer `upstream`, which never exposes it)."""
        if self.provider.credential is None:
            raise RuntimeError(f"provider {self.provider.name!r} has no credential source")
        return await self.provider.credential.get(self.identity)


# The per-call context. A ContextVar rather than a parameter threaded through fastmcp:
# the broker's middleware knows the provider and the verified identity, the tool knows
# neither, and fastmcp's DI resolves a dependency by CALLING it — so the value has to
# be reachable from a plain function with no arguments.
_CURRENT: ContextVar["ToolContext | None"] = ContextVar("scooter_tool_context", default=None)


@contextmanager
def tool_context(ctx: ToolContext) -> Iterator[None]:
    """Make `ctx` the current tool context for the duration of one tool call.

    Used by the broker's per-provider middleware. Resets on exit rather than leaving
    the value set: these run in a worker that serves many conversations, and a context
    left behind would be handed to the NEXT call — a cross-conversation leak.
    """
    token = _CURRENT.set(ctx)
    try:
        yield
    finally:
        _CURRENT.reset(token)


def current_tool_context() -> ToolContext:
    """The current call's context. Raises outside a tool call, which is a bug in the
    wiring rather than something a tool should handle."""
    ctx = _CURRENT.get()
    if ctx is None:
        raise RuntimeError(
            "no ToolContext is set — a tool asked for one outside a broker tool call. "
            "The broker's per-provider middleware establishes it; see "
            "broker/mcp/routes.py."
        )
    return ctx


# What a contrib writes as the parameter default. `Depends` marks the parameter as
# DEPENDENCY-INJECTED, which is also what keeps it out of the tool's input schema — a
# `ctx` argument the model could try to supply would be both confusing and forgeable.
ToolContextDep = Depends(current_tool_context)


ToolGate = Callable[[ToolContext], Awaitable[bool]]

# Gates by tool NAME. A side registry rather than an attribute on the tool object:
# fastmcp's FunctionTool is a pydantic model, so `setattr` on it is not something to
# rely on across versions. Names are globally unique — the broker fails startup on a
# duplicate — so the name is a sound key.
_GATES: dict[str, ToolGate] = {}


def gate(predicate: ToolGate):
    """Mark a tool as ATTACHMENT-GATED: listed only when `predicate` says so.

    Applied ABOVE `@mcp.tool`, so it decorates the registered tool:

        @gate(_has_echo_link)
        @mcp.tool
        async def echo_attached(...): ...

    The gate runs on `tools/list`, so a gated-out tool is one the agent never sees —
    rather than one it sees and discovers it cannot use. That distinction is the whole
    value: an ungated reply tool is what sent the agent raw-curling Slack into the root
    channel.
    """

    def decorate(tool):
        name = getattr(tool, "name", None) or getattr(tool, "__name__", None)
        if not name:
            raise TypeError(
                "@gate could not determine the tool's name — apply it ABOVE @mcp.tool"
            )
        _GATES[name] = predicate
        return tool

    return decorate


def gate_for(tool_name: str) -> "ToolGate | None":
    """The gate registered for `tool_name`, if any. Read by the broker's middleware."""
    return _GATES.get(tool_name)


# ---------------------------------------------------------------------------
# Collecting what the providers contribute
# ---------------------------------------------------------------------------

def collect_mcp_servers(providers: "Sequence[Provider]") -> list[tuple["Provider", "FastMCP"]]:
    """Every enabled provider's tool server, paired with the provider that owns it.

    The core's assembly rule stays one sentence — for each enabled provider, mount
    every transport's routes AND mount every transport's MCP server — so adding a
    tool-bearing integration still never edits the core.

    Duplicate TOOL names are caught at startup by the broker (see routes.py), not
    here: the names live inside the FastMCP servers and reading them is async. A
    contrib avoids that collision by naming a duplicated capability after its provider
    — the search contribs each own a `<provider>_web_search` — which is also what lets
    a deployment enable several of them at once.
    """
    collected: list[tuple["Provider", "FastMCP"]] = []
    for provider in providers:
        for transport in provider.transports:
            server = getattr(transport, "mcp_server", None)
            if server is None:
                continue
            collected.append((provider, server))
    return collected
