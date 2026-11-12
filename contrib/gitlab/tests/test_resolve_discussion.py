"""gitlab_resolve_discussion: only a thread the agent answered last is resolved."""

from __future__ import annotations

import httpx

from scooter_broker_lib.mcp import gate_for

from scooter_contrib_gitlab import mcp_tools as tools
from test_mcp_tools import _ctx, _link

LINKED = [_link(ref={"projectId": "g/p", "mrIid": "3"})]
PATH = "api/v4/projects/g%2Fp/merge_requests/3/discussions/d3"
ME = httpx.Response(200, json={"id": 7})


def _discussion(*, last_author=7, resolved=False, resolvable=True):
    return httpx.Response(200, json={"id": "d3", "notes": [
        {"resolvable": resolvable, "resolved": resolved, "author": {"id": 1, "username": "carol"}},
        {"resolvable": resolvable, "resolved": resolved, "author": {"id": last_author, "username": "carol"}},
    ]})


async def _resolve(*responses):
    ctx = _ctx(links=LINKED, responses=[*responses, httpx.Response(200, json={})])
    return await tools.gitlab_resolve_discussion(discussion_id="d3", ctx=ctx), ctx


async def test_the_tool_is_gated_on_a_gitlab_link():
    assert gate_for("gitlab_resolve_discussion") is not None


async def test_a_thread_the_agent_answered_last_is_resolved():
    res, ctx = await _resolve(_discussion(), ME)
    assert res.is_error is False and "Resolved discussion d3 on g/p!3" in res.text
    last = ctx.upstream.calls[-1]
    assert (last["method"], last["path"], last["params"]) == ("PUT", PATH, {"resolved": "true"})


async def test_a_thread_where_the_reviewer_spoke_last_is_refused():
    res, ctx = await _resolve(_discussion(last_author=1), ME)
    assert res.is_error is True and "@carol has the last word" in res.text
    assert all(c["method"] != "PUT" for c in ctx.upstream.calls)


async def test_an_already_resolved_thread_is_not_an_error():
    res, ctx = await _resolve(_discussion(resolved=True), ME)
    assert res.is_error is False and "already resolved" in res.text
    assert all(c["method"] != "PUT" for c in ctx.upstream.calls)


async def test_a_plain_comment_is_not_resolvable():
    res, _ = await _resolve(_discussion(resolvable=False), ME)
    assert res.is_error is True and "not a resolvable thread" in res.text


async def test_an_unknown_discussion_is_surfaced_verbatim():
    res, _ = await _resolve(httpx.Response(404, text="404 Discussion Not Found"), ME)
    assert res.is_error is True and "404 Discussion Not Found" in res.text
