"""Confluence's tools over a fake upstream, and the storage <-> Markdown conversion they edit through."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_atlassian import confluence as tools
from scooter_contrib_atlassian.storage import (
    EditError,
    apply_edits,
    lossy_elements,
    markdown_to_storage,
    storage_to_markdown,
)

BASE = "https://acme.atlassian.net/wiki"


@dataclass
class FakeUpstream:
    responses: list[httpx.Response]
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        self.calls.append({"method": method, "path": path, **kw})
        return self.responses.pop(0)


@dataclass
class FakeLinks:
    rows: list[dict[str, Any]]

    async def list(self) -> list[dict[str, Any]]:
        return self.rows


def _ctx(*responses: httpx.Response, links=None) -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id="conv-1", namespace="ns", service_account="sa"),
        provider=Provider(name="atlassian", transports=[]),
        upstream=FakeUpstream(list(responses)),
        links=FakeLinks(links or []),
    )


def _page(storage: str, *, version: int = 3, title: str = "Runbook") -> httpx.Response:
    return httpx.Response(200, json={
        "id": "42", "title": title, "version": {"number": version},
        "body": {"storage": {"value": storage}},
        "_links": {"base": BASE, "webui": "/spaces/ENG/pages/42/Runbook"},
    })


@pytest.fixture(autouse=True)
def site(monkeypatch):
    monkeypatch.setenv("ATLASSIAN_SITE_URL", "https://acme.atlassian.net")
    monkeypatch.setenv("AGENT_HOST_URL", "http://agent-host")


@pytest.fixture
def posted(monkeypatch):
    links: list = []

    async def post_link(url, conversation_id, link):
        links.append((url, conversation_id, link))

    monkeypatch.setattr(tools, "post_link", post_link)
    return links


# --- page refs and URLs ---

@pytest.mark.parametrize("ref,want", [
    ("42", "42"),
    (" 42 ", "42"),
    (f"{BASE}/spaces/ENG/pages/42/Runbook", "42"),
    (f"{BASE}/pages/viewpage.action?pageId=42", "42"),
    (f"{BASE}/x/AbCd", None),
    ("Runbook", None),
])
def test_page_id(ref, want):
    assert tools.page_id(ref) == want


def test_page_url_falls_back_to_the_site_without_a_base():
    assert tools.page_url({"_links": {"webui": "/spaces/ENG/pages/7"}}, "https://acme.atlassian.net/") \
        == "https://acme.atlassian.net/wiki/spaces/ENG/pages/7"
    assert tools.page_url({"_links": {"webui": "/spaces/ENG/pages/7"}}) is None


# --- conversion ---

def test_markdown_becomes_storage_with_code_macros_and_escaped_html():
    st = markdown_to_storage("# T\n\nline<br>\n\n```py\nif a]]>b: pass\n```\n")
    assert "<h1>T</h1>" in st
    assert "&lt;br&gt;" in st
    assert '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">py</ac:parameter>' in st
    assert "<![CDATA[if a]]]]><![CDATA[>b: pass]]>" in st


def test_markdown_round_trips_through_storage():
    md = "# T\n\nSome *em*, **bold** and `code`.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```python\nx = 1 < 2\n```\n"
    st = markdown_to_storage(md)
    assert storage_to_markdown(st) == md
    assert markdown_to_storage(storage_to_markdown(st)) == st


def test_lossy_elements_skip_the_code_macro():
    assert lossy_elements(markdown_to_storage("```\nx\n```")) == []
    assert lossy_elements(
        '<ac:layout><ac:layout-section/></ac:layout><ac:structured-macro ac:name="toc"/>'
        '<ac:structured-macro ac:name="toc"/>'
    ) == ["ac:layout", "ac:layout-section", "ac:structured-macro toc"]


def test_edits_must_match_exactly_once():
    assert apply_edits("a b c", [("b", "B"), ("c", "C")]) == "a B C"
    with pytest.raises(EditError) as e:
        apply_edits("a a", [("a", "x")])
    assert e.value.matches == 2
    with pytest.raises(EditError) as e:
        apply_edits("a b", [("b", "B"), ("zz", "y")])
    assert (e.value.index, e.value.matches) == (1, 0)


# --- tools ---

async def test_search_lists_results_with_urls():
    ctx = _ctx(httpx.Response(200, json={
        "_links": {"base": BASE}, "totalSize": 1,
        "results": [{"content": {"id": "42", "type": "page"}, "title": "Runbook",
                     "resultGlobalContainer": {"title": "Eng"}, "url": "/spaces/ENG/pages/42",
                     "friendlyLastModified": "yesterday"}],
    }))
    result = await tools.confluence_search(cql='text ~ "runbook"', limit=500, ctx=ctx)
    assert not result.is_error
    assert f"42 | page | Runbook | Eng | yesterday | {BASE}/spaces/ENG/pages/42" in result.text
    call = ctx.upstream.calls[0]
    assert call["path"] == "wiki/rest/api/search"
    assert call["params"] == {"cql": 'text ~ "runbook"', "limit": 100}


async def test_get_page_as_markdown_names_what_it_drops():
    ctx = _ctx(_page('<p>Hi</p><ac:structured-macro ac:name="toc"/>'))
    result = await tools.confluence_get_page(page="42", ctx=ctx)
    assert "# Runbook" in result.text and "version 3" in result.text
    assert f"{BASE}/spaces/ENG/pages/42/Runbook" in result.text
    assert "Not shown in Markdown: ac:structured-macro toc" in result.text
    assert result.text.rstrip().endswith("Hi")
    assert ctx.upstream.calls[0]["params"] == {"body-format": "storage"}


async def test_get_page_as_storage_is_verbatim():
    ctx = _ctx(_page('<p>Hi</p><ac:structured-macro ac:name="toc"/>'))
    result = await tools.confluence_get_page(page="42", format="storage", ctx=ctx)
    assert result.text.endswith('<p>Hi</p><ac:structured-macro ac:name="toc"/>')


async def test_upstream_errors_pass_through():
    ctx = _ctx(httpx.Response(404, text="no such page"))
    result = await tools.confluence_get_page(page="42", ctx=ctx)
    assert result.is_error and "HTTP 404" in result.text and "no such page" in result.text


async def test_create_resolves_the_space_converts_markdown_and_links_the_page(posted):
    ctx = _ctx(
        httpx.Response(200, json={"results": [{"id": "9001", "key": "ENG"}]}),
        httpx.Response(200, json={"id": "77", "title": "Plan", "_links": {"webui": "/spaces/ENG/pages/77/Plan"}}),
    )
    result = await tools.confluence_create_page(space="ENG", title="Plan", body="**hi**", parent=f"{BASE}/spaces/ENG/pages/5/P", ctx=ctx)
    assert not result.is_error
    spaces, create = ctx.upstream.calls
    assert spaces["params"] == {"keys": "ENG"}
    assert create["method"] == "POST" and create["path"] == "wiki/api/v2/pages"
    assert create["json"] == {"status": "current", "title": "Plan", "spaceId": "9001", "parentId": "5",
                              "body": {"representation": "storage", "value": "<p><strong>hi</strong></p>"}}
    ((host, conv, link),) = posted
    assert (host, conv) == ("http://agent-host", "conv-1")
    assert (link.source, link.resource_type, link.title) == ("atlassian-confluence", "page", "Plan")
    assert link.url == f"{BASE}/spaces/ENG/pages/77/Plan"


async def test_create_in_an_unknown_space_writes_nothing(posted):
    ctx = _ctx(httpx.Response(200, json={"results": []}))
    result = await tools.confluence_create_page(space="NOPE", title="t", body="b", ctx=ctx)
    assert result.is_error and "NOPE" in result.text
    assert len(ctx.upstream.calls) == 1 and posted == []


async def test_markdown_edits_bump_the_version_and_keep_the_rest():
    ctx = _ctx(_page(markdown_to_storage("# Steps\n\n- restart the pod\n- check logs\n")),
               httpx.Response(200, json={"_links": {"base": BASE, "webui": "/spaces/ENG/pages/42"}}))
    result = await tools.confluence_update_page(
        page="42", edits=[tools.Edit(old="restart the pod", new="restart the **deployment**")],
        message="clarify", ctx=ctx,
    )
    assert not result.is_error and "version 4" in result.text
    put = ctx.upstream.calls[1]
    assert put["method"] == "PUT" and put["path"] == "wiki/api/v2/pages/42"
    assert put["json"]["version"] == {"number": 4, "message": "clarify"}
    assert put["json"]["title"] == "Runbook"
    assert put["json"]["body"]["value"] == markdown_to_storage("# Steps\n\n- restart the **deployment**\n- check logs\n")


async def test_markdown_edits_refuse_a_page_with_macros():
    ctx = _ctx(_page('<p>a</p><ac:structured-macro ac:name="jira"/>'))
    result = await tools.confluence_update_page(page="42", edits=[tools.Edit(old="a", new="b")], ctx=ctx)
    assert result.is_error and "format=\"storage\"" in result.text
    assert len(ctx.upstream.calls) == 1


async def test_storage_edits_leave_macros_untouched():
    storage = '<p>a</p><ac:structured-macro ac:name="jira"/>'
    ctx = _ctx(_page(storage), httpx.Response(200, json={}))
    result = await tools.confluence_update_page(
        page="42", edits=[tools.Edit(old="<p>a</p>", new="<p>b</p>")], format="storage", ctx=ctx,
    )
    assert not result.is_error
    assert ctx.upstream.calls[1]["json"]["body"]["value"] == '<p>b</p><ac:structured-macro ac:name="jira"/>'


async def test_an_ambiguous_edit_writes_nothing():
    ctx = _ctx(_page("<p>a</p><p>a</p>"))
    result = await tools.confluence_update_page(page="42", edits=[tools.Edit(old="a", new="b")], ctx=ctx)
    assert result.is_error and "2 matches" in result.text
    assert len(ctx.upstream.calls) == 1


async def test_a_conflict_says_to_re_read():
    ctx = _ctx(_page("<p>a</p>"), httpx.Response(409, text="version conflict"))
    result = await tools.confluence_update_page(page="42", body="new", ctx=ctx)
    assert result.is_error and "version conflict" in result.text and "Re-read" in result.text


async def test_update_takes_edits_or_body_not_both():
    result = await tools.confluence_update_page(page="42", edits=[tools.Edit(old="a", new="b")], body="x", ctx=_ctx())
    assert result.is_error and "not both" in result.text


async def test_a_title_alone_renames():
    ctx = _ctx(_page("<p>a</p>"), httpx.Response(200, json={}))
    await tools.confluence_update_page(page="42", title="New", ctx=ctx)
    assert ctx.upstream.calls[1]["json"]["title"] == "New"
    assert ctx.upstream.calls[1]["json"]["body"]["value"] == "<p>a</p>"


async def test_comment_defaults_to_the_linked_page():
    ctx = _ctx(httpx.Response(201, json={}), links=[
        {"source": "jira", "url": "https://acme.atlassian.net/browse/ENG-1"},
        {"source": "atlassian-confluence", "url": f"{BASE}/spaces/ENG/pages/42/Runbook"},
    ])
    result = await tools.confluence_comment(body="LGTM", ctx=ctx)
    assert not result.is_error
    call = ctx.upstream.calls[0]
    assert call["path"] == "wiki/api/v2/footer-comments"
    assert call["json"] == {"pageId": "42", "body": {"representation": "storage", "value": "<p>LGTM</p>"}}


async def test_comment_without_a_page_or_link_fails():
    result = await tools.confluence_comment(body="x", ctx=_ctx())
    assert result.is_error and "no Confluence page linked" in result.text
