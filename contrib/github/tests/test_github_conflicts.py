"""A PR that starts conflicting with its base reaches the agent once."""

import asyncio
from unittest.mock import AsyncMock, patch

import httpx

import pytest

from scooter_contrib_github import webhooks_handler as gh


def _repo():
    return {"owner": {"login": "chadac-me"}, "name": "scooter"}


def _pr(number=431, mergeable=False, sha="abc", state="open"):
    return {
        "number": number, "state": state, "mergeable": mergeable,
        "head": {"sha": sha}, "base": {"ref": "main"},
    }


@pytest.fixture
def github(monkeypatch):
    """Serve the PR list and each PR from `github.pulls`, recording requests."""

    class Fake:
        pulls: dict[int, list[dict]] = {}
        seen: list[httpx.Request] = []

    def handler(request):
        Fake.seen.append(request)
        tail = request.url.path.rsplit("/", 1)[-1]
        if tail == "pulls":
            return httpx.Response(200, json=[{"number": n} for n in Fake.pulls])
        # Each read pops the next state, so a test can script `mergeable: null` first.
        states = Fake.pulls[int(tail)]
        return httpx.Response(200, json=states.pop(0) if len(states) > 1 else states[0])

    real = httpx.AsyncClient
    monkeypatch.setattr(
        gh.httpx, "AsyncClient",
        lambda *a, **kw: real(*a, transport=httpx.MockTransport(handler), **kw),
    )
    monkeypatch.setattr("scooter_contrib_github.responses._headers_for_repo", AsyncMock(return_value={}))
    monkeypatch.setattr(gh, "_MERGEABLE_DELAYS", (0, 0, 0))
    Fake.pulls, Fake.seen = {}, []
    return Fake


@pytest.fixture
def linked():
    """Link every PR to conv-1 and capture what is sent to it."""
    with patch.object(gh, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value="conv-1")), \
         patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)), \
         patch.object(gh.ConversationVars, "claim", autospec=True, return_value=True) as claim:
        send.claim = claim
        yield send


class TestBaseBranchPush:
    @pytest.mark.asyncio
    async def test_a_PR_that_now_CONFLICTS_is_told_to_rebase(self, github, linked):
        github.pulls = {431: [_pr()]}
        await gh._check_pulls_into("chadac-me", "scooter", "main")
        msg = linked.call_args[0][1]
        assert "PR #431" in msg and "MERGE CONFLICTS" in msg and "Rebase" in msg
        assert github.seen[0].url.params["base"] == "main"
        linked.claim.assert_awaited_once()
        vars_, key, head = linked.claim.await_args.args
        assert (vars_.conversation_id, vars_.namespace) == ("conv-1", "github")
        assert (key, head) == ("conflict_head:chadac-me/scooter#431", "abc")

    @pytest.mark.asyncio
    async def test_it_WAITS_while_GitHub_is_still_computing(self, github, linked):
        github.pulls = {431: [_pr(mergeable=None), _pr(mergeable=None), _pr()]}
        await gh._check_pulls_into("chadac-me", "scooter", "main")
        assert linked.called

    @pytest.mark.asyncio
    async def test_a_mergeable_PR_is_left_alone(self, github, linked):
        github.pulls = {431: [_pr(mergeable=True)]}
        await gh._check_pulls_into("chadac-me", "scooter", "main")
        assert not linked.called and not linked.claim.called

    @pytest.mark.asyncio
    async def test_a_conflict_ALREADY_ANNOUNCED_for_this_head_is_not_repeated(self, github, linked):
        github.pulls = {431: [_pr()]}
        linked.claim.return_value = False
        await gh._check_pulls_into("chadac-me", "scooter", "main")
        assert not linked.called

    @pytest.mark.asyncio
    async def test_an_UNLINKED_PR_costs_no_API_call(self, github, linked):
        github.pulls = {431: [_pr()]}
        gh.db.lookup_conversation.return_value = None
        await gh._check_pulls_into("chadac-me", "scooter", "main")
        assert [r.url.path for r in github.seen] == ["/repos/chadac-me/scooter/pulls"]
        assert not linked.called

    @pytest.mark.asyncio
    async def test_a_push_schedules_the_check_for_its_branch(self):
        with patch.object(gh, "_check_pulls_into", new=AsyncMock()) as check:
            await gh._handle_push({"ref": "refs/heads/main", "repository": _repo()})
            await asyncio.sleep(0)
        check.assert_awaited_once_with("chadac-me", "scooter", "main")

    @pytest.mark.asyncio
    async def test_tag_pushes_and_branch_deletions_are_ignored(self):
        with patch.object(gh, "_check_pulls_into", new=AsyncMock()) as check:
            await gh._handle_push({"ref": "refs/tags/v1", "repository": _repo()})
            await gh._handle_push({"ref": "refs/heads/x", "deleted": True, "repository": _repo()})
            await asyncio.sleep(0)
        assert not check.called


class TestPrSynchronize:
    @pytest.mark.asyncio
    async def test_a_push_to_the_PR_rechecks_that_PR(self):
        with patch.object(gh, "_notify_if_conflicting", new=AsyncMock()) as check:
            await gh._handle_pr_event({
                "action": "synchronize", "pull_request": {"number": 431}, "repository": _repo(),
            })
            await asyncio.sleep(0)
        check.assert_awaited_once_with("chadac-me", "scooter", 431)
