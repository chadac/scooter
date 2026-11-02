"""A mention in an existing thread forwards exactly once and keeps the mention readable.

Slack fires an `app_mention` and a `message` event for one mention-in-thread;
_handle_thread_message skips the mentioning message and _handle_mention rewrites
the bot's own <@U…> to the trigger pattern, which the conftest binds.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from scooter_contrib_slack import webhooks_handler as slack_h


async def test_mentioning_thread_message_is_NOT_forwarded_by_the_message_handler():
    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", new=AsyncMock(return_value=True)) as send,
        patch.object(slack_h, "_get_bot_id", new=AsyncMock(return_value="UBOT")),
    ):
        db.lookup_conversation = AsyncMock(return_value="conv-1")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-1")

        await slack_h._handle_thread_message({
            "type": "message", "thread_ts": "1.0", "channel": "C1", "user": "U1",
            "text": "@scooter please take another look",
        })
        send.assert_not_called()


async def test_non_mention_thread_message_IS_forwarded_for_awareness():
    import asyncio

    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", new=AsyncMock(return_value=True)) as send,
        patch.object(slack_h, "_get_bot_id", new=AsyncMock(return_value="UBOT")),
    ):
        db.lookup_conversation = AsyncMock(return_value="conv-1")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-1")

        await slack_h._handle_thread_message({
            "type": "message", "thread_ts": "1.0", "channel": "C1", "user": "U1",
            "text": "just a heads up, no action needed",
        })
        # Let the background forward task drain.
        await asyncio.sleep(0)
        send.assert_awaited_once()


async def test_mention_is_rewritten_to_readable_pattern_not_stripped():
    import asyncio

    captured = {}
    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", new=AsyncMock(return_value=True)) as send,
        patch.object(slack_h, "_get_bot_id", new=AsyncMock(return_value="UBOT")),
        patch.object(slack_h, "add_slack_reaction", new=AsyncMock()),
    ):
        db.lookup_conversation = AsyncMock(return_value="conv-1")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-1")

        async def rec_send(conv, msg, *, priority=False, images=None, files=None, source=None, sender=None):
            captured["msg"] = msg
            captured["priority"] = priority
            return True
        send.side_effect = rec_send

        await slack_h._handle_mention({
            "type": "app_mention", "user": "U1", "channel": "C1", "ts": "1.0",
            "thread_ts": "1.0", "text": "<@UBOT> please review the PR",
        })
        # Let the background forward task drain.
        await asyncio.sleep(0)
        assert "@scooter" in captured["msg"]
        assert "please review the PR" in captured["msg"]
        # A mention to an active conversation forwards as priority.
        assert captured["priority"] is True
