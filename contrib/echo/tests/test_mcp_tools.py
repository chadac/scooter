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

from scooter_broker_lib.mcp import ToolContext, collect_mcp_tools
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_echo.broker_provider import echo_contrib
from scooter_contrib_echo.mcp_tools import echo_mcp_tools


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


def _tool(name: str):
    return next(t for t in echo_mcp_tools() if t.name == name)


# --- echo_say: the minimum shape --------------------------------------------------

async def test_say_echoes_the_message():
    res = await _tool("echo_say").handler(_ctx(), {"message": "hello"})
    assert res.text == "echo: hello"
    assert res.is_error is False


@pytest.mark.parametrize("args", [{}, {"message": ""}, {"message": "   "}])
async def test_say_rejects_a_missing_message(args):
    """Validation is the TOOL'S job: the input schema tells the model what to send, but
    nothing enforces it, so a required field arrives as an absent key."""
    res = await _tool("echo_say").handler(_ctx(), args)
    assert res.is_error is True


# --- echo_whoami: the verified caller ----------------------------------------------

async def test_whoami_reports_the_verified_conversation():
    res = await _tool("echo_whoami").handler(_ctx(conversation_id="conv-42"), {})
    assert "conversation: conv-42" in res.text


async def test_whoami_says_the_owner_is_unknown_rather_than_guessing():
    """A sandbox SA name carries no owner, so the tool must not invent one."""
    res = await _tool("echo_whoami").handler(_ctx(owner=None), {})
    assert "unknown" in res.text


async def test_whoami_reports_an_owner_from_the_conversation_token():
    res = await _tool("echo_whoami").handler(_ctx(owner="alice@example.com"), {})
    assert "owner: alice@example.com" in res.text


# --- echo_upstream: credential injection + never hiding an error -------------------

@pytest.mark.parametrize("given", ["/get", "get", "  /get  "])
async def test_upstream_normalizes_the_path_the_agent_passes(given):
    """A leading slash is optional and whitespace is tolerated: a model will produce
    both forms, and `ctx.upstream` joins against the provider's base either way."""
    ctx = _ctx()
    res = await _tool("echo_upstream").handler(ctx, {"path": given})
    assert res.is_error is False
    assert ctx.upstream.calls == [("GET", "get")]  # type: ignore[attr-defined]


async def test_upstream_requires_a_path():
    res = await _tool("echo_upstream").handler(_ctx(), {})
    assert res.is_error is True


async def test_upstream_surfaces_a_failure_VERBATIM():
    """The load-bearing rule. The agent must see the real status and body — a hidden
    error gets retried, which for a reply-shaped tool means posting twice."""
    ctx = _ctx(response=httpx.Response(503, text="upstream exploded"))
    res = await _tool("echo_upstream").handler(ctx, {"path": "/get"})
    assert res.is_error is True
    assert "503" in res.text
    assert "upstream exploded" in res.text


async def test_upstream_treats_a_200_with_ok_false_as_a_FAILURE():
    """Slack's shape: HTTP 200 carrying a logical failure. Without ok_field_check a
    failed post reads as a success."""
    ctx = _ctx(response=httpx.Response(200, json={"ok": False, "error": "channel_not_found"}))
    res = await _tool("echo_upstream").handler(ctx, {"path": "/post"})
    assert res.is_error is True
    assert "channel_not_found" in res.text


async def test_upstream_treats_an_IDEMPOTENT_error_as_success():
    """"The desired state already exists" is success. Slack's `already_reacted` is the
    real case — the webhooks handler posts a 👀 before dispatch, so the agent's own
    ack-react always failed until these counted as done."""
    ctx = _ctx(response=httpx.Response(200, json={"ok": False, "error": "already_done"}))
    res = await _tool("echo_upstream").handler(ctx, {"path": "/post"})
    assert res.is_error is False
    assert "already done" in res.text


# --- echo_attached: the attachment gate -------------------------------------------

async def test_the_gate_is_CLOSED_with_no_echo_link():
    assert await _tool("echo_attached").gate(_ctx(links=[])) is False


async def test_the_gate_ignores_another_provider_s_links():
    """The failure this prevents: offering echo's reply tool on a conversation that is
    only attached to GitHub."""
    ctx = _ctx(links=[{"source": "github", "url": "https://github.com/o/r/pull/1"}])
    assert await _tool("echo_attached").gate(ctx) is False


async def test_the_gate_OPENS_with_an_echo_link():
    ctx = _ctx(links=[{"source": "echo", "url": "https://example.test/echo/1"}])
    assert await _tool("echo_attached").gate(ctx) is True


async def test_attached_lists_only_echo_links():
    ctx = _ctx(
        links=[
            {"source": "echo", "url": "https://example.test/echo/1"},
            {"source": "github", "url": "https://github.com/o/r/pull/1"},
        ]
    )
    res = await _tool("echo_attached").handler(ctx, {})
    assert "example.test/echo/1" in res.text
    assert "github.com" not in res.text


# --- the wiring ---------------------------------------------------------------------

async def test_the_provider_contributes_its_tools_through_the_transport():
    """collect_mcp_tools is what the broker core calls, so this is the real path from
    a contrib's factory to the agent's tool list."""
    collected = collect_mcp_tools([echo_contrib()])
    assert {t.name for _, t in collected} == {
        "echo_say",
        "echo_whoami",
        "echo_upstream",
        "echo_attached",
    }
    assert all(p.name == "echo" for p, _ in collected)


async def test_every_tool_declares_an_object_input_schema():
    """An inputSchema that is not an object type is rejected by strict clients, and a
    tool with no schema at all is one the model cannot call correctly."""
    for tool in echo_mcp_tools():
        assert tool.input_schema.get("type") == "object"
        assert tool.description
