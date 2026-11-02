"""GitHub's agent tool, tested as a plain async function over a ToolContext with fakes for `upstream` and `links`."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from scooter_broker_lib.mcp import ToolContext, gate_for
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_github import mcp_tools as tools


@dataclass
class FakeUpstream:
    responses: list[httpx.Response]
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        self.calls.append({"method": method, "path": path, **kw})
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]


@dataclass
class FakeLinks:
    rows: list[dict[str, Any]]

    async def list(self) -> list[dict[str, Any]]:
        return self.rows


def _ctx(*, links=None, responses=None) -> ToolContext:
    return ToolContext(
        identity=Identity(
            conversation_id="conv-1",
            namespace="agent-sandbox",
            service_account="system:serviceaccount:agent-sandbox:agent-host",
        ),
        provider=Provider(name="github", transports=[]),
        upstream=FakeUpstream(responses or [httpx.Response(201, json={"id": 1})]),
        links=FakeLinks(links or []),
    )


def _link(*, ref=None, url="", rtype="pr"):
    return {"source": "github", "resourceType": rtype, "url": url, "ref": ref or {}}


# --- the gate ---------------------------------------------------------------------

async def test_the_gate_is_CLOSED_with_no_github_link():
    assert await gate_for("github_comment")(_ctx()) is False


async def test_the_gate_is_CLOSED_for_another_provider_s_link():
    ctx = _ctx(links=[{"source": "gitlab", "resourceType": "mr", "url": "https://gitlab.com/g/p/-/merge_requests/1", "ref": {}}])
    assert await gate_for("github_comment")(ctx) is False


async def test_the_gate_OPENS_on_a_structured_ref():
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})])
    assert await gate_for("github_comment")(ctx) is True


async def test_the_gate_OPENS_on_a_URL_ONLY_link():
    """A link posted through the agent-host API carries only url+title."""
    ctx = _ctx(links=[_link(url="https://github.com/o/r/pull/7")])
    assert await gate_for("github_comment")(ctx) is True


# --- target resolution ------------------------------------------------------------

async def test_an_INCOMPLETE_ref_falls_back_to_the_url_of_the_SAME_link():
    """A ref missing `number` is abandoned whole and the same link's URL is parsed whole."""
    ctx = _ctx(links=[_link(ref={"owner": "wrong", "repo": "wrong"}, url="https://github.com/right/repo/pull/9")])
    t = (await tools.github_targets(ctx))[0]
    assert (t.owner, t.repo, t.number) == ("right", "repo", 9)


async def test_targets_are_listed_OLDEST_first():
    ctx = _ctx(links=[
        _link(ref={"owner": "o", "repo": "first", "number": 1}),
        _link(ref={"owner": "o", "repo": "second", "number": 2}),
    ])
    assert [t.repo for t in await tools.github_targets(ctx)] == ["first", "second"]


# --- the comment ------------------------------------------------------------------

async def test_comment_posts_an_issue_comment_by_default():
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})])
    res = await tools.github_comment(body="hi", ctx=ctx)
    assert res.is_error is False
    assert ctx.upstream.calls[0]["path"] == "repos/o/r/issues/7/comments"
    assert ctx.upstream.calls[0]["json"] == {"body": "hi"}


async def test_comment_surfaces_a_failure_VERBATIM():
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[httpx.Response(422, text="Validation Failed")])
    res = await tools.github_comment(body="hi", ctx=ctx)
    assert res.is_error is True
    assert "422" in res.text and "Validation Failed" in res.text


async def test_comment_with_no_target_is_an_error_not_a_guess():
    res = await tools.github_comment(body="hi", ctx=_ctx())
    assert res.is_error is True
    assert "Could not determine" in res.text


# --- the review-thread guard ------------------------------------------------------

def _review_comment(owner="o", repo="r", number=7, comment_id=55):
    return httpx.Response(200, json={"html_url": f"https://github.com/{owner}/{repo}/pull/{number}#discussion_r{comment_id}"})


def _graphql(resolved: bool, comment_id: int = 55):
    return httpx.Response(200, json={"data": {"repository": {"pullRequest": {"reviewThreads": {
        "nodes": [{"isResolved": resolved, "comments": {"nodes": [{"databaseId": comment_id}]}}]}}}}})


