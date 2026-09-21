"""The 'Scooter is on it — follow along: <link>' ack must post BEFORE the agent run.

create_conversation() blocks until the whole agent turn finishes, so posting the
link ack after it returned delayed the link by the entire run (the 5-10min lag).
The handler posts the ack inside the `on_created` hook (fired pre-run); this drives
_background_create_conversation with a fake create_conversation that (a) invokes
on_created, (b) records call ORDER, so the ack is proven to fire during on_created.

Moved here with the handler (PR #580) — the webhooks app's copy covered the three
in-tree handlers, and gitlab's half travels with gitlab.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from scooter_contrib_gitlab import webhooks_handler as gitlab_h


def _fake_create_conversation(order: list[str]):
    async def fake(*args, on_created=None, **kwargs):
        if on_created is not None:
            await on_created("conv-xyz")
        order.append("run")  # the blocking run finishes AFTER on_created
        return {"conversation_id": "conv-xyz", "result": "done"}

    return fake


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
