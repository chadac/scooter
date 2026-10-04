"""GitHub's agent tool (issue #700).

Ported from services/agent-host/test/contract/agentTools.spec.ts with the code. A
handler is a plain async function over a ToolContext, so these need no broker, no HTTP
and no Kubernetes — fakes for `upstream` and `links` are enough.
"""

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
    """Not an edge case: a link posted through the agent-host API (the broker's
    auto-link injector, `link add`) carries only url+title, which is most real rows."""
    ctx = _ctx(links=[_link(url="https://github.com/o/r/pull/7")])
    assert await gate_for("github_comment")(ctx) is True


# --- target resolution ------------------------------------------------------------

async def test_an_INCOMPLETE_ref_falls_back_to_the_url_of_the_SAME_link():
    """Completeness is per link: a ref missing `number` is abandoned WHOLE, and the
    URL of that link is parsed whole. Mixing them produced an owner from one repo and a
    number from another — a comment on an unrelated PR."""
    ctx = _ctx(links=[_link(ref={"owner": "wrong", "repo": "wrong"}, url="https://github.com/right/repo/pull/9")])
    t = await tools.github_target(ctx)
    assert (t.owner, t.repo, t.number) == ("right", "repo", 9)


async def test_the_OLDEST_github_link_wins():
    ctx = _ctx(links=[
        _link(ref={"owner": "o", "repo": "first", "number": 1}),
        _link(ref={"owner": "o", "repo": "second", "number": 2}),
    ])
    assert (await tools.github_target(ctx)).repo == "first"


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

def _graphql(resolved: bool, comment_id: int = 55):
    return httpx.Response(200, json={"data": {"repository": {"pullRequest": {"reviewThreads": {
        "nodes": [{"isResolved": resolved, "comments": {"nodes": [{"databaseId": comment_id}]}}]}}}}})


async def test_a_reply_to_a_RESOLVED_thread_is_refused():
    """GitHub sends NO webhook when a human resolves a thread, so a reply requested
    minutes ago can land on a closed one — which reads as noise on the PR."""
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[_graphql(True), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is True
    assert "RESOLVED" in res.text
    # and it must NOT have posted
    assert all("replies" not in c["path"] for c in ctx.upstream.calls)


async def test_a_reply_to_an_UNRESOLVED_thread_posts_to_the_replies_endpoint():
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[_graphql(False), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is False
    assert ctx.upstream.calls[-1]["path"] == "repos/o/r/pulls/7/comments/55/replies"


async def test_the_guard_FAILS_OPEN_on_a_non_2xx_graphql_response():
    """A missed reply is worse than a stale one: the human asked for it."""
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[httpx.Response(500, text="boom"), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is False


async def test_the_guard_FAILS_OPEN_when_the_thread_is_not_found():
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})],
               responses=[_graphql(True, comment_id=999), httpx.Response(201, json={})])
    res = await tools.github_comment(body="hi", in_reply_to=55, ctx=ctx)
    assert res.is_error is False


async def test_no_graphql_check_when_not_replying_in_a_thread():
    """A PR-level comment needs no resolution check — one fewer API call per comment."""
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})])
    await tools.github_comment(body="hi", ctx=ctx)
    assert all(c["path"] != "graphql" for c in ctx.upstream.calls)


async def test_ctx_is_not_exposed_to_the_model():
    for tool in await tools.mcp.list_tools(run_middleware=False):
        assert "ctx" not in tool.parameters.get("properties", {}), tool.name
