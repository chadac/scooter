"""MCP tools: the surface a provider contributes agent tools through.

A contrib declares tools on its own `FastMCP` server and hands it to the broker via
`McpTools(server=mcp, upstream=...)`; the broker mounts it namespace-less, so tool
names stay flat and globally unique, and a tool ships iff its provider is enabled.
fastmcp owns the protocol, schema generation and registry; this module holds only
`ToolContext` (the verified caller, injected per call) and `ToolResult.from_upstream`
(the rule that an upstream error is surfaced verbatim, never hidden).
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
from fastmcp.tools import ToolResult as FastMCPToolResult
from mcp.types import TextContent

if TYPE_CHECKING:  # avoids a runtime import cycle with .types
    import httpx
    from fastmcp import FastMCP

    from .types import Credential, Identity, Provider

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# What a tool returns
# ---------------------------------------------------------------------------

class ToolResult(FastMCPToolResult):
    """A tool outcome: text, flagged `isError` when the call failed."""

    @property
    def text(self) -> str:
        return "".join(b.text for b in self.content if isinstance(b, TextContent))

    @staticmethod
    def ok(text: str) -> "ToolResult":
        return ToolResult(content=[TextContent(type="text", text=text)])

    @staticmethod
    def error(text: str) -> "ToolResult":
        return ToolResult(content=[TextContent(type="text", text=text)], is_error=True)

    @staticmethod
    def from_upstream(
        response: "httpx.Response",
        *,
        success_text: str,
        ok_field_check: bool = False,
        idempotent_errors: Sequence[str] = (),
    ) -> "ToolResult":
        """Map an upstream response to a result, passing the real status and body through verbatim on failure.

        `ok_field_check` handles APIs that report logical failure with a 200 (Slack's
        `{"ok": false}`), and `idempotent_errors` names the logical errors that mean the
        desired state already exists and so count as success.
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
    """Issue a request to the provider's upstream with its credential injected, over the same path `HttpProxy` uses."""

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
    """The conversation's link rows (`source`, `resourceType`, `url`, `ref`, `title`), read from the agent-host."""

    async def list(self) -> list[dict[str, Any]]: ...


@dataclass(frozen=True)
class ToolContext:
    """What a tool is handed beyond its own arguments, injected by the broker so `identity` is always the verified one."""

    identity: "Identity"
    provider: "Provider"
    upstream: UpstreamCaller
    links: LinkLookup

    async def credential(self) -> "Credential":
        """The provider's resolved credential, for the rare tool that must hold it directly."""
        if self.provider.credential is None:
            raise RuntimeError(f"provider {self.provider.name!r} has no credential source")
        return await self.provider.credential.get(self.identity)


# The per-call context, a ContextVar because fastmcp's DI resolves a dependency by calling a zero-argument function.
_CURRENT: ContextVar["ToolContext | None"] = ContextVar("scooter_tool_context", default=None)


@contextmanager
def tool_context(ctx: ToolContext) -> Iterator[None]:
    """Make `ctx` the current tool context for one tool call, resetting on exit so it never leaks to the next conversation."""
    token = _CURRENT.set(ctx)
    try:
        yield
    finally:
        _CURRENT.reset(token)


def current_tool_context() -> ToolContext:
    """The current call's context, raising outside a tool call."""
    ctx = _CURRENT.get()
    if ctx is None:
        raise RuntimeError(
            "no ToolContext is set — a tool asked for one outside a broker tool call. "
            "The broker's per-provider middleware establishes it; see "
            "broker/mcp/routes.py."
        )
    return ctx


# The parameter default a contrib writes; `Depends` keeps `ctx` out of the tool's input schema.
ToolContextDep = Depends(current_tool_context)


ToolGate = Callable[[ToolContext], Awaitable[bool]]

# Gates keyed by tool name, which the broker guarantees is globally unique.
_GATES: dict[str, ToolGate] = {}


def gate(predicate: ToolGate):
    """Mark a tool as gated, listed only when `predicate` says so; apply it above `@mcp.tool`."""

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
    """The gate registered for `tool_name`, if any."""
    return _GATES.get(tool_name)


# ---------------------------------------------------------------------------
# Collecting what the providers contribute
# ---------------------------------------------------------------------------

def collect_mcp_servers(providers: "Sequence[Provider]") -> list[tuple["Provider", "FastMCP"]]:
    """Every provider's tool server paired with the provider that owns it; duplicate tool names are caught by the broker at startup."""
    collected: list[tuple["Provider", "FastMCP"]] = []
    for provider in providers:
        for transport in provider.transports:
            server = getattr(transport, "mcp_server", None)
            if server is None:
                continue
            collected.append((provider, server))
    return collected
