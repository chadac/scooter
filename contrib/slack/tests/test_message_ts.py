"""A forwarded Slack message carries a `message_ts: <ts>` line so the agent can react to that specific message."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from scooter_contrib_slack import webhooks_handler as slack_h


async def _capture_forward(handler_coro) -> dict:
    """Drive the handler with a send_message that records what it forwarded (text and priority)."""
    seen: dict = {}
    started = asyncio.Event()

    async def capturing_send(conv_id, msg, *, priority=False, images=None, files=None, source=None, sender=None):
        seen["msg"], seen["priority"] = msg, priority
        started.set()
        return True

    # The channel:ts dispatch guard is module-level state, so clear it to stay order-independent.
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
        await asyncio.sleep(0)
    return seen


async def test_mention_forward_includes_message_ts():
    msg = await _capture_forward(
        slack_h._handle_mention(
            {"text": "<@BOT> ping", "user": "U1", "channel": "Cmts1", "ts": "9001.9", "thread_ts": "9000.1"}
        )
    )
    assert "message_ts: 9001.9" in msg["msg"]


async def test_thread_message_forward_includes_message_ts():
    msg = await _capture_forward(
        slack_h._handle_thread_message(
            {"text": "just a follow-up", "user": "U1", "channel": "Cmts2", "ts": "9002.7", "thread_ts": "9000.1"}
        )
    )
    assert "message_ts: 9002.7" in msg["msg"]


async def test_thread_message_without_mention_interrupts():
    # Queued until the run ends, unmentioned replies would land out of order with the thread.
    seen = await _capture_forward(
        slack_h._handle_thread_message(
            {"text": "side chatter", "user": "U1", "channel": "Cmts3", "ts": "9003.1", "thread_ts": "9000.1"}
        )
    )
    assert seen["priority"] is True
