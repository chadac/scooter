"""Echo's agent tools — and the reference for how a contrib tests its own tools.

A tool handler is a plain async function over a `ToolContext`, so it needs no broker,
no HTTP and no Kubernetes to test: build a context with fakes and call it. That is the
point of the surface taking a context rather than reaching for globals.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
import pytest

from scooter_broker_lib.mcp import ToolContext, collect_mcp_servers, gate_for, tool_context
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_echo import mcp_tools as echo_tools
from scooter_contrib_echo.broker_provider import echo_contrib


@dataclass
class FakeUpstream:
    """Stands in for the credential-injecting caller. Records the call, returns a
    canned response — so a handler's upstream behaviour is testable without a
    network or a secret."""

    response: httpx.Response
    calls: list[tuple[str, str]] = None  # type: ignore[assignment]

    def __post_init__(self):
        self.calls = []

    async def request(self, method: str, path: str, **_kw: Any) -> httpx.Response:
        self.calls.append((method, path))
        return self.response


@dataclass
class FakeLinks:
    rows: list[dict[str, Any]]

    async def list(self) -> list[dict[str, Any]]:
        return self.rows


def _ctx(
    *,
    conversation_id: str = "conv-1",
    owner: str | None = None,
    response: httpx.Response | None = None,
    links: list[dict[str, Any]] | None = None,
) -> ToolContext:
    return ToolContext(
        identity=Identity(
            conversation_id=conversation_id,
            namespace="agent-sandbox",
            service_account="system:serviceaccount:agent-sandbox:agent-host",
            owner=owner,
        ),
        provider=Provider(name="echo", transports=[]),
        upstream=FakeUpstream(response or httpx.Response(200, json={"ok": True})),
        links=FakeLinks(links or []),
    )


def _fn(name: str):
    """The decorated tool's function.

    `@mcp.tool` REGISTERS the tool and returns the original function, so the module
    attribute is still directly callable. Calling it is what keeps these unit tests
    free of a server, a client and the protocol — the schema and the wire format are
    fastmcp's to get right, not ours to re-test.
    """
    return getattr(echo_tools, name)


async def _declared() -> dict[str, object]:
    """The tools as fastmcp registered them, by name.

    `run_middleware=False` so the attachment gate does NOT run: these assertions are
    about what echo DECLARES, and the gate's own behaviour is tested directly.
    """
    return {t.name: t for t in await echo_tools.mcp.list_tools(run_middleware=False)}


# --- echo_say: the minimum shape --------------------------------------------------

async def test_say_echoes_the_message():
    assert await _fn("echo_say")(ctx=_ctx(), message="hello") == "echo: hello"


@pytest.mark.parametrize("message", ["", "   "])
async def test_say_rejects_a_blank_message(message):
    """fastmcp enforces the SCHEMA — a missing or wrongly-typed `message` never reaches
    the function — so what is left for the tool is what the type system cannot say.
    "not only whitespace" is not a type."""
    out = await _fn("echo_say")(ctx=_ctx(), message=message)
    assert "required" in out


# --- echo_whoami: the verified caller ----------------------------------------------

async def test_whoami_reports_the_verified_conversation():
    out = await _fn("echo_whoami")(ctx=_ctx(conversation_id="conv-42"))
    assert "conversation: conv-42" in out


async def test_whoami_says_the_owner_is_unknown_rather_than_guessing():
    """A sandbox SA name carries no owner, so the tool must not invent one."""
    out = await _fn("echo_whoami")(ctx=_ctx(owner=None))
    assert "unknown" in out


async def test_whoami_reports_an_owner_from_the_conversation_token():
    out = await _fn("echo_whoami")(ctx=_ctx(owner="alice@example.com"))
    assert "owner: alice@example.com" in out


# --- echo_upstream: credential injection + never hiding an error -------------------

@pytest.mark.parametrize("given", ["/get", "get", "  /get  "])
async def test_upstream_normalizes_the_path_the_agent_passes(given):
    """A leading slash is optional and whitespace is tolerated: a model will produce
    both forms, and `ctx.upstream` joins against the provider's base either way."""
    ctx = _ctx()
    res = await _fn("echo_upstream")(ctx=ctx, path=given)
    assert res.is_error is False
    assert ctx.upstream.calls == [("GET", "get")]  # type: ignore[attr-defined]


