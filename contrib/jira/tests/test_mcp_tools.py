"""Jira's agent tool (issue #700).

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

from scooter_contrib_jira import mcp_tools as tools


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
        provider=Provider(name="jira", transports=[]),
        upstream=FakeUpstream(responses or [httpx.Response(201, json={"id": 1})]),
        links=FakeLinks(links or []),
    )


def _link(*, ref=None, url=""):
    return {"source": "jira", "resourceType": "issue", "url": url, "ref": ref or {}}


async def test_the_gate_is_CLOSED_with_no_jira_link():
    assert await gate_for("jira_comment")(_ctx()) is False


async def test_the_gate_OPENS_on_a_ref_issue_key():
    assert await gate_for("jira_comment")(_ctx(links=[_link(ref={"issueKey": "ENG-1"})])) is True


async def test_the_gate_OPENS_on_a_browse_url():
    ctx = _ctx(links=[_link(url="https://acme.atlassian.net/browse/ENG-1")])
    assert await gate_for("jira_comment")(ctx) is True


async def test_comment_posts_to_rest_v2():
    """v2, not v3: v2 accepts a plain-text `body` where v3 requires ADF."""
    ctx = _ctx(links=[_link(ref={"issueKey": "ENG-1"})])
    res = await tools.jira_comment(body="hi", ctx=ctx)
    assert res.is_error is False
    assert ctx.upstream.calls[0]["path"] == "rest/api/2/issue/ENG-1/comment"
    assert ctx.upstream.calls[0]["json"] == {"body": "hi"}


async def test_comment_with_no_target_is_an_error():
    res = await tools.jira_comment(body="hi", ctx=_ctx())
    assert res.is_error is True


async def test_comment_surfaces_a_failure_VERBATIM():
    ctx = _ctx(links=[_link(ref={"issueKey": "ENG-1"})],
               responses=[httpx.Response(404, text="issue does not exist")])
    res = await tools.jira_comment(body="hi", ctx=ctx)
    assert res.is_error is True and "issue does not exist" in res.text


# --- the conversation_map fallback (issue #700) ------------------------------------

async def test_a_BARE_issue_key_resolves():
    """jira's conversation_map resource_id IS the key, where a resource_links row holds
    the browse URL. The broker feeds both through the link's `url`, so both must work."""
    ctx = _ctx(links=[_link(url="ENG-12")])
    assert (await tools.jira_target(ctx)).issue_key == "ENG-12"


async def test_a_bare_key_is_upcased():
    assert (await tools.jira_target(_ctx(links=[_link(url="eng-12")]))).issue_key == "ENG-12"


async def test_a_non_key_string_does_NOT_resolve():
    """A garbage mapping row must be skipped, not turned into a wrong issue key."""
    assert await tools.jira_target(_ctx(links=[_link(url="just some text")])) is None


async def test_a_real_link_WINS_over_the_appended_mapping_row():
    """The broker appends mapping rows AFTER the real links, and first_target takes the
    first complete target — so position is the whole precedence rule."""
    ctx = _ctx(links=[_link(ref={"issueKey": "REAL-1"}), _link(url="FALLBACK-2")])
    assert (await tools.jira_target(ctx)).issue_key == "REAL-1"
