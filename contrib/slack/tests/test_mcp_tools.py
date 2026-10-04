"""Slack's agent tools (issue #700).

Ported from services/agent-host/test/contract/agentTools.spec.ts along with the code.
The assertions that matter are the ones protecting against specific past incidents:

  * the gate is CLOSED with no Slack link — an ungated reply tool is what sent the
    agent raw-curling Slack into the root channel;
  * a Slack 200-with-`{"ok": false}` is a FAILURE, not a success;
  * `already_reacted` is SUCCESS, because the webhooks handler's pre-dispatch 👀 makes
    the agent's own ack-react hit it constantly;
  * the OLDEST slack link wins, so a conversation started from one thread keeps
    replying there.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from scooter_broker_lib.mcp import ToolContext, gate_for
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_slack import mcp_tools as slack_tools


@dataclass
class FakeUpstream:
    response: httpx.Response
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        self.calls.append({"method": method, "path": path, **kw})
        return self.response


@dataclass
class FakeLinks:
    rows: list[dict[str, Any]]

    async def list(self) -> list[dict[str, Any]]:
        return self.rows


def _ctx(*, links: list[dict] | None = None, response: httpx.Response | None = None) -> ToolContext:
    return ToolContext(
        identity=Identity(
            conversation_id="conv-1",
            namespace="agent-sandbox",
            service_account="system:serviceaccount:agent-sandbox:agent-host",
        ),
        provider=Provider(name="slack", transports=[]),
        upstream=FakeUpstream(response or httpx.Response(200, json={"ok": True})),
        links=FakeLinks(links or []),
    )


def _link(channel: str | None = "C123", thread: str | None = "1700.5", **over) -> dict:
    ref: dict[str, Any] = {}
    if channel:
        ref["channel"] = channel
    if thread:
        ref["threadTs"] = thread
    return {"source": "slack", "resourceType": "thread", "url": "", "ref": ref, **over}


def _fn(name: str):
    return getattr(slack_tools, name)


# --- the attachment gate ----------------------------------------------------------

async def test_the_gate_is_CLOSED_with_no_links():
    for name in ("slack_respond", "slack_react", "get_slack_context"):
        assert await gate_for(name)(_ctx()) is False, name


async def test_the_gate_is_CLOSED_when_only_another_provider_is_attached():
    """The incident this prevents: a GitHub-only conversation being offered Slack's
    reply tool, firing it, and posting to whatever channel it could find."""
    ctx = _ctx(links=[{"source": "github", "resourceType": "pr", "url": "https://github.com/o/r/pull/1", "ref": {}}])
    assert await gate_for("slack_respond")(ctx) is False


async def test_the_gate_is_CLOSED_for_a_slack_link_with_no_channel():
    """A link with a ref but no channel resolves to no target, so the tool must not be
    offered — it could not act even if it fired."""
    assert await gate_for("slack_respond")(_ctx(links=[_link(channel=None)])) is False


async def test_the_gate_OPENS_with_a_slack_link():
    assert await gate_for("slack_respond")(_ctx(links=[_link()])) is True


async def test_a_channel_with_no_thread_is_a_COMPLETE_target():
    """Posting without a thread_ts is a channel message, which is right for a
    conversation attached to a channel rather than a thread."""
    assert await gate_for("slack_respond")(_ctx(links=[_link(thread=None)])) is True


# --- target resolution ------------------------------------------------------------

async def test_the_OLDEST_slack_link_wins():
    """listLinks orders by insert id, so the thread the conversation STARTED from wins
    over one attached later."""
    ctx = _ctx(links=[_link(channel="C-first"), _link(channel="C-second")])
    target = await slack_tools.slack_target(ctx)
    assert target["channel"] == "C-first"


async def test_a_link_with_no_channel_is_SKIPPED_not_fatal():
    """Completeness is per link: an incomplete one is passed over, and fields are never
    mixed with the next link's."""
    ctx = _ctx(links=[_link(channel=None, thread="9999.9"), _link(channel="C-real", thread="1700.5")])
    target = await slack_tools.slack_target(ctx)
    assert target == {"channel": "C-real", "thread_ts": "1700.5"}


async def test_snake_case_thread_ts_is_also_accepted():
    """Writers disagree on the spelling, and a dropped thread_ts silently posts to the
    channel instead of the thread."""
    ctx = _ctx(links=[{"source": "slack", "resourceType": "thread", "url": "", "ref": {"channel": "C1", "thread_ts": "1700.5"}}])
    assert (await slack_tools.slack_target(ctx))["thread_ts"] == "1700.5"


# --- slack_respond ----------------------------------------------------------------

