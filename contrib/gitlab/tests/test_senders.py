"""A GitLab message's sender is the numeric user id, leveled by project membership and never by username."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from scooter_contrib_gitlab import senders
from scooter_contrib_gitlab import webhooks_handler as gitlab_h
from scooter_webhooks_lib.sender import Level, Sender


@pytest.mark.parametrize(
    ("access", "level"),
    [(50, Level.MEMBER), (30, Level.MEMBER), (20, Level.CONTRIBUTOR), (10, Level.CONTRIBUTOR), (0, Level.GUEST), (None, Level.UNKNOWN)],
)
def test_access_levels(access, level):
    assert senders.access_to_level(access) is level


def _client(response: httpx.Response | Exception):
    """An httpx.AsyncClient stand-in answering every GET with `response`."""

    class Fake:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, **k):
            if isinstance(response, Exception):
                raise response
            return httpx.Response(response.status_code, json=response.json(), request=httpx.Request("GET", url))

    return Fake


@pytest.fixture(autouse=True)
def _fresh_cache():
    senders._access_cache.clear()
    with patch.object(senders.settings, "gitlab_token", "tok"):
        yield
    senders._access_cache.clear()


@pytest.mark.asyncio
async def test_a_member_lookup_reads_access_level():
    with patch.object(senders.httpx, "AsyncClient", _client(httpx.Response(200, json={"access_level": 40}))):
        assert await senders.project_access_level(7, 101) == 40


@pytest.mark.asyncio
async def test_a_404_is_a_non_member_and_a_failure_is_unknown():
    with patch.object(senders.httpx, "AsyncClient", _client(httpx.Response(404, json={}))):
        assert await senders.project_access_level(7, 101) == 0
    with patch.object(senders.httpx, "AsyncClient", _client(httpx.ConnectError("down"))):
        assert await senders.project_access_level(7, 202) is None
    # A failure isn't cached, so the next message retries.
    assert (7, 202) not in senders._access_cache


@pytest.mark.asyncio
async def test_no_token_is_unknown():
    with patch.object(senders.settings, "gitlab_token", ""):
        assert await senders.project_access_level(7, 101) is None


@pytest.mark.asyncio
async def test_the_sender_is_the_numeric_id_with_its_membership():
    payload = {"user": {"id": 101, "username": "alice", "name": "Alice A"}, "project": {"id": 7}}
    with patch.object(senders, "project_access_level", AsyncMock(return_value=30)) as lookup:
        s = await senders.sender_of(payload)
    lookup.assert_awaited_once_with(7, 101)
    assert s == Sender("gitlab", "101", "alice", Level.MEMBER, display_name="Alice A")


@pytest.mark.asyncio
@pytest.mark.parametrize("user", [{"username": "alice"}, {"id": "101"}, {}])
async def test_no_numeric_id_means_no_sender(user):
    assert await senders.sender_of({"user": user, "project": {"id": 7}}) is None


@pytest.mark.asyncio
async def test_no_project_means_unknown():
    s = await senders.sender_of({"user": {"id": 101, "username": "alice"}})
    assert s is not None and s.level is Level.UNKNOWN


@pytest.mark.asyncio
async def test_a_forwarded_note_carries_its_sender():
    alice = Sender("gitlab", "101", "alice", Level.GUEST)
    send = AsyncMock(return_value=gitlab_h.SendOutcome.DELIVERED)
    payload = {
        "user": {"id": 101, "username": "alice"},
        "project": {"id": 7, "path_with_namespace": "g/p"},
        "object_attributes": {"note": "hi", "noteable_type": "Issue", "id": 9},
        "issue": {"iid": 3, "title": "t"},
    }
    with patch.object(gitlab_h, "sender_of", AsyncMock(return_value=alice)), \
         patch.object(gitlab_h, "deliver_message", send), \
         patch.object(gitlab_h.db, "lookup_conversation", AsyncMock(return_value="conv-1")), \
         patch.object(gitlab_h.db, "get_conversation_for_resource", AsyncMock(return_value=None)):
        await gitlab_h._handle_note(payload)
    assert send.call_args.kwargs["sender"] == alice
