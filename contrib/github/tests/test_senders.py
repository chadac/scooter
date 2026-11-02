"""Every forwarded GitHub message names its sender by numeric id, with a level from author_association only."""

from unittest.mock import AsyncMock, patch

import pytest

from scooter_contrib_github import webhooks_handler as gh
from scooter_contrib_github.senders import actor_on, association_level, sender_from
from scooter_webhooks_lib.sender import Level, Sender

REPO = {"owner": {"login": "chadac-me"}, "name": "scooter"}
ALICE = {"login": "alice", "id": 101}


@pytest.mark.parametrize(
    ("association", "level"),
    [
        ("OWNER", Level.MEMBER),
        ("MEMBER", Level.MEMBER),
        ("COLLABORATOR", Level.MEMBER),
        ("CONTRIBUTOR", Level.CONTRIBUTOR),
        ("FIRST_TIME_CONTRIBUTOR", Level.GUEST),
        ("FIRST_TIMER", Level.GUEST),
        ("NONE", Level.GUEST),
        ("MANNEQUIN", Level.UNKNOWN),
        (None, Level.UNKNOWN),
    ],
)
def test_association_levels(association, level):
    assert association_level(association) is level


def test_the_sender_is_the_numeric_id_never_the_login():
    s = sender_from({"login": "renovate[bot]", "id": 29139614}, "NONE")
    assert s == Sender("github", "29139614", "renovate[bot]", Level.GUEST)


@pytest.mark.parametrize("user", [{"login": "alice"}, {"login": "alice", "id": "101"}, {"id": True}, None])
def test_no_numeric_id_means_no_sender(user):
    assert sender_from(user, "OWNER") is None


def test_an_actor_borrows_the_resource_association_only_as_its_author():
    issue = {"user": ALICE, "author_association": "OWNER"}
    assert actor_on({"sender": ALICE}, issue).level is Level.MEMBER
    # A non-author labeler doesn't inherit the author's standing.
    assert actor_on({"sender": {"login": "bob", "id": 202}}, issue).level is Level.UNKNOWN


@pytest.fixture
def sent():
    send = AsyncMock(return_value=gh.SendOutcome.DELIVERED)
    with patch.object(gh, "send_message", new=send), \
         patch.object(gh, "deliver_message", new=send), \
         patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value="conv-1")), \
         patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)), \
         patch.object(gh, "_is_self_authored", new=AsyncMock(return_value=False)):
        yield send


@pytest.mark.asyncio
async def test_a_comment_carries_its_author(sent):
    await gh._handle_comment({
        "action": "created",
        "comment": {"id": 1, "body": "hi", "user": ALICE, "author_association": "CONTRIBUTOR"},
        "issue": {"number": 42, "title": "t", "pull_request": {}},
        "repository": REPO,
    })
    assert sent.call_args.kwargs["sender"] == Sender("github", "101", "alice", Level.CONTRIBUTOR)


@pytest.mark.asyncio
async def test_a_review_carries_its_author(sent):
    await gh._handle_review({
        "action": "submitted",
        "review": {"body": "lgtm", "state": "approved", "user": ALICE, "author_association": "MEMBER"},
        "pull_request": {"number": 42},
        "repository": REPO,
    })
    assert sent.call_args.kwargs["sender"].level is Level.MEMBER


@pytest.mark.asyncio
async def test_a_line_comment_carries_its_author(sent):
    await gh._handle_review_comment({
        "action": "created",
        "comment": {"id": 5, "body": "rename", "user": ALICE, "author_association": "NONE", "path": "a.ts"},
        "pull_request": {"number": 42},
        "repository": REPO,
    })
    assert sent.call_args.kwargs["sender"].level is Level.GUEST


@pytest.mark.asyncio
async def test_a_comment_queued_before_its_conversation_keeps_its_sender():
    store = AsyncMock()
    with patch.object(gh, "_resolve_conversation", new=AsyncMock(return_value=gh.PENDING_CONVERSATION_ID)), \
         patch.object(gh, "_is_self_authored", new=AsyncMock(return_value=False)), \
         patch.object(gh.db, "store_pending_message", new=store):
        await gh._handle_comment({
            "action": "created",
            "comment": {"id": 1, "body": "@scooter hi", "user": ALICE, "author_association": "OWNER"},
            "issue": {"number": 42, "title": "t"},
            "repository": REPO,
        })
    assert store.call_args.args[4] == Sender("github", "101", "alice", Level.MEMBER)