async def test_respond_posts_to_the_inferred_channel_and_thread():
    ctx = _ctx(links=[_link()])
    res = await _fn("slack_respond")(text="hello", ctx=ctx)
    assert res.is_error is False
    call = ctx.upstream.calls[0]
    assert call["path"] == "chat.postMessage"
    assert call["json"] == {"channel": "C123", "text": "hello", "thread_ts": "1700.5"}


async def test_respond_omits_thread_ts_when_the_link_has_none():
    ctx = _ctx(links=[_link(thread=None)])
    await _fn("slack_respond")(text="hi", ctx=ctx)
    assert "thread_ts" not in ctx.upstream.calls[0]["json"]


async def test_respond_lets_an_explicit_thread_ts_override():
    ctx = _ctx(links=[_link()])
    await _fn("slack_respond")(text="hi", thread_ts="1800.1", ctx=ctx)
    assert ctx.upstream.calls[0]["json"]["thread_ts"] == "1800.1"


async def test_respond_treats_a_200_with_ok_false_as_a_FAILURE():
    """Slack reports logical failure with HTTP 200. Without this check a message that
    never posted reads as success — and the agent moves on believing it replied."""
    ctx = _ctx(links=[_link()], response=httpx.Response(200, json={"ok": False, "error": "channel_not_found"}))
    res = await _fn("slack_respond")(text="hi", ctx=ctx)
    assert res.is_error is True
    assert "channel_not_found" in res.text


async def test_respond_surfaces_a_transport_failure_VERBATIM():
    ctx = _ctx(links=[_link()], response=httpx.Response(500, text="slack exploded"))
    res = await _fn("slack_respond")(text="hi", ctx=ctx)
    assert res.is_error is True
    assert "500" in res.text and "slack exploded" in res.text


# --- slack_react ------------------------------------------------------------------

async def test_react_strips_colons_from_the_emoji_name():
    """reactions.add wants the bare name; a model will often send `:eyes:`."""
    ctx = _ctx(links=[_link()])
    await _fn("slack_react")(emoji=":eyes:", message_ts="1700.9", ctx=ctx)
    assert ctx.upstream.calls[0]["json"]["name"] == "eyes"


async def test_react_targets_the_GIVEN_message_not_the_thread_anchor():
    """The point of requiring message_ts: a 👀 must land on the message being
    acknowledged, not on the thread root."""
    ctx = _ctx(links=[_link(thread="1700.5")])
    await _fn("slack_react")(emoji="eyes", message_ts="1800.7", ctx=ctx)
    assert ctx.upstream.calls[0]["json"]["timestamp"] == "1800.7"


@pytest.mark.parametrize("ts", ["", "   "])
async def test_react_requires_a_message_ts(ts):
    res = await _fn("slack_react")(emoji="eyes", message_ts=ts, ctx=_ctx(links=[_link()]))
    assert res.is_error is True
    assert "message_ts" in res.text


async def test_react_treats_already_reacted_as_SUCCESS():
    """The webhooks handler adds 👀 before dispatch, so the agent's own ack-react hits
    this constantly. Reporting it as an error wasted a turn every time."""
    ctx = _ctx(links=[_link()], response=httpx.Response(200, json={"ok": False, "error": "already_reacted"}))
    res = await _fn("slack_react")(emoji="eyes", message_ts="1700.9", ctx=ctx)
    assert res.is_error is False
    assert "already done" in res.text


async def test_react_still_fails_on_a_REAL_slack_error():
    ctx = _ctx(links=[_link()], response=httpx.Response(200, json={"ok": False, "error": "invalid_name"}))
    res = await _fn("slack_react")(emoji="nope", message_ts="1700.9", ctx=ctx)
    assert res.is_error is True
    assert "invalid_name" in res.text


# --- get_slack_context ------------------------------------------------------------

async def test_context_reports_the_channel_and_thread():
    res = await _fn("get_slack_context")(ctx=_ctx(links=[_link()]))
    assert "channel: C123" in res.text
    assert "thread_ts: 1700.5" in res.text


async def test_context_omits_the_thread_when_there_is_none():
    res = await _fn("get_slack_context")(ctx=_ctx(links=[_link(thread=None)]))
    assert "channel: C123" in res.text
    assert "thread_ts" not in res.text


# --- the wiring -------------------------------------------------------------------

async def test_the_provider_contributes_the_three_tools():
    from scooter_contrib_slack.broker_provider import slack

    # The factory is enabled only with a token configured; the tool server is built
    # regardless, so assert on the server rather than the provider's `enabled`.
    tools = await slack_tools.mcp.list_tools(run_middleware=False)
    assert {t.name for t in tools} == {"slack_respond", "slack_react", "get_slack_context"}
    assert slack is not None


async def test_no_tool_exposes_ctx_to_the_model():
    for tool in await slack_tools.mcp.list_tools(run_middleware=False):
        assert "ctx" not in tool.parameters.get("properties", {}), tool.name
