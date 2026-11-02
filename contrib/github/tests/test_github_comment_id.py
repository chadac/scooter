"""A forwarded GitHub comment carries the id of the comment it came from, and nothing more; what to do with it is the scooter-github skill's business."""

from unittest.mock import AsyncMock, patch

import pytest

from scooter_contrib_github import webhooks_handler as gh


def _repo():
    return {"owner": {"login": "chadac-me"}, "name": "scooter"}


def issue_comment(cid=991, body="can you also handle the empty case?", is_pr=True):
    return {
        "action": "created",
        "comment": {"id": cid, "body": body, "user": {"login": "chadac"}},
        "issue": {
            "number": 42,
            "title": "Fix the thing",
            **({"pull_request": {"url": "https://api.github.com/..."}} if is_pr else {}),
        },
        "repository": _repo(),
    }


def review_comment(cid=555):
    return {
        "action": "created",
        "comment": {
            "id": cid,
            "body": "please rename this",
            "user": {"login": "chadac"},
            "path": "src/foo.ts",
            "line": 42,
            "diff_hunk": "@@ -1 +1 @@\n-const a = 1;",
        },
        "pull_request": {"number": 42},
        "repository": _repo(),
    }


@pytest.fixture
def forwarded():
    """Capture what would be sent to the already-linked conversation."""
    # A comment on a linked thread goes through deliver_message, everything else send_message.
    send = AsyncMock(return_value=gh.SendOutcome.DELIVERED)
    with patch.object(gh, "send_message", new=send), \
         patch.object(gh, "deliver_message", new=send), \
         patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value="conv-1")), \
         patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
        yield send


class TestTheIdIsCarried:
    @pytest.mark.asyncio
    async def test_a_pr_comment_names_its_id(self, forwarded):
        await gh._handle_comment(issue_comment(cid=991))
        assert "comment_id: 991" in forwarded.call_args[0][1]

    @pytest.mark.asyncio
    async def test_an_issue_comment_names_its_id(self, forwarded):
        await gh._handle_comment(issue_comment(cid=77, is_pr=False))
        assert "comment_id: 77" in forwarded.call_args[0][1]

    @pytest.mark.asyncio
    async def test_a_line_comment_names_its_id(self, forwarded):
        await gh._handle_review_comment(review_comment(cid=555))
        assert "comment_id: 555" in forwarded.call_args[0][1]

    @pytest.mark.asyncio
    async def test_a_line_comment_still_says_to_reply_in_thread(self, forwarded):
        """The id must not displace the in_reply_to instruction."""
        await gh._handle_review_comment(review_comment(cid=555))
        assert "in_reply_to=555" in forwarded.call_args[0][1]


class TestTheHandlerStaysADataPipe:
    """No endpoints, no commands, no react-first policy in the forwarder."""

    @pytest.mark.asyncio
    async def test_no_reaction_endpoint_is_baked_into_a_pr_comment(self, forwarded):
        await gh._handle_comment(issue_comment())
        msg = forwarded.call_args[0][1]
        assert "reactions" not in msg
        assert "agent-broker" not in msg

    @pytest.mark.asyncio
    async def test_no_reaction_endpoint_is_baked_into_a_line_comment(self, forwarded):
        await gh._handle_review_comment(review_comment())
        msg = forwarded.call_args[0][1]
        assert "reactions" not in msg
        assert "agent-broker" not in msg


class TestTheReplyStepsAreAsked:
    """Every forwarded comment asks for a reaction, then a plan comment, then results."""

    @pytest.mark.asyncio
    async def test_a_pr_comment_asks_to_react_and_plan(self, forwarded):
        await gh._handle_comment(issue_comment())
        msg = forwarded.call_args[0][1]
        assert "React 👀 first" in msg
        assert "comment your plan" in msg

    @pytest.mark.asyncio
    async def test_a_line_comment_asks_to_react_and_plan(self, forwarded):
        await gh._handle_review_comment(review_comment())
        msg = forwarded.call_args[0][1]
        assert "React 👀 first" in msg
        assert "comment your plan" in msg

    def test_a_first_mention_carries_the_id_to_react_to(self):
        text = gh._response_instructions("chadac-me", "scooter", 42, True, comment_id=991)
        assert "React 👀 first" in text
        assert "comment_id: 991" in text

    def test_a_label_trigger_has_no_comment_to_react_to(self):
        text = gh._response_instructions("chadac-me", "scooter", 42, True)
        assert "React" not in text
        assert "comment your plan" in text
