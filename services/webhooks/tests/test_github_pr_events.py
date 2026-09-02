"""PR review comments + CI status reaching the agent.

Before this, handlers/github.py dispatched only issue_comment / issues /
pull_request — so a comment on a specific LINE of a diff (the most common way a
human reviews an agent's PR) hit `else: logger.debug("ignoring event type")` and
the agent never saw it. Same for CI: nothing told it a run failed.
"""

from unittest.mock import AsyncMock, patch

import pytest

from webhooks.handlers import github as gh


def _repo():
    return {"owner": {"login": "chadac"}, "name": "scooter"}


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
        assert "const a = 1;" in msg  # the diff hunk

    @pytest.mark.asyncio
    async def test_TELLS_IT_TO_REPLY_IN_THREAD_with_the_comment_id(self, forwarded):
        # A reply posted at the bottom of the PR is stranded away from the code.
        await gh._handle_review_comment(review_comment(cid=999))
        msg = forwarded.call_args[0][1]
        assert "in_reply_to=999" in msg

    @pytest.mark.asyncio
    async def test_INTERRUPTS_a_run_in_progress(self, forwarded):
        # priority=True -> the agent-host applies interrupt:"thinking".
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
        with patch.object(gh, "_is_own_comment", return_value=True):
            await gh._handle_review_comment(review_comment())
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
        # Decided: the agent should learn its PR was approved.
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
        # The agent asked for the push, not a receipt.
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
