"""The /mcp endpoint end to end — our WIRING, over the real protocol (issue #700).

An earlier revision hand-wrote the JSON-RPC layer and tested it directly. fastmcp owns
the protocol now, so re-testing `initialize` or batching would be testing a dependency.
What is still ours, and what this file covers, is everything between the HTTP request
and a contrib's function:

  * auth runs in front and a refusal never reaches a tool;
  * each provider's server is mounted NAMESPACE-LESS, so tool names stay flat;
  * the ToolContext carries the VERIFIED conversation, not anything the caller sent;
  * the attachment gate decides what `tools/list` offers THIS conversation;
  * a context does not leak from one call to the next.

Driven over HTTP with a real MCP client handshake, because the mount, the ASGI auth
middleware and the streaming response are exactly the parts a unit test would miss.
"""

from __future__ import annotations

import json
from contextlib import AsyncExitStack

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastmcp import FastMCP

from broker.mcp.routes import create_mcp_app
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, gate
from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_broker_lib.types import Identity, Provider

CONV = "conv-under-test"


# --- a provider whose tools exercise the context + the gate -----------------------

def _build_provider(*, attached: bool) -> Provider:
    """A fresh provider per test: tool names are module-global in fastmcp's registry,
    so reusing one server across tests would make gate state leak between them."""
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

    return Provider(name="probe", transports=[McpTools(server=mcp, upstream="https://example.test")])


def _app(provider: Provider, *, authenticate) -> tuple[FastAPI, object]:
    """Mount the MCP app the way create_app does, and hand back its lifespan.

    Composing the lifespan is load-bearing, not ceremony: fastmcp starts its
    session-manager task group there, and mounting an ASGI app does NOT run that app's
    lifespan. Omitting it is how the first version of this test failed with "task group
    was not initialized" — a runtime failure that would have hit every real tool call,
    and one no mount-time check can see.
    """
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
        # httpx's ASGITransport does not emit lifespan events, so the MCP app's
        # lifespan is entered explicitly below — the same composition create_app does,
        # just driven by hand.
        self._client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://broker"
        )
        self._headers = {
            "content-type": "application/json",
            # Both, because streamable HTTP may answer with either.
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
        """The JSON-RPC payload, from either response shape.

        Streamable HTTP may answer with `application/json` OR an SSE frame, and which
        one you get is the server's choice — so a test that string-matches the body is
        testing the framing. Parse it and assert on the structure instead.
        """
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
        # Surface a JSON-RPC error as a test failure naming it, rather than as a
        # confusing absence further down.
        assert "error" not in payload, f"{method} failed: {payload['error']}"
        return payload["result"]

    async def tool_names(self) -> set[str]:
        return {t["name"] for t in (await self._result("tools/list"))["tools"]}

    async def call(self, name: str, arguments: dict | None = None) -> str:
        result = await self._result("tools/call", {"name": name, "arguments": arguments or {}})
        blocks = result.get("content") or []
        return "\n".join(b.get("text", "") for b in blocks)


# --- auth sits in FRONT of everything ---------------------------------------------

async def test_a_refused_caller_never_reaches_a_tool():
    app, _ = _app(_build_provider(attached=True), authenticate=_denied_auth)
    # No lifespan needed: auth refuses before the session manager is ever reached,
    # which is itself the assertion — nothing downstream runs.
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://broker")
    res = await client.post(
        "/mcp/",
        headers={"content-type": "application/json", "accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
    )
    await client.aclose()
    assert res.status_code == 403
    # The reason stays generic — a body distinguishing "expired" from "bad signature"
    # tells an attacker which half to work on.
    assert "invalid conversation token" in res.text


# --- the mount keeps names FLAT ---------------------------------------------------

async def test_tool_names_are_flat_not_namespaced():
    """`mount(server, namespace=None)`. The skills name these tools and
    ui/src/toolCallView.ts matches on the name, so `probe_probe_conversation` would
    break both."""
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        names = await mcp.tool_names()
    assert "probe_conversation" in names
    assert not any(n.startswith("probe_probe") for n in names), names


# --- the context carries the VERIFIED conversation --------------------------------

async def test_a_tool_sees_the_verified_conversation():
    """The whole point of #700: the id a tool acts on comes from the credential, and a
    contrib never assembles its own context."""
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        out = await mcp.call("probe_conversation")
    assert f"conversation={CONV}" in out


async def test_the_context_is_established_per_call_and_does_not_leak():
    """Two calls on one connection: the second must still see its own context, not a
    stale one. These run in a worker serving many conversations, so a context left set
    would be handed to the next call."""
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        first = await mcp.call("probe_conversation")
        second = await mcp.call("probe_conversation")
    assert f"conversation={CONV}" in first
    assert f"conversation={CONV}" in second


# --- the attachment gate ----------------------------------------------------------

async def test_a_gated_tool_is_OFFERED_when_attached():
    async with _Mcp(_app(_build_provider(attached=True), authenticate=_ok_auth)) as mcp:
        names = await mcp.tool_names()
    assert "probe_gated" in names


async def test_a_gated_tool_is_ABSENT_when_not_attached():
    """Absent, not present-and-failing. An ungated reply tool is what sent the agent
    raw-curling Slack into the root channel."""
    async with _Mcp(_app(_build_provider(attached=False), authenticate=_ok_auth)) as mcp:
        names = await mcp.tool_names()
    assert "probe_gated" not in names
    # The ungated tool is unaffected — the gate filters, it does not empty the list.
    assert "probe_conversation" in names


# --- flat names make a name a GLOBAL identity -------------------------------------
#
# Enforced rather than documented because the failure is silent: two contribs that
# independently pick one name leave mount order to decide which tool the agent talks
# to, and import order differs between a rebuild and a rollback. A contrib that
# duplicates a capability avoids the collision by naming the tool for its provider
# (`brave_web_search`, `kagi_web_search`) — which is also what lets a deployment enable
# several search providers at once. The scenario below is the mistake that remains:
# someone ships a second `web_search`. Why: issue #700, review of PR #707.

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
    # Both owners named: the operator has to know WHICH two to choose between.
    assert "web_search" in message and "brave" in message and "kagi" in message


async def test_distinct_tool_names_across_providers_are_fine():
    from broker.mcp.routes import assert_tool_names_unique

    await assert_tool_names_unique(
        [_tool_provider("brave", "web_search"), _tool_provider("slack", "slack_respond")]
    )


async def test_one_provider_whose_server_is_collected_twice_is_not_a_collision():
    """A provider may carry its tool server on more than one transport. That is the
    same owner, not two claimants."""
    from broker.mcp.routes import assert_tool_names_unique

    provider = _tool_provider("brave", "web_search")
    provider.transports.append(McpTools(server=provider.transports[0].server, upstream="https://x.test"))
    await assert_tool_names_unique([provider])


async def test_a_GATED_tool_still_counts_toward_uniqueness():
    """The check reads each server's own registry, not what a conversation would be
    offered. A gated tool is invisible to `tools/list` for an unattached conversation —
    if the check saw only that view, two providers could collide on a name that shows
    up for some conversations and not others."""
    from broker.mcp.routes import assert_tool_names_unique

    async def _closed(_ctx: ToolContext) -> bool:
        return False

    gated = _tool_provider("one", "shared_name")
    gate(_closed)(await gated.transports[0].server.get_tool("shared_name"))
    with pytest.raises(RuntimeError):
        await assert_tool_names_unique([gated, _tool_provider("two", "shared_name")])
