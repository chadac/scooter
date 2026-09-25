"""The agent must not be fed the comments and reviews it posts itself.

It comments through the platform's GitHub App, so every `github_comment` it
makes returns as an issue_comment / pull_request_review_comment /
pull_request_review webhook authored by `<app-slug>[bot]`. Nothing filtered
that: `_is_own_comment` matched only the literal "Scooter is on it"
acknowledgment, and `ignore_usernames` was opt-in config no deployment set.
Reviews are forwarded with priority=True, so an unfiltered one INTERRUPTS the
run that wrote it.

The same App backs this service, so it recognizes that login via `GET /app`
(`get_app_login`). Without those credentials it falls back to dropping
Bot-authored comments that don't mention the agent.

Moved here with the handler (PR #591).
"""

from unittest.mock import AsyncMock, patch

import pytest

from scooter_contrib_github import webhooks_handler as gh

OWN_LOGIN = "scooter-chadac-me[bot]"


def _repo():
    return {"owner": {"login": "chadac"}, "name": "scooter"}


def _bot(login=OWN_LOGIN):
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
    """Capture what reaches the conversation, with NO App credentials."""
    with patch.object(gh, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(gh, "get_app_login", new=AsyncMock(return_value=None)), \
         patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value="conv-1")), \
         patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)), \
         patch.object(gh.db, "store_pending_message", new=AsyncMock()):
        yield send


@pytest.fixture
def identified(forwarded):
    """As above, but the App identity resolved — the deployed configuration."""
    with patch.object(gh, "get_app_login", new=AsyncMock(return_value=OWN_LOGIN)):
        yield forwarded


class TestOwnEventsAreDropped:
    @pytest.mark.asyncio
    async def test_its_own_issue_comment_is_not_forwarded(self, identified):
        await gh._handle_comment(issue_comment(_bot()))
        assert not identified.called

    @pytest.mark.asyncio
    async def test_its_own_line_comment_is_not_forwarded(self, identified):
        await gh._handle_review_comment(review_comment(_bot()))
        assert not identified.called, "the agent's own inline review comment"

    @pytest.mark.asyncio
    async def test_its_own_review_does_not_INTERRUPT_the_run_that_wrote_it(self, identified):
        # _forward_or_ignore sends priority=True -> agent-host interrupt:"thinking".
        await gh._handle_review(review(_bot()))
        assert not identified.called

    @pytest.mark.asyncio
    async def test_its_own_comment_QUOTING_a_mention_is_still_dropped(self, identified):
        # The identity check must beat the mention carve-out: the agent quotes
        # the request it is answering, which would otherwise re-trigger it.
        await gh._handle_review_comment(review_comment(_bot(), body="> @agent fix this\n\nDone."))
        assert not identified.called

    @pytest.mark.asyncio
    async def test_login_match_is_case_insensitive(self, identified):
        await gh._handle_review_comment(review_comment(_bot(OWN_LOGIN.upper())))
        assert not identified.called


class TestHumansStillGetThrough:
    @pytest.mark.asyncio
    async def test_a_human_line_comment_still_reaches_the_agent(self, identified):
        await gh._handle_review_comment(review_comment(_human()))
        assert identified.called

    @pytest.mark.asyncio
    async def test_a_human_review_still_reaches_the_agent(self, identified):
        await gh._handle_review(review(_human(), state="changes_requested"))
        assert identified.called

    @pytest.mark.asyncio
    async def test_another_bot_that_MENTIONS_the_agent_is_the_opt_in(self, identified):
        # A mention is a deliberate address, so an automation can still hand work over.
        await gh._handle_review_comment(review_comment(_bot("ci-bot[bot]"), body="@agent please fix"))
        assert identified.called


class TestFallbackWithoutAppCredentials:
    @pytest.mark.asyncio
    async def test_bot_authorship_alone_drops_it(self, forwarded):
        # get_app_login -> None: the identity is unknown, so the heuristic runs.
        await gh._handle_review_comment(review_comment(_bot()))
        assert not forwarded.called

    @pytest.mark.asyncio
    async def test_ignore_bot_authors_off_restores_the_old_behaviour(self, forwarded, trigger_policy):
        with patch.object(trigger_policy, "ignore_bot_authors", False):
            await gh._handle_review_comment(review_comment(_bot()))
        assert forwarded.called

    @pytest.mark.asyncio
    async def test_ignore_usernames_drops_a_named_identity_regardless_of_type(self, forwarded, trigger_policy):
        with patch.object(trigger_policy, "ignore_bot_authors", False), \
             patch.object(trigger_policy, "ignore_usernames", "Scooter-Chadac-Me[bot], noisy"):
            await gh._handle_review_comment(review_comment(_bot()))
        assert not forwarded.called, "matched case-insensitively"
