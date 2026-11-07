"""PR review comments and CI status reaching the agent."""

from unittest.mock import AsyncMock, patch

import httpx

import pytest

from scooter_contrib_github import webhooks_handler as gh


def _repo():
    return {"owner": {"login": "chadac-me"}, "name": "scooter"}


def review_comment(body="please rename this", user="chadac", cid=555, in_reply_to=None):
    return {
        "action": "created",
        "comment": {
            "id": cid,
            "body": body,
            "user": {"login": user},
            "path": "src/foo.ts",
            "line": 42,
            "diff_hunk": "@@ -1 +1 @@\n-const a = 1;",
            **({"in_reply_to_id": in_reply_to} if in_reply_to else {}),
        },
        "pull_request": {"number": 431},
        "repository": _repo(),
    }


@pytest.fixture
def forwarded():
    """Capture what would be sent to the conversation."""
    with patch.object(gh, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value="conv-1")), \
         patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
        yield send


class TestReviewComment:
    @pytest.mark.asyncio
    async def test_THE_GAP_a_line_comment_reaches_the_agent(self, forwarded):
        await gh._handle_review_comment(review_comment())
        assert forwarded.called, "a line comment must reach the conversation"

    @pytest.mark.asyncio
    async def test_carries_the_file_line_and_diff_so_the_agent_need_not_refetch(self, forwarded):
        await gh._handle_review_comment(review_comment())
        msg = forwarded.call_args[0][1]
        assert "src/foo.ts:42" in msg
        assert "const a = 1;" in msg

    @pytest.mark.asyncio
    async def test_TELLS_IT_TO_REPLY_IN_THREAD_with_the_comment_id(self, forwarded):
        await gh._handle_review_comment(review_comment(cid=999))
        msg = forwarded.call_args[0][1]
        assert "in_reply_to=999" in msg

    @pytest.mark.asyncio
    async def test_INTERRUPTS_a_run_in_progress(self, forwarded):
        await gh._handle_review_comment(review_comment())
        assert forwarded.call_args.kwargs["priority"] is True

    @pytest.mark.asyncio
    async def test_NO_MENTION_REQUIRED_on_a_linked_conversation(self, forwarded):
        await gh._handle_review_comment(review_comment(body="no mention here at all"))
        assert forwarded.called

    @pytest.mark.asyncio
    async def test_an_UNLINKED_pr_is_ignored_not_created(self):
        with patch.object(gh, "send_message", new=AsyncMock()) as send, \
             patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value=None)), \
             patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
            await gh._handle_review_comment(review_comment())
            assert not send.called, "an unlinked PR is not ours to act on"

    @pytest.mark.asyncio
    async def test_does_not_react_to_its_OWN_comment(self, forwarded):
        # A real ack body rather than a patched predicate, since the recognition itself must keep working.
        await gh._handle_review_comment(review_comment(body="Scooter is on it — conv-1"))
        assert not forwarded.called, "replying to itself would loop"

    @pytest.mark.asyncio
    async def test_ignores_actions_other_than_created(self, forwarded):
        payload = review_comment()
        payload["action"] = "edited"
        await gh._handle_review_comment(payload)
        assert not forwarded.called


class TestReviewEnvelope:
    @pytest.mark.asyncio
    async def test_changes_requested_says_a_reply_is_not_enough(self, forwarded):
        await gh._handle_review({
            "action": "submitted",
            "review": {"state": "changes_requested", "body": "see comments", "user": {"login": "chadac"}},
            "pull_request": {"number": 431}, "repository": _repo(),
        })
        msg = forwarded.call_args[0][1]
        assert "PUSH" in msg

    @pytest.mark.asyncio
    async def test_a_BARE_approval_is_still_forwarded(self, forwarded):
        await gh._handle_review({
            "action": "submitted",
            "review": {"state": "approved", "body": "", "user": {"login": "chadac"}},
            "pull_request": {"number": 431}, "repository": _repo(),
        })
        assert forwarded.called
        assert "APPROVED" in forwarded.call_args[0][1]


