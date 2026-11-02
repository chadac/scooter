"""Comments below the trusted access level are held or declined."""

from unittest.mock import AsyncMock, patch

import pytest

from scooter_contrib_gitlab import webhooks_handler as gl
from scooter_contrib_gitlab.config import settings
from scooter_webhooks_lib import policy
from scooter_webhooks_lib.agent_host_client import Screen, SendOutcome


class _Policy:
    mention_pattern = "@agent"
    label_trigger = "scooter"
    ignore_usernames = ""
    ignore_bot_authors = True

    def get_repo_descriptions(self) -> dict[str, str]:
        return {}


@pytest.fixture(autouse=True)
def gate_on(monkeypatch):
    policy.init(_Policy())
    monkeypatch.setattr(settings, "gitlab_require_approval", True)
    monkeypatch.setattr(settings, "gitlab_trusted_users", "")
    monkeypatch.setattr(settings, "gitlab_trusted_access_level", 30)
    monkeypatch.delenv("CONTRIB_GITLAB_DB_NAME", raising=False)


def note(body="@agent please fix", user="stranger"):
    return {
        "object_attributes": {"note": body, "noteable_type": "Issue", "id": 5, "url": "https://gitlab.com/acme/app/-/issues/3#note_5"},
        "user": {"username": user, "id": 77},
        "issue": {"iid": 3, "title": "Broken"},
        "project": {"id": 11, "path_with_namespace": "acme/app"},
    }


def access(level):
    return patch.object(gl, "project_access_level", new=AsyncMock(return_value=level))


def linked(conv):
    return (
        patch.object(gl.db, "lookup_conversation", new=AsyncMock(return_value=conv)),
        patch.object(gl.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)),
    )


def screening(verdict):
    return patch("scooter_webhooks_lib.trust.screen_message", new=AsyncMock(return_value=verdict))


@pytest.mark.asyncio
@pytest.mark.parametrize("level,standing", [(0, False), (20, False), (30, True), (50, True)])
async def test_standing_follows_the_trusted_access_level(level, standing):
    a, b = linked("conv-1")
    with a, b, access(level) as lookup, screening(Screen.DELIVER) as screen, \
         patch.object(gl, "deliver_message", new=AsyncMock(return_value=SendOutcome.DELIVERED)) as deliver:
        await gl._handle_note(note(body="hello"))
    assert lookup.call_args.args == (11, 77)
    assert screen.call_args.kwargs["standing"] is standing
    assert deliver.called


@pytest.mark.asyncio
async def test_a_held_note_is_not_delivered():
    a, b = linked("conv-1")
    with a, b, access(0), screening(Screen.HELD) as screen, \
         patch.object(gl, "deliver_message", new=AsyncMock()) as deliver:
        await gl._handle_note(note(body="hello"))
    assert not deliver.called
    kw = screen.call_args.kwargs
    assert kw["source"] == "gitlab" and "acme/app#3" in kw["prompt"] and kw["url"].endswith("#note_5")


@pytest.mark.asyncio
async def test_an_outsider_mention_starts_nothing_and_is_declined_once():
    a, b = linked(None)
    with a, b, access(0), \
         patch.object(gl.db, "store_conversation", new=AsyncMock()) as store, \
         patch.object(gl, "post_gitlab_comment", new=AsyncMock()) as post, \
         patch("scooter_webhooks_lib.store.claim_outsider_reply", new=AsyncMock(side_effect=[True, False])):
        await gl._handle_note(note())
        await gl._handle_note(note())
    assert not store.called
    assert post.call_count == 1
    assert post.call_args.args == (11, "issues", 3, "A maintainer needs to ask Scooter to pick this up.")


@pytest.mark.asyncio
async def test_a_developer_mention_still_starts_a_conversation():
    a, b = linked(None)
    with a, b, access(30), \
         patch.object(gl.db, "store_conversation", new=AsyncMock()) as store, \
         patch.object(gl, "_background_create_conversation", new=AsyncMock()), \
         patch.object(gl, "post_gitlab_comment", new=AsyncMock()) as post:
        await gl._handle_note(note())
    assert store.called and not post.called
