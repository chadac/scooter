"""github_resolve_thread: only a thread the agent answered last is resolved."""

from __future__ import annotations

import httpx

from scooter_broker_lib.mcp import gate_for

from scooter_contrib_github import mcp_tools as tools
from test_mcp_tools import _ctx, _link, _review_comment

LINKED = [_link(ref={"owner": "o", "repo": "r", "number": 7})]


def _threads(*, resolved=False, viewer_last=True, can_resolve=True, comment_id=55):
    return httpx.Response(200, json={"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": [{
        "id": "T_1", "isResolved": resolved, "viewerCanResolve": can_resolve,
        "comments": {"nodes": [{"databaseId": comment_id}]},
        "last": {"nodes": [{"viewerDidAuthor": viewer_last, "author": {"login": "carol"}}]},
    }]}}}}})


def _resolved():
    return httpx.Response(200, json={"data": {"resolveReviewThread": {"thread": {"isResolved": True}}}})


async def _resolve(*responses):
    ctx = _ctx(links=LINKED, responses=[_review_comment(), *responses])
    return await tools.github_resolve_thread(comment_id=55, ctx=ctx), ctx


async def test_the_tool_is_gated_on_a_github_link():
    assert gate_for("github_resolve_thread") is not None


async def test_a_thread_the_agent_answered_last_is_resolved():
    res, ctx = await _resolve(_threads(), _resolved())
    assert res.is_error is False and "Resolved the thread with comment 55 on o/r#7" in res.text
    assert ctx.upstream.calls[-1]["json"]["variables"] == {"id": "T_1"}


async def test_a_thread_where_the_reviewer_spoke_last_is_refused():
    res, ctx = await _resolve(_threads(viewer_last=False), _resolved())
    assert res.is_error is True and "@carol has the last word" in res.text
    assert "resolveReviewThread" not in str(ctx.upstream.calls[-1].get("json"))


async def test_an_already_resolved_thread_is_not_an_error():
    res, ctx = await _resolve(_threads(resolved=True), _resolved())
    assert res.is_error is False and "already resolved" in res.text
    assert len(ctx.upstream.calls) == 2


async def test_no_permission_is_said_plainly():
    res, _ = await _resolve(_threads(can_resolve=False), _resolved())
    assert res.is_error is True and "does not let this identity" in res.text


async def test_an_unknown_comment_is_refused():
    res, _ = await _resolve(_threads(comment_id=999), _resolved())
    assert res.is_error is True and "No review thread on o/r#7 contains comment 55" in res.text


async def test_a_graphql_refusal_is_surfaced():
    refused = httpx.Response(200, json={"errors": [{"message": "Resource not accessible by integration"}]})
    res, _ = await _resolve(_threads(), refused)
    assert res.is_error is True and "Resource not accessible by integration" in res.text
