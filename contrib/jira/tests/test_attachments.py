"""Jira attachments: names in wiki markup become id refs, the tool checks size before downloading, and a comment forwards its refs."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.types import Identity, Provider
from scooter_lib.attachments import AttachmentRef, FetchError

from scooter_contrib_jira import attachments
from scooter_contrib_jira import mcp_tools as tools
from scooter_contrib_jira import webhooks_handler as jira_h
from scooter_webhooks_lib.agent_host_client import SendOutcome

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def _att(id_: str, name: str, created: str = "2026-11-01T10:00:00.000+0000") -> dict:
    return {"id": id_, "filename": name, "created": created, "size": 10}


def test_embeds_and_links_are_found_and_prose_is_not():
    text = "Hi! thanks! See !shot.png|thumbnail! and [^build.log], and !https://x.example/a.png!"
    assert attachments.referenced_names(text) == ["shot.png", "build.log"]


def test_a_shared_name_resolves_to_the_newest_file_up_to_the_comment():
    files = [
        _att("1", "shot.png", "2026-11-01T10:00:00.000+0000"),
        _att("2", "shot.png", "2026-11-02T10:00:00.000+0000"),
        _att("3", "shot.png", "2026-11-09T10:00:00.000+0000"),
    ]
    refs = attachments.match(["shot.png", "missing.txt"], files, before="2026-11-05T00:00:00.000+0000")
    assert [(r.name, r.ref, r.image) for r in refs] == [("shot.png", "jira:2", True)]


def test_a_label_start_lists_every_attachment_newest_first():
    files = [_att("1", "old.log", "2026-11-01T10:00:00.000+0000"), _att("2", "new.png", "2026-11-03T10:00:00.000+0000")]
    assert [r.ref for r in attachments.all_refs(files)] == ["jira:2", "jira:1"]


class _Upstream:
    def __init__(self, responses: dict[str, httpx.Response]):
        self.responses = responses
        self.paths: list[str] = []

    async def request(self, method: str, path: str, **_kw) -> httpx.Response:
        self.paths.append(path)
        return self.responses[path]


def _resp(status: int, **kw) -> httpx.Response:
    return httpx.Response(status, request=httpx.Request("GET", "https://api.atlassian.com/ex/jira/c/x"), **kw)


def _ctx(responses: dict[str, httpx.Response]) -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id="c", namespace="n", service_account="sa"),
        provider=Provider(name="jira", transports=[]),
        upstream=_Upstream(responses),
        links=None,
    )


async def test_the_tool_reads_metadata_then_content():
    ctx = _ctx({
        "rest/api/3/attachment/7": _resp(200, json={"filename": "shot.png", "size": len(PNG)}),
        "rest/api/3/attachment/content/7": _resp(200, content=PNG),
    })
    result = await tools.jira_attachment(ref="jira:7", ctx=ctx)
    assert [c.type for c in result.content] == ["text", "image"]
    assert result.content[0].text.startswith("shot.png")


async def test_an_oversize_file_is_refused_without_downloading_it():
    ctx = _ctx({"rest/api/3/attachment/7": _resp(200, json={"filename": "dump.bin", "size": 50 * 1024 * 1024})})
    result = await tools.jira_attachment(ref="jira:7", ctx=ctx)
    assert result.is_error and "over the 10 MB limit" in result.text
    assert ctx.upstream.paths == ["rest/api/3/attachment/7"]


async def test_a_malformed_ref_is_refused():
    result = await tools.jira_attachment(ref="jira:7/../../issue", ctx=_ctx({}))
    assert result.is_error and "not a Jira attachment ref" in result.text


def _comment_payload(body: str) -> dict:
    return {
        "comment": {"body": body, "author": {"displayName": "Ann", "accountId": "a1"}, "created": "2026-11-05T00:00:00.000+0000"},
        "issue": {"key": "ENG-1", "fields": {"summary": "Broken", "attachment": [_att("9", "shot.png")]}},
    }


async def test_a_comment_on_a_linked_issue_forwards_its_refs():
    db = AsyncMock()
    db.lookup_conversation.return_value = "conv-1"
    deliver = AsyncMock(return_value=SendOutcome.DELIVERED)
    with (
        patch.object(jira_h, "db", new=db),
        patch.object(jira_h, "deliver_message", new=deliver),
        patch.object(jira_h, "sender_of", new=AsyncMock(return_value=None)),
        patch.object(jira_h, "_is_own_comment", return_value=False),
    ):
        await jira_h._handle_comment(_comment_payload("see !shot.png|thumbnail!"))
    message = deliver.await_args.args[1]
    assert "- shot.png (image), ref: `jira:9`" in message
    assert "jira_attachment(ref)" in message


async def test_a_new_conversation_fetches_its_images_with_the_bearer(monkeypatch):
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("authorization")))
        if request.url.path.endswith("/attachment/9"):
            return httpx.Response(200, json={"filename": "shot.png", "size": len(PNG)})
        return httpx.Response(200, content=PNG)

    real = httpx.AsyncClient
    monkeypatch.setattr(jira_h.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(jira_h, "_headers", AsyncMock(return_value={"Authorization": "Bearer t", "Accept": "application/json"}))
    monkeypatch.setattr(jira_h, "_api_base", lambda: "https://api.atlassian.com/ex/jira/c/rest/api/3")

    images = await jira_h._first_message_images([AttachmentRef("shot.png", "jira:9", image=True)])

    assert [i["mimeType"] for i in images] == ["image/png"]
    assert seen == [
        ("/ex/jira/c/rest/api/3/attachment/9", "Bearer t"),
        ("/ex/jira/c/rest/api/3/attachment/content/9", "Bearer t"),
    ]


def test_ref_parsing_rejects_other_forges():
    with pytest.raises(FetchError):
        attachments._id("gl:9:abc/a.png")
