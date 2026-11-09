"""The /mcp endpoint end to end over the real protocol: the broker's wiring between the
HTTP request and a contrib's function.

Covers auth running in front, namespace-less mounting (flat tool names), the ToolContext
carrying the verified conversation, the attachment gate on `tools/list`, and contexts not
leaking between calls, driven over HTTP with a real MCP client handshake.
"""

from __future__ import annotations

import json
from contextlib import AsyncExitStack

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastmcp import FastMCP

from broker.mcp.routes import create_mcp_app
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Identity, Provider

CONV = "conv-under-test"


# --- a provider whose tools exercise the context + the gate -----------------------

def _build_provider(*, attached: bool) -> Provider:
    """A fresh provider per test, so gate state cannot leak through fastmcp's global registry."""
    mcp = FastMCP(name="probe")

    @mcp.tool
    async def probe_conversation(ctx: ToolContext = ToolContextDep) -> str:
        """Report the conversation the broker verified for this call."""
        return f"conversation={ctx.identity.conversation_id}"

    async def _is_attached(_ctx: ToolContext) -> bool:
        return attached

    @gate(_is_attached)
    @mcp.tool
    async def probe_gated(ctx: ToolContext = ToolContextDep) -> str:
        """Only offered when the gate opens."""
        return "gated tool ran"

    @mcp.tool
    async def probe_refuses() -> ToolResult:
        """Refuse, the way a contrib reports a failed call."""
        return ToolResult.error("refused: not allowed here")

    @mcp.tool
    async def probe_succeeds() -> ToolResult:
        """Succeed with a ToolResult."""
        return ToolResult.ok("done")

    return Provider(name="probe", transports=[McpTools(server=mcp, upstream="https://example.test")])


def _app(provider: Provider, *, authenticate) -> tuple[FastAPI, object]:
    """Mount the MCP app the way create_app does and hand back it, since its lifespan must be composed by the caller."""
    mcp_app = create_mcp_app([provider], authenticate=authenticate, agent_host_url="")
    app = FastAPI()
    app.mount("/mcp", mcp_app)
    return app, mcp_app


async def _ok_auth(_request):
    return Identity(
        conversation_id=CONV,
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:agent-host",
        owner="alice@example.com",
    )


async def _denied_auth(_request):
    raise HTTPException(status_code=403, detail="invalid conversation token")


