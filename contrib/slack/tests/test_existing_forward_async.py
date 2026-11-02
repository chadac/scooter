"""A follow-up to an existing Slack conversation forwards off the request path.

send_message() blocks until the agent's whole turn finishes, and Slack retries a
webhook that does not answer within ~3s, so the handler must return before the
forward completes; these tests drive it with a send_message that blocks.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from scooter_contrib_slack import webhooks_handler as slack_h


async def _assert_nonblocking(handler_coro):
    """Run the handler with a send_message that blocks until released, asserting it returns promptly yet dispatched the forward."""
    started = asyncio.Event()
    release = asyncio.Event()

    async def blocking_send(conv_id, msg, *, priority=False, images=None, files=None, source=None, sender=None):
        started.set()
        await release.wait()
        return True

    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", side_effect=blocking_send) as sm,
        patch.object(slack_h, "add_slack_reaction", AsyncMock()),
        patch.object(slack_h, "_get_bot_id", AsyncMock(return_value="BOT")),
    ):
        db.lookup_conversation = AsyncMock(return_value="conv-existing")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-existing")

        await asyncio.wait_for(handler_coro, timeout=1.0)

        await asyncio.wait_for(started.wait(), timeout=1.0)
        assert not release.is_set()
        assert sm.call_args.args[0] == "conv-existing"

        release.set()
        await asyncio.sleep(0)


async def test_mention_on_existing_conversation_forwards_in_background():
    await _assert_nonblocking(
        slack_h._handle_mention(
            {"text": "<@BOT> ping", "user": "U1", "channel": "C1", "ts": "9.9", "thread_ts": "1.0"}
        )
    )


async def test_thread_message_on_existing_conversation_forwards_in_background():
    await _assert_nonblocking(
        slack_h._handle_thread_message(
            {"text": "just a follow-up", "user": "U1", "channel": "C1", "thread_ts": "1.0"}
        )
    )
