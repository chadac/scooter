"""GitLab's agent tool (issue #700).

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

from scooter_contrib_gitlab import mcp_tools as tools


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
        provider=Provider(name="gitlab", transports=[]),
        upstream=FakeUpstream(responses or [httpx.Response(201, json={"id": 1})]),
        links=FakeLinks(links or []),
    )


def _link(*, ref=None, url="", rtype="merge_request"):
    return {"source": "gitlab", "resourceType": rtype, "url": url, "ref": ref or {}}


async def test_the_gate_is_CLOSED_with_no_gitlab_link():
    assert await gate_for("gitlab_comment")(_ctx()) is False


async def test_the_gate_OPENS_on_a_url_only_link():
    ctx = _ctx(links=[_link(url="https://gitlab.com/g/p/-/merge_requests/3")])
    assert await gate_for("gitlab_comment")(ctx) is True


async def test_comment_posts_to_the_MR_notes_endpoint():
    ctx = _ctx(links=[_link(ref={"projectId": "g/p", "mrIid": "3"})])
    res = await tools.gitlab_comment(body="hi", ctx=ctx)
    assert res.is_error is False
    assert ctx.upstream.calls[0]["path"] == "api/v4/projects/g%2Fp/merge_requests/3/notes"


async def test_an_ISSUE_link_posts_to_the_ISSUES_endpoint():
    ctx = _ctx(links=[_link(ref={"projectId": "g/p", "iid": "3"}, rtype="issue")])
    await tools.gitlab_comment(body="hi", ctx=ctx)
    assert ctx.upstream.calls[0]["path"] == "api/v4/projects/g%2Fp/issues/3/notes"


async def test_resourceType_WINS_over_the_ref_field_the_iid_landed_in():
    """THE #563 bug: webhooks wrote an issue's iid into `mrIid`. A reader trusting the
    field would comment on the MERGE REQUEST of that number — a different object."""
    ctx = _ctx(links=[_link(ref={"projectId": "g/p", "mrIid": "3"}, rtype="issue")])
    await tools.gitlab_comment(body="hi", ctx=ctx)
    assert "/issues/3/" in ctx.upstream.calls[0]["path"]


async def test_an_UNRECOGNISED_resourceType_falls_back_to_the_ref_field():
    ctx = _ctx(links=[_link(ref={"projectId": "g/p", "mrIid": "3"}, rtype="weird")])
    await tools.gitlab_comment(body="hi", ctx=ctx)
    assert "/merge_requests/3/" in ctx.upstream.calls[0]["path"]


async def test_the_broker_auto_link_spelling_mr_is_understood():
    ctx = _ctx(links=[_link(ref={"projectId": "g/p", "mrIid": "3"}, rtype="mr")])
    await tools.gitlab_comment(body="hi", ctx=ctx)
    assert "/merge_requests/3/" in ctx.upstream.calls[0]["path"]


async def test_a_discussion_id_replies_in_the_discussion():
    ctx = _ctx(links=[_link(ref={"projectId": "g/p", "mrIid": "3"})])
    await tools.gitlab_comment(body="hi", discussion_id="abc/def", ctx=ctx)
    assert ctx.upstream.calls[0]["path"].endswith("/discussions/abc%2Fdef/notes")


async def test_comment_with_no_target_is_an_error():
    res = await tools.gitlab_comment(body="hi", ctx=_ctx())
    assert res.is_error is True


async def test_comment_surfaces_a_failure_VERBATIM():
    ctx = _ctx(links=[_link(ref={"projectId": "g/p", "mrIid": "3"})],
               responses=[httpx.Response(403, text="forbidden")])
    res = await tools.gitlab_comment(body="hi", ctx=ctx)
    assert res.is_error is True and "forbidden" in res.text