class _Mcp:
    """A minimal MCP client over the mounted app: initialize, then call."""

    def __init__(self, built: tuple[FastAPI, object]) -> None:
        app, mcp_app = built
        self._mcp_app = mcp_app
        self._app = app
        self._stack = AsyncExitStack()
        # httpx's ASGITransport emits no lifespan events, so the MCP app's is entered by hand.
        self._client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://broker"
        )
        self._headers = {
            "content-type": "application/json",
            # Streamable HTTP may answer with either.
            "accept": "application/json, text/event-stream",
        }

    async def __aenter__(self):
        await self._stack.__aenter__()
        if self._mcp_app.lifespan is not None:
            await self._stack.enter_async_context(self._mcp_app.lifespan(self._app))
        await self._send(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"},
            },
            rpc_id=0,
        )
        return self

    async def __aexit__(self, *exc):
        await self._client.aclose()
        await self._stack.__aexit__(*exc)

    async def _send(self, method: str, params: dict | None = None, *, rpc_id: int = 1):
        return await self._client.post(
            "/mcp/",
            headers=self._headers,
            json={"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}},
        )

    @staticmethod
    def _payload(response: httpx.Response) -> dict:
        """The JSON-RPC payload, from either a JSON body or an SSE frame."""
        body = response.text
        if "text/event-stream" in response.headers.get("content-type", ""):
            data = [
                line.partition("data:")[2].strip()
                for line in body.splitlines()
                if line.startswith("data:")
            ]
            assert data, f"SSE response carried no data frame: {body!r}"
            return json.loads(data[-1])
        return json.loads(body)

    async def _result(self, method: str, params: dict | None = None) -> dict:
        response = await self._send(method, params)
        payload = self._payload(response)
        assert "error" not in payload, f"{method} failed: {payload['error']}"
        return payload["result"]

    async def call_result(self, name: str, arguments: dict | None = None) -> dict:
        return await self._result("tools/call", {"name": name, "arguments": arguments or {}})

    async def tool_names(self) -> set[str]:
        return {t["name"] for t in (await self._result("tools/list"))["tools"]}

    async def call(self, name: str, arguments: dict | None = None) -> str:
        result = await self._result("tools/call", {"name": name, "arguments": arguments or {}})
        blocks = result.get("content") or []
        return "\n".join(b.get("text", "") for b in blocks)


# --- auth sits in front of everything ---------------------------------------------

async def test_a_refused_caller_never_reaches_a_tool():
    app, _ = _app(_build_provider(attached=True), authenticate=_denied_auth)
    # No lifespan is needed because auth refuses before the session manager is reached.
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://broker")
    res = await client.post(
        "/mcp/",
        headers={"content-type": "application/json", "accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
    )
    await client.aclose()
    assert res.status_code == 403
    # The reason stays generic.
    assert "invalid conversation token" in res.text


# --- the mount keeps names flat ---------------------------------------------------

async def test_tool_names_are_flat_not_namespaced():
    """The skills and services/ui/src/toolCallView.ts match on the flat tool name."""
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        names = await mcp.tool_names()
    assert "probe_conversation" in names
    assert not any(n.startswith("probe_probe") for n in names), names


# --- the context carries the verified conversation --------------------------------

async def test_a_tool_sees_the_verified_conversation():
    """The id a tool acts on comes from the credential."""
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        out = await mcp.call("probe_conversation")
    assert f"conversation={CONV}" in out


async def test_the_context_is_established_per_call_and_does_not_leak():
    """The second of two calls on one connection must still see its own context, not a stale one."""
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        first = await mcp.call("probe_conversation")
        second = await mcp.call("probe_conversation")
    assert f"conversation={CONV}" in first
    assert f"conversation={CONV}" in second


# --- a ToolResult reaches the client as the protocol result ---------------------

async def test_an_error_ToolResult_sets_isError_with_plain_text():
    """Clients read `isError`, not a flag inside the text."""
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        result = await mcp.call_result("probe_refuses")
    assert result.get("isError") is True
    assert result["content"] == [{"type": "text", "text": "refused: not allowed here"}]
    assert not result.get("structuredContent")


async def test_an_ok_ToolResult_is_plain_text_and_not_an_error():
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        result = await mcp.call_result("probe_succeeds")
        listed = (await mcp._result("tools/list"))["tools"]
    assert not result.get("isError")
    assert result["content"] == [{"type": "text", "text": "done"}]
    # No output schema, so clients do not demand structured content.
    assert all("outputSchema" not in t for t in listed if t["name"] == "probe_succeeds")


# --- the attachment gate ----------------------------------------------------------

async def test_a_gated_tool_is_OFFERED_when_attached():
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        names = await mcp.tool_names()
    assert "probe_gated" in names


async def test_a_gated_tool_is_ABSENT_when_not_attached():
    """Absent, not present-and-failing."""
    async with _Mcp(_app(_build_provider(attached=False), authenticate=_ok_auth)) as mcp:
        names = await mcp.tool_names()
    assert "probe_gated" not in names
    # The gate filters; it does not empty the list.
    assert "probe_conversation" in names


# --- flat names make a name a global identity -------------------------------------
#
# Two contribs that pick one name would leave mount order to decide which tool the agent
# talks to, so the collision is refused at startup.

def _tool_provider(provider_name: str, tool_name: str) -> Provider:
    mcp = FastMCP(name=provider_name)

    async def _run() -> str:
        return "ran"

    _run.__name__ = tool_name
    mcp.tool(_run)
    return Provider(
        name=provider_name, transports=[McpTools(server=mcp, upstream="https://example.test")]
    )


async def test_two_providers_owning_one_tool_name_REFUSE_to_start():
    from broker.mcp.routes import assert_tool_names_unique

    providers = [_tool_provider("brave", "web_search"), _tool_provider("kagi", "web_search")]
    with pytest.raises(RuntimeError) as excinfo:
        await assert_tool_names_unique(providers)
    message = str(excinfo.value)
    # Both owners are named so the operator knows which two to choose between.
    assert "web_search" in message and "brave" in message and "kagi" in message


async def test_distinct_tool_names_across_providers_are_fine():
    from broker.mcp.routes import assert_tool_names_unique

    await assert_tool_names_unique(
        [_tool_provider("brave", "web_search"), _tool_provider("slack", "slack_respond")]
    )


async def test_one_provider_whose_server_is_collected_twice_is_not_a_collision():
    """A provider carrying its tool server on more than one transport is one owner, not two claimants."""
    from broker.mcp.routes import assert_tool_names_unique

    provider = _tool_provider("brave", "web_search")
    provider.transports.append(McpTools(server=provider.transports[0].server, upstream="https://x.test"))
    await assert_tool_names_unique([provider])


async def test_a_GATED_tool_still_counts_toward_uniqueness():
    """The check reads each server's own registry rather than what one conversation would be offered."""
    from broker.mcp.routes import assert_tool_names_unique

    async def _closed(_ctx: ToolContext) -> bool:
        return False

    gated = _tool_provider("one", "shared_name")
    gate(_closed)(await gated.transports[0].server.get_tool("shared_name"))
    with pytest.raises(RuntimeError):
        await assert_tool_names_unique([gated, _tool_provider("two", "shared_name")])
