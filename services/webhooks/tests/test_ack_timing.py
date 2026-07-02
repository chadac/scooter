"""The 'Scooter is on it — follow along: <link>' ack must post BEFORE the agent
run, not after.

create_conversation() blocks until the whole agent turn finishes, so posting the
link ack after it returned delayed the link by the entire run (the 5-10min lag).
Each handler now posts the ack inside the `on_created` hook (fired pre-run). These
tests drive each handler's _background_create_conversation with a fake
create_conversation that (a) invokes on_created, (b) records call ORDER, so we can
assert the ack fired during on_created — before the (simulated) run completes.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from webhooks.handlers import slack as slack_h
from webhooks.handlers import github as github_h
from webhooks.handlers import gitlab as gitlab_h
from webhooks.handlers import jira as jira_h


def _fake_create_conversation(order: list[str]):
    """A create_conversation stub: fire on_created (recording 'ack' via the posts),
    then mark 'run' AFTER — so order proves the ack preceded the run."""
    async def fake(*args, on_created=None, **kwargs):
        if on_created is not None:
            await on_created("conv-xyz")
        order.append("run")  # the blocking run finishes AFTER on_created
        return {"conversation_id": "conv-xyz", "result": "done"}
    return fake


async def test_slack_ack_posts_before_the_run():
    order: list[str] = []

    async def rec_post(*a, **k):
        order.append("ack")

    with (
        patch.object(slack_h, "db") as db,
        patch.object(slack_h, "create_conversation", _fake_create_conversation(order)),
        patch.object(slack_h, "push_link", AsyncMock()),
        patch.object(slack_h, "post_slack_message", side_effect=rec_post) as post,
        patch.object(slack_h, "conversation_url", lambda cid: f"https://ui/?thread={cid}"),
    ):
        db.store_conversation = AsyncMock()
        db.store_slack_metadata = AsyncMock()
        db.get_and_clear_pending_messages = AsyncMock(return_value=[])
        await slack_h._background_create_conversation(
            res_id="C1:1.0", message="hi", conv_title="t", channel="C1", thread_ts="1.0",
        )

    assert order == ["ack", "run"], "the ack must post BEFORE the run finishes"
    body = post.call_args.kwargs["text"]
    assert "follow along" in body and "conv-xyz" in body


async def test_github_ack_posts_before_the_run():
    order: list[str] = []

    async def rec_post(*a, **k):
        order.append("ack")

    with (
        patch.object(github_h, "db") as db,
        patch.object(github_h, "create_conversation", _fake_create_conversation(order)),
        patch.object(github_h, "push_link", AsyncMock()),
        patch.object(github_h, "post_github_comment", side_effect=rec_post) as post,
        patch.object(github_h, "conversation_url", lambda cid: f"https://ui/?thread={cid}"),
    ):
        db.store_conversation = AsyncMock()
        db.get_and_clear_pending_messages = AsyncMock(return_value=[])
        await github_h._background_create_conversation(
            res_type="pull_request", res_id="o/r#5", message="hi", repo="o/r",
            conv_title="t", owner="o", repo_name="r", issue_number=5,
        )

    assert order == ["ack", "run"]
    assert "conv-xyz" in post.call_args.kwargs["body"]


async def test_gitlab_ack_posts_before_the_run():
    order: list[str] = []

    async def rec_post(*a, **k):
        order.append("ack")

    with (
        patch.object(gitlab_h, "db") as db,
        patch.object(gitlab_h, "create_conversation", _fake_create_conversation(order)),
        patch.object(gitlab_h, "push_link", AsyncMock()),
        patch.object(gitlab_h, "post_gitlab_comment", side_effect=rec_post) as post,
        patch.object(gitlab_h, "conversation_url", lambda cid: f"https://ui/?thread={cid}"),
    ):
        db.store_conversation = AsyncMock()
        db.get_and_clear_pending_messages = AsyncMock(return_value=[])
        await gitlab_h._background_create_conversation(
            source="gitlab", res_type="merge_request", res_id="g/p!3", message="hi",
            repo="g/p", conv_title="t", project_id=1, note_api_type="merge_requests",
            noteable_iid=3,
        )

    assert order == ["ack", "run"]
    assert "conv-xyz" in post.call_args.kwargs["body"]


async def test_jira_ack_posts_before_the_run():
    order: list[str] = []

    async def rec_post(*a, **k):
        order.append("ack")

    with (
        patch.object(jira_h, "db") as db,
        patch.object(jira_h, "create_conversation", _fake_create_conversation(order)),
        patch.object(jira_h, "post_jira_comment", side_effect=rec_post) as post,
        patch.object(jira_h, "conversation_url", lambda cid: f"https://ui/?thread={cid}"),
    ):
        db.store_conversation = AsyncMock()
        db.link_jira_ticket = AsyncMock()
        db.get_and_clear_pending_messages = AsyncMock(return_value=[])
        await jira_h._background_create_conversation(
            issue_key="ENG-1", message="hi", conv_title="t",
        )

    assert order == ["ack", "run"]
    assert "conv-xyz" in post.call_args.kwargs["body"]
