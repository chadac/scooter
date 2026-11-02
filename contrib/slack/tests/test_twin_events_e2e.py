"""End-to-end: a single Slack mention dispatches to the agent exactly once.

Driven through the real webhooks app and its /webhooks/slack endpoint, which
discovers this contrib through the entry point, faking only the agent dispatch, the
Slack Web API helpers and the db. Slack delivers one mention as two events with
different event_ids but the same message `ts` (an `app_mention` and a `message`),
and the agent must be prompted exactly once whichever arrives first.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import webhooks.app
from scooter_contrib_slack.config import settings
from scooter_contrib_slack import webhooks_handler as slack_h

BOT = "UBOT"
CHANNEL = "C123"
TS = "1720368000.100200"          # the message ts the twin events share
RAW_TEXT = f"<@{BOT}> please review the PR"   # the raw form Slack sends


def _callback(event_type: str, event_id: str) -> dict:
    """A Slack Events API `event_callback` envelope for one twin event."""
    return {
        "type": "event_callback",
        "event_id": event_id,          # differs per twin
        "event": {
            "type": event_type,
            "user": "U1",
            "channel": CHANNEL,
            "text": RAW_TEXT,
            "ts": TS,                  # shared across the twins
            "thread_ts": TS,
        },
    }


from contextlib import contextmanager


@contextmanager
def _env(existing: str | None = None):
    """Drive the real app with a dispatch spy, yielding (client, dispatched); `existing` is the conversation already on the thread, if any."""
    dispatched: list[tuple] = []

    async def spy_send(conv, msg, *, priority=False, images=None, files=None, source=None, sender=None):
        dispatched.append(("send", conv, msg, priority))
        return True

    async def spy_create(message, *, title=None, on_created=None, owner=None, images=None, files=None, source=None, sender=None):
        dispatched.append(("create", message, title))
        # Exercise the real on_created hook as create_conversation does.
        if on_created is not None:
            await on_created("conv-new")
        return {"conversation_id": "conv-new", "result": "ok"}

    # The handler dispatches via asyncio.create_task, so the coroutine is driven to completion synchronously; all its awaits are on AsyncMocks.
    def run_now(coro):
        try:
            while True:
                coro.send(None)
        except StopIteration:
            pass
        return AsyncMock()  # a stand-in task object

    slack_h._SEEN_EVENT_IDS.clear()
    slack_h._DISPATCHED_MESSAGES.clear()

    with (
        # The trigger pattern is bound by the conftest.
        patch.object(settings, "slack_enabled", True),
        patch.object(slack_h, "_verify_slack_signature", return_value=True),
        patch("webhooks.app.db") as app_db,
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "send_message", side_effect=spy_send),
        patch.object(slack_h, "create_conversation", side_effect=spy_create),
        patch.object(slack_h, "resolve_owner", AsyncMock(return_value=None)),
        patch.object(slack_h, "add_slack_reaction", AsyncMock()),
        patch.object(slack_h, "push_link", AsyncMock()),
        patch.object(slack_h, "post_slack_message", AsyncMock()),
        patch.object(slack_h, "conversation_url", lambda cid: f"http://x/?thread={cid}"),
        patch.object(slack_h, "_clear_pending", AsyncMock()),
        patch.object(slack_h, "_get_bot_id", AsyncMock(return_value=BOT)),
        patch.object(slack_h, "_format_thread_history", AsyncMock(return_value="")),
        patch.object(slack_h.asyncio, "create_task", side_effect=run_now),
    ):
        app_db.init_db = AsyncMock()
        app_db.close_db = AsyncMock()
        db.lookup_conversation = AsyncMock(return_value=existing)
        db.get_conversation_for_resource = AsyncMock(return_value=existing)
        db.store_conversation = AsyncMock()
        db.store_slack_metadata = AsyncMock()
        db.store_pending_message = AsyncMock()
        with TestClient(webhooks.app.app) as c:
            yield c, dispatched


@pytest.fixture
def env():
    """New-conversation case: a mention creates the conversation."""
    with _env(existing=None) as e:
        yield e


@pytest.fixture
def env_existing():
    """Follow-up-mention case: a conversation already exists on the thread, so a mention forwards into it."""
    with _env(existing="conv-1") as e:
        yield e


def _post(client, envelope: dict):
    r = client.post("/webhooks/slack", json=envelope)
    assert r.status_code == 200, r.text
    return r


def test_twin_app_mention_then_message_dispatches_once(env):
    client, dispatched = env
    _post(client, _callback("app_mention", "ev_app"))
    _post(client, _callback("message", "ev_msg"))
    assert len(dispatched) == 1, dispatched


def test_twin_message_then_app_mention_dispatches_once(env):
    client, dispatched = env
    # The `message` twin arriving first must not pre-empt the app_mention's create.
    _post(client, _callback("message", "ev_msg"))
    _post(client, _callback("app_mention", "ev_app"))
    assert len(dispatched) == 1, dispatched
    assert dispatched[0][0] == "create", dispatched


def test_redelivered_app_mention_same_ts_dispatches_once(env):
    client, dispatched = env
    # A redelivery with a new event_id is caught by the ts-keyed dedup.
    _post(client, _callback("app_mention", "ev_app_1"))
    _post(client, _callback("app_mention", "ev_app_2"))
    assert len(dispatched) == 1, dispatched


def test_true_retry_same_event_id_dispatches_once(env):
    client, dispatched = env
    _post(client, _callback("app_mention", "ev_same"))
    _post(client, _callback("app_mention", "ev_same"))
    assert len(dispatched) == 1, dispatched


def test_two_DISTINCT_mentions_each_dispatch(env):
    client, dispatched = env
    # The dedup is per message, not per channel.
    _post(client, _callback("app_mention", "ev_a"))
    second = _callback("app_mention", "ev_b")
    second["event"]["ts"] = "1720368999.500000"
    second["event"]["thread_ts"] = "1720368999.500000"
    _post(client, second)
    assert len(dispatched) == 2, dispatched


# --- Follow-up mention into an existing conversation -----
# A mention forwards at priority into an active thread and the `message` twin must not also forward, in either order and even when Slack strips the mention from the twin's text.

def _message_stripped(event_id: str) -> dict:
    """A `message` twin whose text has no mention marker, which only the channel:ts dedup can catch."""
    cb = _callback("message", event_id)
    cb["event"]["text"] = "please review the PR"
    return cb


def test_existing_conv_app_mention_then_message_forwards_once(env_existing):
    client, dispatched = env_existing
    _post(client, _callback("app_mention", "ev_app"))
    _post(client, _message_stripped("ev_msg"))
    assert len(dispatched) == 1, dispatched
    assert dispatched[0][0] == "send" and dispatched[0][3] is True, dispatched


def test_existing_conv_message_FIRST_then_app_mention_forwards_once(env_existing):
    client, dispatched = env_existing
    # The stripped `message` twin forwards as awareness and records channel:ts, so the app_mention that follows is dropped.
    _post(client, _message_stripped("ev_msg"))
    _post(client, _callback("app_mention", "ev_app"))
    assert len(dispatched) == 1, dispatched


def test_existing_conv_plain_followup_still_forwards(env_existing):
    client, dispatched = env_existing
    msg = _callback("message", "ev_plain")
    msg["event"]["text"] = "here's an update, no action needed"
    msg["event"]["ts"] = "1720369100.700000"
    _post(client, msg)
    assert len(dispatched) == 1, dispatched
    assert dispatched[0][0] == "send" and dispatched[0][3] is True, dispatched
