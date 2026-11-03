"""Slack's agent tools: reply in the thread, react to a message, read the context.

Thin typed wrappers over the broker's Slack calls with two guarantees: the channel
and thread are inferred from the conversation's links, and errors (including Slack's
`{"ok": false}` on HTTP 200) are never hidden. All three are attachment-gated, so a
conversation with no Slack thread does not see them.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.links import first_target, ref_of
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate

mcp = FastMCP(name="slack")

SOURCE = "slack"


def target_from_link(link: dict) -> dict | None:
    """The channel (and thread, when known) a Slack link's `ref` points at; the channel alone is a complete target."""
    ref = ref_of(link)
    channel = ref.get("channel")
    if not channel:
        return None
    return {"channel": channel, "thread_ts": ref.get("threadTs") or ref.get("thread_ts")}


async def slack_target(ctx: ToolContext) -> dict | None:
    """The Slack thread this conversation is attached to, or None; shared by the gate and the handlers."""
    return first_target(await ctx.links.list(), SOURCE, target_from_link)


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
        # Slack answers HTTP 200 with {"ok": false} on logical failure.
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
    # reactions.add wants the name without the surrounding colons.
    name = emoji.replace(":", "").strip()
    response = await ctx.upstream.request(
        "POST", "reactions.add", json={"channel": target["channel"], "timestamp": ts, "name": name}
    )
    return ToolResult.from_upstream(
        response,
        success_text=f"Reacted with :{name}:.",
        ok_field_check=True,
        # `already_reacted` means the emoji is already there, so the goal is met.
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
