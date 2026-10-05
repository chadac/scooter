"""Slack's AGENT TOOLS — reply in the thread, react to a message, read the context.

Moved here from the agent-host (services/agent-host/src/agent/agentTools.ts) by issue
#700. They were hardcoded there, so enabling or disabling `contrib/slack` did nothing
to the agent's tool surface — and the broker, which actually holds the Slack token,
never learned which conversation a tool call was for, so a resource the agent created
through a tool was never auto-linked.

WHY THESE EXIST AT ALL, kept from the original: the agent used to hand-run
`curl -sf $BROKER_URL/slack/chat.postMessage` from the sandbox, which fails SILENTLY
on error — so the agent retried and posted DUPLICATE messages — and cannot see Slack's
`{"ok": false}`, which arrives with HTTP 200. These are thin typed wrappers over the
same call with two guarantees: the channel and thread are inferred, and errors are
never hidden.

ALL THREE ARE ATTACHMENT-GATED. An ungated reply tool is what led the agent to
raw-curl Slack into the ROOT CHANNEL — visible to everyone instead of the thread. A
conversation with no Slack thread does not see these tools at all.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.links import first_target, ref_of
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate

mcp = FastMCP(name="slack")

SOURCE = "slack"


def _target_from_link(link: dict) -> dict | None:
    """The channel (and thread, when known) a Slack link points at.

    A Slack id has ONE spelling — `channel:thread_ts` — and no URL form a webhook ever
    arrives as (contrib/slack/resources.py), so the `ref` is the only source here.
    The channel alone is a complete target: a thread_ts is optional, and posting
    without one is a channel message, which is what a conversation attached to a
    channel rather than a thread should do.
    """
    ref = ref_of(link)
    channel = ref.get("channel")
    if not channel:
        return None
    return {"channel": channel, "thread_ts": ref.get("threadTs") or ref.get("thread_ts")}


async def slack_target(ctx: ToolContext) -> dict | None:
    """The Slack thread this conversation is attached to, or None.

    THE single source of truth for "is Slack attached, and what does it point at?" —
    used by both the gate and the handlers, so a tool is offered iff its handler could
    actually resolve a target.
    """
    return first_target(await ctx.links.list(), SOURCE, _target_from_link)


async def _slack_attached(ctx: ToolContext) -> bool:
    return await slack_target(ctx) is not None


@gate(_slack_attached)
@mcp.tool
async def slack_respond(
    text: str,
    thread_ts: str | None = None,
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Post a message to THIS conversation's Slack thread.

    The channel and thread are already known — you only provide the text. Use this to
    acknowledge and to reply; it reports the real result (a Slack error is returned to
    you — do NOT retry blindly). Prefer this over a raw curl. Pass `thread_ts` only to
    override the thread, which is rarely needed.
    """
    target = await slack_target(ctx)
    if target is None:
        # Unreachable while the gate holds, but stay honest rather than post somewhere.
        return ToolResult.error("This conversation isn't attached to a Slack thread.")
    ts = thread_ts or target.get("thread_ts")
    response = await ctx.upstream.request(
        "POST",
        "chat.postMessage",
        json={"channel": target["channel"], "text": text, **({"thread_ts": ts} if ts else {})},
    )
    return ToolResult.from_upstream(
        response,
        success_text="Posted to the Slack thread.",
        # Slack answers HTTP 200 with {"ok": false} on logical failure, so without this
        # a message that never posted reads as success.
        ok_field_check=True,
    )


@gate(_slack_attached)
@mcp.tool
async def slack_react(emoji: str, message_ts: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Add an emoji reaction to a specific Slack message in THIS conversation's thread.

    The channel is already known. You MUST pass `message_ts` — the timestamp of the
    message you're reacting to, shown in the Slack notification as "message_ts: …".
    This reacts to THAT message (e.g. the one you were asked to acknowledge), not the
    thread anchor. Give the emoji `name` WITHOUT colons (e.g. "eyes",
    "white_check_mark", "tada"). Nice for a quick 👀 acknowledgment or a ✅ when done —
    but don't spam reactions.
    """
    target = await slack_target(ctx)
    if target is None:
        return ToolResult.error("This conversation isn't attached to a Slack thread.")
    ts = (message_ts or "").strip()
    if not ts:
        return ToolResult.error(
            "slack_react needs the `message_ts` of the message to react to — the "
            'timestamp shown in the Slack notification as "message_ts: …".'
        )
    # reactions.add wants the name WITHOUT the surrounding colons.
    name = emoji.replace(":", "").strip()
    response = await ctx.upstream.request(
        "POST", "reactions.add", json={"channel": target["channel"], "timestamp": ts, "name": name}
    )
    return ToolResult.from_upstream(
        response,
        success_text=f"Reacted with :{name}:.",
        ok_field_check=True,
        # `already_reacted` means the emoji is already there, so the goal is met. The
        # webhooks handler adds 👀 before dispatch, so the agent's own ack-react hits
        # this constantly; reporting it as an error wasted a turn every time.
        idempotent_errors=("already_reacted",),
    )


@gate(_slack_attached)
@mcp.tool
async def get_slack_context(ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Report the Slack channel id + thread_ts THIS conversation is attached to.

    Use it when you need the raw ids (e.g. to build a permalink via the broker, or to
    pass thread_ts explicitly) — slack_respond and slack_react already infer these, so
    you rarely need this just to reply.
    """
    target = await slack_target(ctx)
    if target is None:
        return ToolResult.error("This conversation isn't attached to a Slack thread.")
    lines = [f"channel: {target['channel']}"]
    if target.get("thread_ts"):
        lines.append(f"thread_ts: {target['thread_ts']}")
    return ToolResult.ok("\n".join(lines))


def slack_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
