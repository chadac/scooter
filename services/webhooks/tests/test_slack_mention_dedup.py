"""A @scooter message in an existing thread must forward EXACTLY ONCE, and keep
the @scooter reference readable.

Slack fires two events for one mention-in-thread: an `app_mention` AND a
`message`. Both used to forward → the agent got two copies (a generic "new
message" one + a "you were mentioned" one). Now _handle_thread_message skips a
mentioning message (the app_mention handler owns it), and _handle_mention rewrites
the bot's own <@U…> to "@scooter" instead of deleting it.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from webhooks.handlers import slack as slack_h


async def test_mentioning_thread_message_is_NOT_forwarded_by_the_message_handler():
    # The message-event path must SKIP a message that mentions @scooter — the
    # app_mention event handles it, so forwarding here would be the 2nd copy.
    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", new=AsyncMock(return_value=True)) as send,
        patch.object(slack_h, "_get_bot_id", new=AsyncMock(return_value="UBOT")),
        patch.object(slack_h, "settings") as st,
    ):
        st.mention_pattern = "@scooter"
        st.ignore_usernames = ""
        db.lookup_conversation = AsyncMock(return_value="conv-1")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-1")

        await slack_h._handle_thread_message({
            "type": "message", "thread_ts": "1.0", "channel": "C1", "user": "U1",
            "text": "@scooter please take another look",
        })
        send.assert_not_called()  # the message handler did NOT forward the mention


async def test_non_mention_thread_message_IS_forwarded_for_awareness():
    import asyncio

    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", new=AsyncMock(return_value=True)) as send,
        patch.object(slack_h, "_get_bot_id", new=AsyncMock(return_value="UBOT")),
        patch.object(slack_h, "settings") as st,
    ):
        st.mention_pattern = "@scooter"
        st.ignore_usernames = ""
        db.lookup_conversation = AsyncMock(return_value="conv-1")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-1")

        await slack_h._handle_thread_message({
            "type": "message", "thread_ts": "1.0", "channel": "C1", "user": "U1",
            "text": "just a heads up, no action needed",
        })
        # The forward is dispatched to a background task (so the webhook returns
        # fast); let it drain, then assert it forwarded exactly once.
        await asyncio.sleep(0)
        send.assert_awaited_once()  # a plain thread message still forwards (awareness)


async def test_mention_is_rewritten_to_readable_pattern_not_stripped():
    # "@scooter please review" must forward with "@scooter" intact, not "please review".
    import asyncio

    captured = {}
    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", new=AsyncMock(return_value=True)) as send,
        patch.object(slack_h, "_get_bot_id", new=AsyncMock(return_value="UBOT")),
        patch.object(slack_h, "add_slack_reaction", new=AsyncMock()),
        patch.object(slack_h, "settings") as st,
    ):
        st.mention_pattern = "@scooter"
        st.ignore_usernames = ""
        db.lookup_conversation = AsyncMock(return_value="conv-1")
        db.get_conversation_for_resource = AsyncMock(return_value="conv-1")

        async def rec_send(conv, msg, *, priority=False, images=None):
            captured["msg"] = msg
            captured["priority"] = priority
            return True
        send.side_effect = rec_send

        await slack_h._handle_mention({
            "type": "app_mention", "user": "U1", "channel": "C1", "ts": "1.0",
            "thread_ts": "1.0", "text": "<@UBOT> please review the PR",
        })
        # The forward now runs in a background task (so the webhook 200s fast); let
        # it drain, then assert the mention text was rewritten readably.
        await asyncio.sleep(0)
        assert "@scooter" in captured["msg"]
        assert "please review the PR" in captured["msg"]
        # An @mention to an ACTIVE conversation forwards as PRIORITY so the
        # agent-host can force-interrupt a stuck turn (the interrupt-queue feature).
        assert captured["priority"] is True
