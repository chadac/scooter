"""A Slack message's sender is home team + user id, leveled by users.info and never by name."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from scooter_contrib_slack import senders
from scooter_contrib_slack import webhooks_handler as slack_h
from scooter_webhooks_lib.sender import Level, Sender

WS = "T_OURS"


@pytest.mark.parametrize(
    ("info", "level"),
    [
        ({"team_id": WS}, Level.MEMBER),
        ({"team_id": WS, "is_restricted": True}, Level.GUEST),
        ({"team_id": WS, "is_ultra_restricted": True}, Level.GUEST),
        ({"team_id": "T_OTHER"}, Level.GUEST),
        ({"team_id": WS, "is_stranger": True}, Level.GUEST),
        ({"team_id": WS, "deleted": True}, Level.UNKNOWN),
        (None, Level.UNKNOWN),
    ],
)
def test_info_levels(info, level):
    assert senders.info_to_level(info, WS) is level


def test_no_workspace_is_unknown():
    assert senders.info_to_level({"team_id": WS}, "") is Level.UNKNOWN


@pytest.fixture(autouse=True)
def _fresh_cache():
    senders._user_cache.clear()
    yield
    senders._user_cache.clear()


@pytest.mark.asyncio
async def test_a_member_sender_is_keyed_by_team_and_user():
    info = {"team_id": WS, "name": "alice", "profile": {"display_name": "Alice"}}
    with patch.object(senders, "_user_info", AsyncMock(return_value=info)):
        s = await senders.sender_of({"user": "U1", "team": WS}, WS)
    assert s == Sender("slack", f"{WS}:U1", "alice", Level.MEMBER, display_name="Alice")


@pytest.mark.asyncio
async def test_a_slack_connect_user_is_keyed_by_their_home_team():
    info = {"team_id": "T_THEIRS", "name": "bob"}
    with patch.object(senders, "_user_info", AsyncMock(return_value=info)):
        s = await senders.sender_of({"user": "U2", "user_team": "T_THEIRS", "team": WS}, WS)
    assert s.external_id == "T_THEIRS:U2"
    assert s.level is Level.GUEST


@pytest.mark.asyncio
async def test_a_failed_lookup_still_names_the_sender_as_unknown():
    with patch.object(senders, "_user_info", AsyncMock(return_value=None)):
        s = await senders.sender_of({"user": "U3"}, WS)
    assert s == Sender("slack", f"{WS}:U3", "U3", Level.UNKNOWN)


@pytest.mark.asyncio
async def test_no_user_means_no_sender():
    assert await senders.sender_of({"team": WS}, WS) is None


@pytest.mark.asyncio
async def test_no_token_skips_the_lookup():
    with patch.object(senders.settings, "slack_bot_token", ""):
        assert await senders._user_info("U1") is None


@pytest.mark.asyncio
async def test_a_thread_reply_queued_before_its_conversation_keeps_its_sender():
    alice = Sender("slack", f"{WS}:U1", "alice", Level.MEMBER)
    store = AsyncMock()
    event = {"type": "message", "user": "U1", "text": "more", "channel": "C1", "ts": "2.0", "thread_ts": "1.0"}
    with patch.object(slack_h, "sender_of", AsyncMock(return_value=alice)) as lookup, \
         patch.object(slack_h, "_get_bot_id", AsyncMock(return_value="UBOT")), \
         patch.object(slack_h.db, "lookup_conversation", AsyncMock(return_value=slack_h.PENDING_CONVERSATION_ID)), \
         patch.object(slack_h.db, "store_pending_message", store):
        await slack_h._handle_event(event, workspace=WS)
    lookup.assert_awaited_once_with(event, WS)
    assert store.call_args.args[4] == alice
