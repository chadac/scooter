"""END-TO-END: a single Slack @mention dispatches to the agent EXACTLY ONCE,
driven through the REAL /webhooks/slack HTTP endpoint — not the handlers in
isolation.

WHY e2e and not unit: the previous dedup (#83) passed its unit tests yet killed
Slack intake in prod, because the units mocked _handle_event / _handle_thread_message
in isolation and never exercised the real twin-event delivery through the endpoint
in BOTH arrival orders. These tests POST genuine Slack `event_callback` envelopes
to the actual FastAPI app and fake ONLY the true external boundaries (the agent
dispatch: send_message / create_conversation, the Slack Web API helpers, and db).

Slack delivers ONE @mention as TWO events with DIFFERENT event_ids but the SAME
message `ts`:
  • an `app_mention` event   (the mention owner)
  • a `message` event        (same text, raw `<@BOTID>` encoding)

The agent must be prompted exactly once, regardless of which arrives first.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import webhooks.app
from webhooks.config import settings
from webhooks.handlers import slack as slack_h

BOT = "UBOT"
CHANNEL = "C123"
TS = "1720368000.100200"          # the shared message ts of the twin events
RAW_TEXT = f"<@{BOT}> please review the PR"   # the RAW form Slack actually sends


def _callback(event_type: str, event_id: str) -> dict:
    """A Slack Events API `event_callback` envelope for one twin event."""
    return {
        "type": "event_callback",
        "event_id": event_id,          # DIFFERENT per twin (app_mention vs message)
        "event": {
            "type": event_type,
            "user": "U1",
            "channel": CHANNEL,
            "text": RAW_TEXT,
            "ts": TS,                  # SAME across the twins
            "thread_ts": TS,
        },
    }


from contextlib import contextmanager


@contextmanager
def _env(existing: str | None = None):
    """Drive the REAL app with a dispatch spy. `existing` = the conversation already
    on this thread (None -> a mention CREATES one; a value -> it FORWARDS into it,
    the follow-up-mention case). Yields (client, dispatched) where `dispatched`
    collects every real agent dispatch (send/create) — the 'was the agent prompted?'
    signal."""
    dispatched: list[tuple] = []

    async def spy_send(conv, msg, *, priority=False, images=None, files=None):
        dispatched.append(("send", conv, msg, priority))
        return True

    async def spy_create(message, *, title=None, on_created=None, owner=None, images=None, files=None):
        dispatched.append(("create", message, title))
        # Exercise the real on_created anchor-registration hook (pre-run), like
        # create_conversation does — so the test covers that path too.
        if on_created is not None:
            await on_created("conv-new")
        return {"conversation_id": "conv-new", "result": "ok"}

    # The handler dispatches via asyncio.create_task(coro) and returns without
    # awaiting it. Under the sync TestClient that task may not finish before .post()
    # returns, so we DRIVE the coro to completion synchronously right when it's
    # "scheduled" — all its awaits are on AsyncMocks (send_message / create_conversation
    # / db), which resolve immediately, so stepping the generator runs it to the end.
    # This keeps dispatch deterministic AND still exercises the real endpoint + real
    # _handle_event / _handle_mention / _handle_thread_message code paths.
    def run_now(coro):
        try:
            while True:
                coro.send(None)
        except StopIteration:
            pass
        return AsyncMock()  # a stand-in task object (never inspected)

    # Reset the module dedup state so tests don't leak into each other.
    slack_h._SEEN_EVENT_IDS.clear()
    slack_h._DISPATCHED_MESSAGES.clear()

    with (
        patch.object(settings, "slack_enabled", True),
        patch.object(settings, "slack_signing_secret", ""),   # bypass sig check
        patch.object(settings, "mention_pattern", "@scooter"),
        patch.object(settings, "ignore_usernames", ""),
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
        # existing=None -> mention CREATES a conversation; a value -> it FORWARDS
        # into that existing one (the follow-up-mention path).
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
    """Follow-up-mention case: a conversation already exists on the thread, so a
    mention FORWARDS into it (and the message twin must not double-forward)."""
    with _env(existing="conv-1") as e:
        yield e


def _post(client, envelope: dict):
    r = client.post("/webhooks/slack", json=envelope)
    assert r.status_code == 200, r.text
    return r


def test_twin_app_mention_then_message_dispatches_once(env):
    client, dispatched = env
    # app_mention arrives FIRST (the owner), then the message twin.
    _post(client, _callback("app_mention", "ev_app"))
    _post(client, _callback("message", "ev_msg"))
    assert len(dispatched) == 1, dispatched


def test_twin_message_then_app_mention_dispatches_once(env):
    client, dispatched = env
    # THE regression: the `message` twin arrives FIRST. It must NOT pre-empt the
    # real dispatch — the app_mention that follows must still create the
    # conversation. (#83 dropped it here → the mention was swallowed entirely.)
    _post(client, _callback("message", "ev_msg"))
    _post(client, _callback("app_mention", "ev_app"))
    assert len(dispatched) == 1, dispatched
    # And it was the CREATE (the real mention dispatch), not a plain forward.
    assert dispatched[0][0] == "create", dispatched


def test_redelivered_app_mention_same_ts_dispatches_once(env):
    client, dispatched = env
    # Slack redelivers the SAME app_mention with a NEW event_id (event_id dedup
    # misses it); the ts-keyed mention dedup must still catch it.
    _post(client, _callback("app_mention", "ev_app_1"))
    _post(client, _callback("app_mention", "ev_app_2"))
    assert len(dispatched) == 1, dispatched


def test_true_retry_same_event_id_dispatches_once(env):
    client, dispatched = env
    # A pure retry (identical event_id) is caught by the existing event_id dedup.
    _post(client, _callback("app_mention", "ev_same"))
    _post(client, _callback("app_mention", "ev_same"))
    assert len(dispatched) == 1, dispatched


def test_two_DISTINCT_mentions_each_dispatch(env):
    client, dispatched = env
    # Two genuinely different mentions in the SAME channel (different ts) must BOTH
    # dispatch — the dedup is per-message, not per-channel (the concern raised).
    _post(client, _callback("app_mention", "ev_a"))
    second = _callback("app_mention", "ev_b")
    second["event"]["ts"] = "1720368999.500000"
    second["event"]["thread_ts"] = "1720368999.500000"
    _post(client, second)
    assert len(dispatched) == 2, dispatched


# --- Follow-up mention into an EXISTING conversation (the reported duplicate) -----
# Here a mention forwards (priority) into an already-active thread, and the twin
# `message` event must NOT ALSO forward. Both orderings AND the case where Slack
# strips/rewrites the mention out of the `message` twin's text (so the text-skip
# can't catch it and the channel:ts backstop must).

def _message_stripped(event_id: str) -> dict:
    """A `message` twin whose text has NO mention marker (Slack sometimes delivers
    the thread message with the <@BOT> already resolved away). The text-skip can't
    catch this — only the channel:ts dedup can."""
    cb = _callback("message", event_id)
    cb["event"]["text"] = "please review the PR"   # mention stripped
    return cb


def test_existing_conv_app_mention_then_message_forwards_once(env_existing):
    client, dispatched = env_existing
    # app_mention forwards (priority) into the existing conv; the message twin (even
    # with the mention stripped) must NOT forward a 2nd copy.
    _post(client, _callback("app_mention", "ev_app"))
    _post(client, _message_stripped("ev_msg"))
    assert len(dispatched) == 1, dispatched
    assert dispatched[0][0] == "send" and dispatched[0][3] is True, dispatched  # priority forward


def test_existing_conv_message_FIRST_then_app_mention_forwards_once(env_existing):
    client, dispatched = env_existing
    # THE order you asked about: the regular `message` webhook arrives FIRST (mention
    # stripped, so the text-skip misses it) → it forwards as awareness AND records
    # channel:ts. The app_mention that follows must then be dropped by the ts guard
    # → still exactly ONE forward (no double dispatch).
    _post(client, _message_stripped("ev_msg"))
    _post(client, _callback("app_mention", "ev_app"))
    assert len(dispatched) == 1, dispatched


def test_existing_conv_plain_followup_still_forwards(env_existing):
    client, dispatched = env_existing
    # A genuine non-mention follow-up in the thread (distinct ts) still forwards for
    # awareness — the dedup must not suppress real thread activity.
    msg = _callback("message", "ev_plain")
    msg["event"]["text"] = "here's an update, no action needed"
    msg["event"]["ts"] = "1720369100.700000"
    _post(client, msg)
    assert len(dispatched) == 1, dispatched
    assert dispatched[0][0] == "send" and dispatched[0][3] is False, dispatched  # awareness (non-priority)
