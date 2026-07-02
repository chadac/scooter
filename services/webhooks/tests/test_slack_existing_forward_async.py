"""A follow-up to an EXISTING Slack conversation must forward OFF the request path.

send_message() blocks until the agent's whole turn finishes (the /agui SSE runs to
RUN_FINISHED — minutes). If the Slack handler AWAITS it inline, the webhook can't
200 within Slack's ~3s window, so Slack retries — and every retry is dropped as an
already-handled duplicate. The channel looks dead ("everything classified as a
duplicate on existing conversations"). So the handler must background the forward
and return immediately; the reply still streams into the thread via slack_respond.

These tests drive the real handler with a send_message that BLOCKS, and assert the
handler returns BEFORE send_message completes (i.e. it was NOT awaited inline).
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from webhooks.handlers import slack as slack_h


async def _assert_nonblocking(handler_coro):
    """Run the handler with a send_message that blocks until released; assert the
    handler returns promptly (didn't await the block) yet DID dispatch the forward."""
    started = asyncio.Event()
    release = asyncio.Event()

    async def blocking_send(conv_id, msg):
        started.set()
        await release.wait()  # the whole-turn block
        return True

    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", side_effect=blocking_send) as sm,
        patch.object(slack_h, "add_slack_reaction", AsyncMock()),
        patch.object(slack_h, "_get_bot_id", AsyncMock(return_value="BOT")),
    ):
        db.lookup_conversation = AsyncMock(return_value="conv-existing")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-existing")

        # The handler must return promptly even though send_message blocks forever.
        await asyncio.wait_for(handler_coro, timeout=1.0)

        # The forward WAS dispatched (a background task entered send_message)...
        await asyncio.wait_for(started.wait(), timeout=1.0)
        # ...but the handler returned WITHOUT it completing (still blocked).
        assert not release.is_set()
        assert sm.call_args.args[0] == "conv-existing"

        release.set()
        await asyncio.sleep(0)  # let the background task drain


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
