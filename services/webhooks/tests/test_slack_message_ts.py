"""The forwarded Slack message must surface the message `ts` so the agent can
react to THE SPECIFIC message via slack_react (message_ts is a required arg).

Before this, the agent only ever saw the thread anchor, so slack_react could only
land a reaction on the thread root — never the actual message it was acknowledging.
Now each forwarded message carries a `message_ts: <ts>` line the agent passes on.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from webhooks.handlers import slack as slack_h


async def _capture_forward(handler_coro) -> str:
    """Drive the handler with a send_message that records its forwarded text, then
    return that text once the background forward has run."""
    seen: dict[str, str] = {}
    started = asyncio.Event()

    async def capturing_send(conv_id, msg, *, priority=False, images=None, files=None, source=None):
        seen["msg"] = msg
        started.set()
        return True

    # The (channel:ts) dispatch guard is MODULE-level state that persists across
    # tests; another test forwarding the same (channel, ts) first would make the
    # handler skip ours as an already-dispatched twin (→ send_message never runs →
    # this hangs). Clear it so this test is order-independent.
    slack_h._DISPATCHED_MESSAGES.clear()

    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", side_effect=capturing_send),
        patch.object(slack_h, "add_slack_reaction", AsyncMock()),
        patch.object(slack_h, "_get_bot_id", AsyncMock(return_value="BOT")),
    ):
        db.lookup_conversation = AsyncMock(return_value="conv-existing")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-existing")

        await asyncio.wait_for(handler_coro, timeout=1.0)
        await asyncio.wait_for(started.wait(), timeout=1.0)
        await asyncio.sleep(0)  # let the background task drain
    return seen["msg"]


async def test_mention_forward_includes_message_ts():
    msg = await _capture_forward(
        slack_h._handle_mention(
            {"text": "<@BOT> ping", "user": "U1", "channel": "Cmts1", "ts": "9001.9", "thread_ts": "9000.1"}
        )
    )
    assert "message_ts: 9001.9" in msg


async def test_thread_message_forward_includes_message_ts():
    msg = await _capture_forward(
        slack_h._handle_thread_message(
            {"text": "just a follow-up", "user": "U1", "channel": "Cmts2", "ts": "9002.7", "thread_ts": "9000.1"}
        )
    )
    assert "message_ts: 9002.7" in msg