async def test_a_reply_to_a_RESOLVED_thread_is_refused():
    """GitHub sends no webhook when a human resolves a thread, so a late reply could land on a closed one."""
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[_review_comment(), _graphql(True), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is True
    assert "RESOLVED" in res.text
    assert all("replies" not in c["path"] for c in ctx.upstream.calls)


async def test_a_reply_to_an_UNRESOLVED_thread_posts_to_the_replies_endpoint():
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[_review_comment(), _graphql(False), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is False
    assert ctx.upstream.calls[-1]["path"] == "repos/o/r/pulls/7/comments/55/replies"


async def test_the_guard_FAILS_OPEN_on_a_non_2xx_graphql_response():
    """A missed reply is worse than a stale one."""
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[_review_comment(), httpx.Response(500, text="boom"), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is False


async def test_the_guard_FAILS_OPEN_when_the_thread_is_not_found():
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[_review_comment(), _graphql(True, comment_id=999), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is False


async def test_no_graphql_check_when_not_replying_in_a_thread():
    """A PR-level comment needs no resolution check."""
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})])
    await tools.github_comment(body="hi", ctx=ctx)
    assert all(c["path"] != "graphql" for c in ctx.upstream.calls)


async def test_ctx_is_not_exposed_to_the_model():
    for tool in await tools.mcp.list_tools(run_middleware=False):
        assert "ctx" not in tool.parameters.get("properties", {}), tool.name


# --- the conversation_map fallback ------------------------------------

async def test_a_SHORT_FORM_mapping_row_resolves():
    """The broker appends conversation_map rows as links carrying the raw resource_id in `url`."""
    ctx = _ctx(links=[_link(url="o/r#7")])
    t = (await tools.github_targets(ctx))[0]
    assert (t.owner, t.repo, t.number) == ("o", "r", 7)


async def test_a_real_link_comes_BEFORE_the_appended_mapping_row():
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "real", "number": 1}), _link(url="o/fallback#2")])
    assert [t.repo for t in await tools.github_targets(ctx)] == ["real", "fallback"]


# --- choosing among several links -------------------------------------------------

_ISSUE = _link(ref={"owner": "o", "repo": "r", "number": 1077}, rtype="issue")
_PR = _link(ref={"owner": "o", "repo": "r", "number": 1078})


async def test_several_links_and_no_target_is_an_error_not_the_oldest():
    """Defaulting to the oldest link posted a PR answer on the issue."""
    ctx = _ctx(links=[_ISSUE, _PR])
    res = await tools.github_comment(body="hi", ctx=ctx)
    assert res.is_error is True
    assert "o/r#1077" in res.text and "o/r#1078" in res.text
    assert ctx.upstream.calls == []


async def test_target_picks_the_linked_pr():
    ctx = _ctx(links=[_ISSUE, _PR])
    res = await tools.github_comment(body="hi", target="o/r#1078", ctx=ctx)
    assert res.is_error is False
    assert ctx.upstream.calls[0]["path"] == "repos/o/r/issues/1078/comments"


async def test_target_accepts_a_url():
    ctx = _ctx(links=[_ISSUE, _PR])
    await tools.github_comment(body="hi", target="https://github.com/o/r/pull/1078", ctx=ctx)
    assert ctx.upstream.calls[0]["path"] == "repos/o/r/issues/1078/comments"


async def test_an_UNLINKED_target_is_refused():
    ctx = _ctx(links=[_ISSUE, _PR])
    res = await tools.github_comment(body="hi", target="someone/else#5", ctx=ctx)
    assert res.is_error is True
    assert "not linked" in res.text
    assert ctx.upstream.calls == []


async def test_a_duplicate_mapping_row_is_not_a_second_link():
    ctx = _ctx(links=[_PR, _link(url="o/r#1078")])
    res = await tools.github_comment(body="hi", ctx=ctx)
    assert res.is_error is False


async def test_a_reply_goes_to_the_PR_owning_the_review_comment():
    """The oldest link is an issue, which has no review threads."""
    ctx = _ctx(links=[_ISSUE, _PR],
               responses=[_review_comment(number=1078), _graphql(False), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is False
    assert ctx.upstream.calls[0]["path"] == "repos/o/r/pulls/comments/55"
    assert ctx.upstream.calls[-1]["path"] == "repos/o/r/pulls/1078/comments/55/replies"


async def test_a_reply_to_an_UNKNOWN_review_comment_is_refused():
    ctx = _ctx(links=[_ISSUE, _PR], responses=[httpx.Response(404, json={"message": "Not Found"})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is True
    assert all(c["method"] == "GET" for c in ctx.upstream.calls)


async def test_a_reply_on_an_UNLINKED_pr_is_refused():
    ctx = _ctx(links=[_ISSUE], responses=[_review_comment(number=9)])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is True
    assert "o/r#9" in res.text


async def test_success_names_where_the_comment_landed():
    url = "https://github.com/o/r/pull/1078#issuecomment-1"
    ctx = _ctx(links=[_PR], responses=[httpx.Response(201, json={"html_url": url})])
    res = await tools.github_comment(body="hi", ctx=ctx)
    assert "o/r#1078" in res.text and url in res.text
