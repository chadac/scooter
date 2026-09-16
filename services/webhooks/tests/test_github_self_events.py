"""The agent must not be fed the comments and reviews it posts itself.

It comments through a GitHub App, so every `github_comment` it makes returns as
an issue_comment / pull_request_review_comment / pull_request_review webhook
whose author is `<app-slug>[bot]` (`user.type == "Bot"`). Nothing filtered that:
`_is_own_comment` only matched the literal "Scooter is on it" acknowledgment,
and `ignore_usernames` was opt-in config no deployment set. Reviews are
forwarded with priority=True, so an unfiltered one INTERRUPTS the run that
wrote it.
"""

from unittest.mock import AsyncMock, patch

import pytest

from webhooks.config import settings
from webhooks.handlers import github as gh


def _repo():
    return {"owner": {"login": "chadac"}, "name": "scooter"}


def _bot(login="scooter-chadac-me[bot]"):
    return {"login": login, "type": "Bot"}


def _human(login="chadac"):
    return {"login": login, "type": "User"}


def issue_comment(author, body="pushed a fix for the failing job"):
    return {
        "action": "created",
        "comment": {"body": body, "user": author},
        "issue": {"number": 431, "title": "t", "pull_request": {}},
        "repository": _repo(),
    }


def review_comment(author, body="renamed it"):
    return {
        "action": "created",
        "comment": {"id": 1, "body": body, "user": author, "path": "a.ts", "line": 4},
        "pull_request": {"number": 431},
        "repository": _repo(),
    }


def review(author, body="looks good", state="approved"):
    return {
        "action": "submitted",
        "review": {"user": author, "body": body, "state": state},
        "pull_request": {"number": 431},
        "repository": _repo(),
    }


@pytest.fixture
def forwarded():
    with patch.object(gh, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value="conv-1")), \
         patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)), \
         patch.object(gh.db, "store_pending_message", new=AsyncMock()), \
         patch.object(settings, "ignore_bot_authors", True), \
         patch.object(settings, "ignore_usernames", ""), \
         patch.object(settings, "mention_pattern", "@agent"):
        yield send


class TestOwnEventsAreDropped:
    @pytest.mark.asyncio
    async def test_its_own_issue_comment_is_not_forwarded(self, forwarded):
        await gh._handle_comment(issue_comment(_bot()))
        assert not forwarded.called

    @pytest.mark.asyncio
    async def test_its_own_line_comment_is_not_forwarded(self, forwarded):
        await gh._handle_review_comment(review_comment(_bot()))
        assert not forwarded.called, "the agent's own inline review comment"

    @pytest.mark.asyncio
    async def test_its_own_review_does_not_INTERRUPT_the_run_that_wrote_it(self, forwarded):
        # _forward_or_ignore sends priority=True -> agent-host interrupt:"thinking".
        await gh._handle_review(review(_bot()))
        assert not forwarded.called


class TestHumansStillGetThrough:
    @pytest.mark.asyncio
    async def test_a_human_line_comment_still_reaches_the_agent(self, forwarded):
        await gh._handle_review_comment(review_comment(_human()))
        assert forwarded.called

    @pytest.mark.asyncio
    async def test_a_human_review_still_reaches_the_agent(self, forwarded):
        await gh._handle_review(review(_human(), state="changes_requested"))
        assert forwarded.called

    @pytest.mark.asyncio
    async def test_a_bot_that_MENTIONS_the_agent_is_the_opt_in(self, forwarded):
        # A mention is a deliberate address, so an automation can still hand work over.
        await gh._handle_review_comment(review_comment(_bot("ci-bot[bot]"), body="@agent please fix"))
        assert forwarded.called


class TestConfigLevers:
    @pytest.mark.asyncio
    async def test_ignore_bot_authors_off_restores_the_old_behaviour(self, forwarded):
        with patch.object(settings, "ignore_bot_authors", False):
            await gh._handle_review_comment(review_comment(_bot()))
        assert forwarded.called

    @pytest.mark.asyncio
    async def test_ignore_usernames_drops_a_named_identity_regardless_of_type(self, forwarded):
        with patch.object(settings, "ignore_bot_authors", False), \
             patch.object(settings, "ignore_usernames", "Scooter-Chadac-Me[bot], noisy"):
            await gh._handle_review_comment(review_comment(_bot()))
        assert not forwarded.called, "matched case-insensitively"
