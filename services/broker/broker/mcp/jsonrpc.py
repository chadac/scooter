"""The MCP JSON-RPC layer — pure, transport-free, and therefore testable without
HTTP or auth.

WHY THIS IS HAND-WRITTEN rather than using the `mcp` Python SDK (1.29.0 is in the
pinned nixpkgs, so availability is not the reason).

The SDK is built around a long-lived `Server` plus a `StreamableHTTPSessionManager`,
and our tool list is PER CALLER: a provider's reply tool is offered only when that
provider is attached to THIS conversation (the attachment gate — see
scooter_broker_lib/mcp.py). The agent-host's TypeScript server handles that by
building a fresh `McpServer` per request, which the TS SDK makes a two-line
operation; the Python SDK's equivalent means standing up a per-request transport and
anyio task group inside a FastAPI handler, for a server that needs none of the
session machinery.

What we need instead is small and fully determined: a stateless server handling
`initialize`, `tools/list`, `tools/call` and `ping` over a single JSON response.
Stateless streamable-HTTP is already proven against goose in this codebase — the
agent-host's endpoint runs with `sessionIdGenerator: undefined` — and keeping the
protocol layer pure means the auth seam (the part that actually matters here) is
tested separately from the wire format.

The trade-off, stated plainly: future protocol revisions are ours to track. The
surface is four methods, which is why that is an acceptable trade and would not be if
we needed resources, prompts, sampling or server-initiated notifications.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# JSON-RPC 2.0 error codes, plus MCP's use of them.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

SERVER_NAME = "scooter-broker"
SERVER_VERSION = "1.0.0"

# Protocol revisions we can speak. We echo back the client's if we know it, else our
# preferred one — the negotiation the spec prescribes. Ordered newest first.
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]


@dataclass(frozen=True)
class ToolDescriptor:
    """A tool as `tools/list` advertises it."""

    name: str
    description: str
    input_schema: dict[str, Any]
    title: str = ""

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        }
        if self.title:
            out["title"] = self.title
        return out


@dataclass(frozen=True)
class CallOutcome:
    """What a tool call produced."""

    text: str
    is_error: bool = False


# Supplied by the caller (routes.py): the tools this caller may see, and how to run
# one. Both are per-request, which is the whole reason this layer takes them as
# arguments instead of holding a registry.
ListTools = Callable[[], Awaitable[list[ToolDescriptor]]]
CallTool = Callable[[str, dict[str, Any]], Awaitable[CallOutcome]]


def _error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _result(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _negotiate(requested: Any) -> str:
    if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return PREFERRED_PROTOCOL_VERSION


async def handle_message(
    message: Any,
    *,
    list_tools: ListTools,
    call_tool: CallTool,
) -> dict[str, Any] | None:
    """Handle ONE JSON-RPC message. Returns the response, or None for a notification
    (which by spec gets no response body).

    Never raises: a tool that blows up becomes an `isError` result, and a malformed
    message becomes a JSON-RPC error. An exception escaping here would be a 500 on
    the agent's tool call, which reads to the agent as the platform being broken
    rather than its call being wrong.
    """
    if not isinstance(message, dict):
        return _error(None, INVALID_REQUEST, "expected a JSON-RPC object")

    method = message.get("method")
    req_id = message.get("id")
    # `message.get("params") or {}` would be wrong: an empty list is FALSY, so a
    # malformed `"params": []` became `{}` and sailed through the type check below.
    params = message.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return _error(req_id, INVALID_PARAMS, "params must be an object")

    # A notification has no `id` and takes no response. `notifications/initialized`
    # is the one every client sends; returning a response to it makes strict clients
    # complain about an unsolicited message.
    is_notification = "id" not in message

    if method == "initialize":
        return _result(
            req_id,
            {
                "protocolVersion": _negotiate(params.get("protocolVersion")),
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )

    if method == "ping":
        return _result(req_id, {})

    if is_notification:
        # Everything else without an id is a notification we have nothing to do for
        # (initialized, cancelled, progress). Silence is the correct response.
        return None

    if method == "tools/list":
        tools = await list_tools()
        return _result(req_id, {"tools": [t.to_wire() for t in tools]})

    if method == "tools/call":
        name = params.get("name")
        if not isinstance(name, str) or not name:
            return _error(req_id, INVALID_PARAMS, "tools/call requires a tool name")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            return _error(req_id, INVALID_PARAMS, "tools/call arguments must be an object")
        outcome = await call_tool(name, arguments)
        return _result(
            req_id,
            {"content": [{"type": "text", "text": outcome.text}], "isError": outcome.is_error},
        )

    return _error(req_id, METHOD_NOT_FOUND, f"unknown method {method!r}")


async def handle_payload(
    payload: Any,
    *,
    list_tools: ListTools,
    call_tool: CallTool,
) -> Any | None:
    """Handle a request body, which may be one message or (pre-2025-06-18) a batch.

    Batching was REMOVED in MCP 2025-06-18, but older clients may still send an
    array and the cost of accepting one is three lines. An all-notification batch
    produces no response at all, which is why the return is Optional.
    """
    if isinstance(payload, list):
        responses = [
            r
            for r in [
                await handle_message(m, list_tools=list_tools, call_tool=call_tool)
                for m in payload
            ]
            if r is not None
        ]
        return responses or None
    return await handle_message(payload, list_tools=list_tools, call_tool=call_tool)
