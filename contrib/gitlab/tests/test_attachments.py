"""GitLab uploads: which links become refs, what the tool returns, and the images a new conversation starts with."""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.types import Identity, Provider
from scooter_lib.attachments import AttachmentRef, FetchError

from scooter_contrib_gitlab import attachments
from scooter_contrib_gitlab import mcp_tools as tools
from scooter_contrib_gitlab import webhooks_handler as gitlab_h
from scooter_contrib_gitlab.config import settings

SECRET = "0123456789abcdef0123456789abcdef"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def _refs(text: str) -> list[str]:
    return [r.ref for r in attachments.parse_refs(text, 9, "gitlab.example")]


def test_relative_uploads_resolve_against_the_note_s_project():
    refs = attachments.parse_refs(f"![a shot](/uploads/{SECRET}/my%20shot.png)", 9, "gitlab.example")
    assert [(r.name, r.ref, r.image) for r in refs] == [
        ("my shot.png", f"gl:9:{SECRET}/my%20shot.png", True),
    ]


def test_absolute_uploads_on_this_host_keep_their_project():
    text = (
        f"[log](https://gitlab.example/group/sub/proj/uploads/{SECRET}/build.log) and "
        f"![x](https://gitlab.example/-/project/42/uploads/{SECRET}/x.png)"
    )
    assert _refs(text) == [f"gl:group%2Fsub%2Fproj:{SECRET}/build.log", f"gl:42:{SECRET}/x.png"]


def test_uploads_on_another_host_are_left_as_links():
    text = (
        f"https://other.example/g/p/uploads/{SECRET}/a.png "
        f"https://other.example/-/project/1/uploads/{SECRET}/b.png"
    )
    assert _refs(text) == []


def test_a_repeated_upload_is_listed_once():
    assert _refs(f"/uploads/{SECRET}/a.png then /uploads/{SECRET}/a.png") == [f"gl:9:{SECRET}/a.png"]


@pytest.mark.parametrize("ref", [
    "gl:9:nothex/a.png",
    f"gl:9:{SECRET}/../../user",
    f"gl:9:{SECRET}/a/b.png",
    f"gh:9:{SECRET}/a.png",
])
def test_a_malformed_ref_is_refused_before_any_request(ref):
    with pytest.raises(FetchError):
        attachments.api_path(ref)


class _Upstream:
    def __init__(self, response: httpx.Response):
        self.response = response
        self.paths: list[str] = []

    async def request(self, method: str, path: str, **_kw) -> httpx.Response:
        self.paths.append(path)
        return self.response


def _ctx(status: int, content: bytes = b"", content_type: str = "application/octet-stream") -> ToolContext:
    response = httpx.Response(
        status, content=content, headers={"content-type": content_type},
        request=httpx.Request("GET", "https://gitlab.example/api/v4/x"),
    )
    return ToolContext(
        identity=Identity(conversation_id="c", namespace="n", service_account="sa"),
        provider=Provider(name="gitlab", transports=[]),
        upstream=_Upstream(response),
        links=None,
    )


async def test_the_tool_shows_an_image_through_the_uploads_api():
    ctx = _ctx(200, PNG)
    result = await tools.gitlab_attachment(ref=f"gl:9:{SECRET}/shot.png", ctx=ctx)
    assert ctx.upstream.paths == [f"api/v4/projects/9/uploads/{SECRET}/shot.png"]
    assert [c.type for c in result.content] == ["text", "image"]
    assert result.content[1].mimeType == "image/png"


async def test_the_tool_inlines_text_and_offers_a_download_for_binaries():
    text = await tools.gitlab_attachment(ref=f"gl:9:{SECRET}/build.log", ctx=_ctx(200, b"FAIL line 3\n"))
    assert "FAIL line 3" in text.text
    binary = await tools.gitlab_attachment(ref=f"gl:9:{SECRET}/core.bin", ctx=_ctx(200, b"\x00\x01"))
    assert "binary file" in binary.text
    assert "curl -fsSL -o '/workspace/uploads/core.bin' 'https://gitlab.example/api/v4/x'" in binary.text


async def test_the_tool_reports_a_missing_upload():
    result = await tools.gitlab_attachment(ref=f"gl:9:{SECRET}/gone.png", ctx=_ctx(404))
    assert result.is_error
    assert "not found" in result.text


async def test_a_new_conversation_starts_with_its_images(monkeypatch):
    monkeypatch.setattr(settings, "gitlab_host", "gitlab.example")
    monkeypatch.setattr(settings, "gitlab_token", "glpat")
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("private-token")))
        return httpx.Response(200, content=PNG)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        gitlab_h.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw),
    )
    refs = [
        AttachmentRef("a.png", f"gl:9:{SECRET}/a.png", image=True),
        AttachmentRef("b.log", f"gl:9:{SECRET}/b.log", image=False),
    ]
    images = await gitlab_h._first_message_images(refs)
    assert [i["mimeType"] for i in images] == ["image/png"]
    assert seen == [(f"/api/v4/projects/9/uploads/{SECRET}/a.png", "glpat")]


async def test_a_broken_image_fetch_never_stops_the_conversation(monkeypatch):
    async def boom(*_a, **_k):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(gitlab_h.attachments, "fetch", boom)
    monkeypatch.setattr(gitlab_h, "inline_images", boom)
    assert await gitlab_h._first_message_images([AttachmentRef("a.png", f"gl:9:{SECRET}/a.png", image=True)]) == []