async def test_upstream_requires_a_path():
    res = await _fn("echo_upstream")(ctx=_ctx(), path="")
    assert res.is_error is True


async def test_upstream_surfaces_a_failure_VERBATIM():
    """The load-bearing rule. The agent must see the real status and body — a hidden
    error gets retried, which for a reply-shaped tool means posting twice."""
    ctx = _ctx(response=httpx.Response(503, text="upstream exploded"))
    res = await _fn("echo_upstream")(ctx=ctx, path="/get")
    assert res.is_error is True
    assert "503" in res.text
    assert "upstream exploded" in res.text


async def test_upstream_treats_a_200_with_ok_false_as_a_FAILURE():
    """Slack's shape: HTTP 200 carrying a logical failure. Without ok_field_check a
    failed post reads as a success."""
    ctx = _ctx(response=httpx.Response(200, json={"ok": False, "error": "channel_not_found"}))
    res = await _fn("echo_upstream")(ctx=ctx, path="/post")
    assert res.is_error is True
    assert "channel_not_found" in res.text


async def test_upstream_treats_an_IDEMPOTENT_error_as_success():
    """"The desired state already exists" is success. Slack's `already_reacted` is the
    real case — the webhooks handler posts a 👀 before dispatch, so the agent's own
    ack-react always failed until these counted as done."""
    ctx = _ctx(response=httpx.Response(200, json={"ok": False, "error": "already_done"}))
    res = await _fn("echo_upstream")(ctx=ctx, path="/post")
    assert res.is_error is False
    assert "already done" in res.text


# --- echo_attached: the attachment gate -------------------------------------------

async def test_the_gate_is_CLOSED_with_no_echo_link():
    assert await gate_for("echo_attached")(_ctx(links=[])) is False


async def test_the_gate_ignores_another_provider_s_links():
    """The failure this prevents: offering echo's reply tool on a conversation that is
    only attached to GitHub."""
    ctx = _ctx(links=[{"source": "github", "url": "https://github.com/o/r/pull/1"}])
    assert await gate_for("echo_attached")(ctx) is False


async def test_the_gate_OPENS_with_an_echo_link():
    ctx = _ctx(links=[{"source": "echo", "url": "https://example.test/echo/1"}])
    assert await gate_for("echo_attached")(ctx) is True


async def test_attached_lists_only_echo_links():
    ctx = _ctx(
        links=[
            {"source": "echo", "url": "https://example.test/echo/1"},
            {"source": "github", "url": "https://github.com/o/r/pull/1"},
        ]
    )
    out = await _fn("echo_attached")(ctx=ctx)
    assert "example.test/echo/1" in out
    assert "github.com" not in out


# --- the wiring ---------------------------------------------------------------------

async def test_the_provider_contributes_its_tool_server_through_the_transport():
    """collect_mcp_servers is what the broker core calls, so this is the real path from
    a contrib's factory to what the broker mounts."""
    collected = collect_mcp_servers([echo_contrib()])
    assert [p.name for p, _ in collected] == ["echo"]
    tools = await collected[0][1].list_tools(run_middleware=False)
    assert {t.name for t in tools} == {
        "echo_say",
        "echo_whoami",
        "echo_upstream",
        "echo_attached",
    }


async def test_every_tool_gets_a_schema_and_a_description_from_its_signature():
    """The payoff for the decorator form: no hand-written JSON Schema to drift. `ctx`
    is dependency-injected and must NOT appear as an argument the model can supply."""
    tools = await _declared()
    for name, tool in tools.items():
        assert tool.description, f"{name} has no description"
        schema = tool.parameters
        assert schema.get("type") == "object", f"{name} has a non-object input schema"
        assert "ctx" not in schema.get("properties", {}), f"{name} exposes ctx to the model"


async def test_echo_say_declares_its_typed_argument():
    tools = await _declared()
    props = tools["echo_say"].parameters["properties"]
    assert props["message"]["type"] == "string"



