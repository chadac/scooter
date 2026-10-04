"""The MCP JSON-RPC layer, independent of auth and HTTP (issue #700).

The protocol layer is hand-written (see broker/mcp/jsonrpc.py for why), so these
tests ARE the spec compliance evidence: what `initialize` negotiates, that a
notification gets no response, that `tools/call` shapes its result the way a client
expects, and that nothing escapes as an exception.
"""

from __future__ import annotations

import pytest

from broker.mcp.jsonrpc import (
    METHOD_NOT_FOUND,
    PREFERRED_PROTOCOL_VERSION,
    CallOutcome,
    ToolDescriptor,
    handle_message,
    handle_payload,
)

TOOLS = [
    ToolDescriptor(
        name="github_comment",
        description="Comment on the PR.",
        input_schema={"type": "object", "properties": {"body": {"type": "string"}}},
        title="Comment on the GitHub PR/issue",
    ),
    ToolDescriptor(name="bare", description="No title, no args.", input_schema={"type": "object"}),
]


async def _list():
    return TOOLS


async def _call(name, arguments):
    if name == "github_comment":
        return CallOutcome(text=f"posted: {arguments.get('body')}")
    return CallOutcome(text="boom", is_error=True)


async def send(message):
    return await handle_message(message, list_tools=_list, call_tool=_call)


# --- initialize -------------------------------------------------------------------

async def test_initialize_advertises_tools_capability():
    res = await send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert res["result"]["serverInfo"]["name"] == "scooter-broker"
    assert "tools" in res["result"]["capabilities"]


async def test_initialize_echoes_a_protocol_version_we_support():
    res = await send(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}
    )
    assert res["result"]["protocolVersion"] == "2025-03-26"


async def test_initialize_falls_back_for_an_unknown_protocol_version():
    """Negotiation, not rejection: a client asking for something we don't know gets
    our preferred version and decides for itself whether to proceed."""
    res = await send(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}}
    )
    assert res["result"]["protocolVersion"] == PREFERRED_PROTOCOL_VERSION


# --- notifications ----------------------------------------------------------------

async def test_initialized_notification_gets_no_response():
    """A response to a notification is an unsolicited message some clients reject."""
    assert await send({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None


async def test_an_unknown_notification_is_silently_accepted():
    assert await send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {}}) is None


async def test_an_unknown_method_WITH_an_id_is_an_error():
    res = await send({"jsonrpc": "2.0", "id": 7, "method": "resources/list"})
    assert res["error"]["code"] == METHOD_NOT_FOUND
    assert res["id"] == 7


# --- tools/list -------------------------------------------------------------------

async def test_tools_list_uses_the_wire_names():
    res = await send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = res["result"]["tools"]
    assert [t["name"] for t in tools] == ["github_comment", "bare"]
    # inputSchema, camelCase — a snake_case key here means no client sees the schema.
    assert tools[0]["inputSchema"]["properties"]["body"]["type"] == "string"
    assert tools[0]["title"] == "Comment on the GitHub PR/issue"


async def test_title_is_omitted_rather_than_empty_when_unset():
    res = await send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert "title" not in res["result"]["tools"][1]


# --- tools/call -------------------------------------------------------------------

async def test_tools_call_returns_a_text_content_block():
    res = await send(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "github_comment", "arguments": {"body": "hi"}},
        }
    )
    assert res["result"]["content"] == [{"type": "text", "text": "posted: hi"}]
    assert res["result"]["isError"] is False


async def test_a_failing_tool_is_a_RESULT_with_isError_not_a_jsonrpc_error():
    """MCP's contract: a tool that fails is a successful call reporting failure, so
    the model SEES the message and can adapt. A JSON-RPC error is a protocol fault."""
    res = await send(
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "other"}}
    )
    assert "error" not in res
    assert res["result"]["isError"] is True


async def test_tools_call_without_arguments_passes_an_empty_dict():
    res = await send(
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "github_comment"}}
    )
    assert res["result"]["content"][0]["text"] == "posted: None"


@pytest.mark.parametrize(
    "params", [{}, {"name": ""}, {"name": 5}, {"name": "github_comment", "arguments": "nope"}]
)
async def test_tools_call_rejects_malformed_params(params):
    res = await send({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": params})
    assert "error" in res


# --- robustness -------------------------------------------------------------------

async def test_a_non_object_message_is_an_invalid_request():
    assert "error" in await send(["not", "an", "object"])
    assert "error" in await send("nope")


async def test_non_object_params_are_rejected_without_raising():
    res = await send({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": []})
    assert "error" in res


async def test_ping_is_answered():
    res = await send({"jsonrpc": "2.0", "id": 9, "method": "ping"})
    assert res["result"] == {}


# --- batching (pre-2025-06-18 clients) --------------------------------------------

async def test_a_batch_returns_one_response_per_request():
    res = await handle_payload(
        [
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ],
        list_tools=_list,
        call_tool=_call,
    )
    assert [r["id"] for r in res] == [1, 2]


async def test_an_all_notification_batch_returns_nothing():
    """Which is why the route answers 202 with no body rather than a JSON null."""
    res = await handle_payload(
        [{"jsonrpc": "2.0", "method": "notifications/initialized"}],
        list_tools=_list,
        call_tool=_call,
    )
    assert res is None