class TestWorkflowRun:
    def _run(self, conclusion, **kw):
        return {
            "action": "completed",
            "workflow_run": {
                "name": "ci", "conclusion": conclusion, "html_url": "https://x/run/1",
                "head_branch": "feat/x", "id": 7, "workflow_id": 3,
                "pull_requests": [{"number": 431}], **kw,
            },
            "repository": _repo(),
        }

    @pytest.mark.asyncio
    async def test_a_FAILURE_reaches_the_agent_with_the_failing_job_names(self, forwarded):
        with patch.object(gh, "_failed_jobs", new=AsyncMock(return_value=["e2e fast shard 3"])):
            await gh._handle_workflow_run(self._run("failure"))
        msg = forwarded.call_args[0][1]
        assert "CI FAILED" in msg and "e2e fast shard 3" in msg

    @pytest.mark.asyncio
    async def test_a_ROUTINELY_GREEN_run_costs_nothing(self, forwarded):
        with patch.object(gh, "_previous_run_failed", new=AsyncMock(return_value=False)):
            await gh._handle_workflow_run(self._run("success"))
        assert not forwarded.called

    @pytest.mark.asyncio
    async def test_RED_to_GREEN_tells_the_agent_it_is_unblocked(self, forwarded):
        with patch.object(gh, "_previous_run_failed", new=AsyncMock(return_value=True)):
            await gh._handle_workflow_run(self._run("success"))
        assert "GREEN again" in forwarded.call_args[0][1]

    @pytest.mark.asyncio
    async def test_a_run_with_no_PR_is_ignored(self, forwarded):
        await gh._handle_workflow_run(self._run("failure", pull_requests=[]))
        assert not forwarded.called

    @pytest.mark.asyncio
    async def test_cancelled_is_not_actionable(self, forwarded):
        await gh._handle_workflow_run(self._run("cancelled"))
        assert not forwarded.called

    def _fork_run(self, sha="abc"):
        return self._run(
            "failure", pull_requests=[], head_sha=sha,
            head_repository={"owner": {"login": "chadac"}},
        )

    @pytest.fixture
    def pulls(self, monkeypatch):
        """Serve the open-PR lookup with a fork PR whose head is abc."""
        seen = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, json=[{"number": 1096, "head": {"sha": "abc"}}])

        real = httpx.AsyncClient
        monkeypatch.setattr(
            gh.httpx, "AsyncClient",
            lambda *a, **kw: real(*a, transport=httpx.MockTransport(handler), **kw),
        )
        monkeypatch.setattr(
            "scooter_contrib_github.responses._headers_for_repo", AsyncMock(return_value={}),
        )
        return seen

    @pytest.mark.asyncio
    async def test_a_FORK_PR_failure_is_routed_by_its_branch(self, forwarded, pulls):
        with patch.object(gh, "_failed_jobs", new=AsyncMock(return_value=[])):
            await gh._handle_workflow_run(self._fork_run())
        assert pulls[0].url.params["head"] == "chadac:feat/x"
        assert "PR #1096" in forwarded.call_args[0][1]

    @pytest.mark.asyncio
    async def test_a_fork_run_for_a_superseded_commit_is_ignored(self, forwarded, pulls):
        await gh._handle_workflow_run(self._fork_run(sha="old"))
        assert not forwarded.called

    @pytest.mark.asyncio
    async def test_a_same_repo_run_without_a_PR_skips_the_lookup(self, forwarded, pulls):
        await gh._handle_workflow_run(self._run(
            "failure", pull_requests=[], head_repository={"owner": {"login": "chadac-me"}},
        ))
        assert not pulls and not forwarded.called


class TestPrClosed:
    def _closed(self, merged, **pr):
        return {
            "action": "closed",
            "pull_request": {
                "number": 431, "merged": merged, "base": {"ref": "main"},
                "merge_commit_sha": "abcdef1234567890" if merged else None,
                "merged_by": {"login": "chadac"} if merged else None, **pr,
            },
            "sender": {"login": "chadac"},
            "repository": _repo(),
        }

    @pytest.mark.asyncio
    async def test_a_MERGE_reaches_the_agent(self, forwarded):
        await gh._handle_pr_event(self._closed(merged=True))
        msg = forwarded.call_args[0][1]
        assert "MERGED by @chadac" in msg and "`main`" in msg and "abcdef123456" in msg

    @pytest.mark.asyncio
    async def test_closed_WITHOUT_merging_is_told_apart_from_a_merge(self, forwarded):
        await gh._handle_pr_event(self._closed(merged=False))
        msg = forwarded.call_args[0][1]
        assert "CLOSED WITHOUT MERGING" in msg and "MERGED by" not in msg

    @pytest.mark.asyncio
    async def test_an_UNLINKED_pr_merge_is_ignored(self):
        with patch.object(gh, "send_message", new=AsyncMock()) as send, \
             patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value=None)), \
             patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
            await gh._handle_pr_event(self._closed(merged=True))
            assert not send.called

    @pytest.mark.asyncio
    async def test_other_actions_are_still_ignored(self, forwarded):
        payload = self._closed(merged=True)
        payload["action"] = "edited"
        await gh._handle_pr_event(payload)
        assert not forwarded.called


class TestPrDequeued:
    def _dequeued(self, reason):
        return {
            "action": "dequeued", "reason": reason,
            "pull_request": {"number": 431},
            "repository": _repo(), "sender": {"login": "github-merge-queue[bot]"},
        }

    @pytest.mark.asyncio
    async def test_a_CI_drop_reaches_the_agent_with_the_reason(self, forwarded):
        await gh._handle_pr_event(self._dequeued("FAILED_CHECKS"))
        msg = forwarded.call_args[0][1]
        assert "REMOVED FROM THE MERGE QUEUE" in msg and "failed_checks" in msg and "CI failed" in msg

    @pytest.mark.asyncio
    async def test_an_unknown_reason_is_still_forwarded(self, forwarded):
        await gh._handle_pr_event(self._dequeued("queue_cleared"))
        assert "queue_cleared" in forwarded.call_args[0][1]

    @pytest.mark.asyncio
    async def test_leaving_the_queue_by_merging_is_not_a_drop(self, forwarded):
        await gh._handle_pr_event(self._dequeued("merged"))
        assert not forwarded.called
