"""Outsiders' comments are held, and their new mentions declined."""

from unittest.mock import AsyncMock, patch

import pytest

from scooter_contrib_github import webhooks_handler as gh
from scooter_contrib_github.config import settings
from scooter_webhooks_lib.agent_host_client import Screen, SendOutcome


@pytest.fixture(autouse=True)
def gate_on(monkeypatch):
    monkeypatch.setattr(settings, "github_require_approval", True)
    monkeypatch.setattr(settings, "github_trusted_users", "")
    # No link database, so nobody is a linked user.
    monkeypatch.delenv("CONTRIB_GITHUB_DB_NAME", raising=False)


def _repo():
    return {"owner": {"login": "acme"}, "name": "app"}


def review_comment(user="stranger", association="NONE"):
    return {
        "action": "created",
        "comment": {
            "id": 7, "body": "rename this", "user": {"login": user}, "author_association": association,
            "path": "a.py", "line": 3, "html_url": "https://github.com/acme/app/pull/4#r7",
        },
        "pull_request": {"number": 4},
        "repository": _repo(),
    }


def issue_comment(body="@agent please fix", user="stranger", association="NONE"):
    return {
        "action": "created",
        "comment": {"id": 9, "body": body, "user": {"login": user}, "author_association": association},
        "issue": {"number": 12, "title": "Broken"},
        "repository": _repo(),
    }


def linked(conv):
    return (
        patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value=conv)),
        patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)),
    )


@pytest.fixture
def conv():
    a, b = linked("conv-1")
    with a, b, patch.object(gh, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(gh, "deliver_message", new=AsyncMock(return_value=SendOutcome.DELIVERED)) as deliver:
        yield send, deliver


def screening(verdict):
    return patch("scooter_webhooks_lib.trust.screen_message", new=AsyncMock(return_value=verdict))


class TestExistingConversation:
    @pytest.mark.asyncio
    async def test_a_held_line_comment_is_not_sent(self, conv):
        send, _ = conv
        with screening(Screen.HELD) as screen:
            await gh._handle_review_comment(review_comment())
        assert not send.called
        kw = screen.call_args.kwargs
        assert kw["standing"] is False and kw["author"] == "stranger" and kw["source"] == "github"
        assert "rename this" in kw["prompt"] and "acme/app#4" in kw["prompt"]
        assert kw["url"] == "https://github.com/acme/app/pull/4#r7"

    @pytest.mark.asyncio
    async def test_a_collaborator_is_screened_with_standing_and_delivered(self, conv):
        send, _ = conv
        with screening(Screen.DELIVER) as screen:
            await gh._handle_review_comment(review_comment(user="maint", association="COLLABORATOR"))
        assert screen.call_args.kwargs["standing"] is True
        assert send.called

    @pytest.mark.asyncio
    async def test_the_deployment_allowlist_gives_standing(self, conv, monkeypatch):
        monkeypatch.setattr(settings, "github_trusted_users", "Renovate[bot], other")
        with screening(Screen.DELIVER) as screen:
            await gh._handle_review_comment(review_comment(user="renovate[bot]"))
        assert screen.call_args.kwargs["standing"] is True

    @pytest.mark.asyncio
    async def test_a_failed_screen_drops_the_comment_rather_than_sending_it_unscreened(self, conv):
        send, _ = conv
        with screening(Screen.FAILED):
            await gh._handle_review_comment(review_comment())
        assert not send.called

    @pytest.mark.asyncio
    async def test_a_review_is_screened_too(self, conv):
        send, _ = conv
        payload = {
            "action": "submitted",
            "review": {"user": {"login": "stranger"}, "body": "do X", "state": "commented", "author_association": "NONE"},
            "pull_request": {"number": 4},
            "repository": _repo(),
        }
        with screening(Screen.HELD):
            await gh._handle_review(payload)
        assert not send.called

    @pytest.mark.asyncio
    async def test_a_held_issue_comment_is_not_delivered(self, conv):
        _, deliver = conv
        with screening(Screen.HELD):
            await gh._handle_comment(issue_comment(body="no mention"))
        assert not deliver.called

    @pytest.mark.asyncio
    async def test_a_merge_notice_is_vouched_for_by_github_and_not_screened(self, conv):
        send, _ = conv
        payload = {
            "action": "closed",
            "pull_request": {"number": 4, "merged": True, "base": {"ref": "main"}},
            "repository": _repo(),
            "sender": {"login": "stranger"},
        }
        with screening(Screen.HELD) as screen:
            await gh._handle_pr_event(payload)
        assert not screen.called and send.called

    @pytest.mark.asyncio
    async def test_with_the_gate_off_nothing_is_screened(self, conv, monkeypatch):
        monkeypatch.setattr(settings, "github_require_approval", False)
        send, _ = conv
        with screening(Screen.HELD) as screen:
            await gh._handle_review_comment(review_comment())
        assert not screen.called and send.called


class TestNoConversation:
    @pytest.mark.asyncio
    async def test_an_outsider_mention_starts_nothing_and_is_declined_once(self):
        a, b = linked(None)
        with a, b, \
             patch.object(gh.db, "store_conversation", new=AsyncMock()) as store, \
             patch.object(gh, "create_conversation", new=AsyncMock()) as create, \
             patch.object(gh, "post_github_comment", new=AsyncMock()) as post, \
             patch("scooter_webhooks_lib.store.claim_outsider_reply", new=AsyncMock(side_effect=[True, False])):
            await gh._handle_comment(issue_comment())
            await gh._handle_comment(issue_comment())
        assert not store.called and not create.called
        assert post.call_count == 1
        assert post.call_args.kwargs["body"] == "A maintainer needs to ask Scooter to pick this up."
        assert post.call_args.kwargs["issue_number"] == 12

    @pytest.mark.asyncio
    async def test_a_member_mention_still_starts_a_conversation(self):
        a, b = linked(None)
        with a, b, \
             patch.object(gh.db, "store_conversation", new=AsyncMock()) as store, \
             patch.object(gh, "_background_create_conversation", new=AsyncMock()), \
             patch.object(gh, "post_github_comment", new=AsyncMock()) as post:
            await gh._handle_comment(issue_comment(user="maint", association="MEMBER"))
        assert store.called and not post.called

    @pytest.mark.asyncio
    async def test_an_outsider_comment_on_a_conversation_still_starting_is_not_buffered(self):
        a, b = linked(gh.PENDING_CONVERSATION_ID)
        with a, b, patch.object(gh.db, "store_pending_message", new=AsyncMock()) as buffer:
            await gh._handle_comment(issue_comment())
        assert not buffer.called
