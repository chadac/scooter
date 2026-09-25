"""The 'Scooter is on it — follow along: <link>' ack must post BEFORE the agent run.

create_conversation() blocks until the whole agent turn finishes, so posting the
link ack after it returned delayed the link by the entire run (the 5-10min lag).
The handler posts the ack inside the `on_created` hook (fired pre-run); this drives
_background_create_conversation with a fake create_conversation that (a) invokes
on_created, (b) records call ORDER, so the ack is proven to fire during on_created.

Moved here with the handler (PR #591) — the webhooks app's copy covered the in-tree
handlers, and github's half travels with github.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from scooter_contrib_github import webhooks_handler as github_h


def _fake_create_conversation(order: list[str]):
    async def fake(*args, on_created=None, **kwargs):
        if on_created is not None:
            await on_created("conv-xyz")
        order.append("run")  # the blocking run finishes AFTER on_created
        return {"conversation_id": "conv-xyz", "result": "done"}

    return fake


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
