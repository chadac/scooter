"""GitHub uploads: which links become refs, the signed-URL lookup for private repos, and the webhook's use of both."""

from __future__ import annotations

from unittest.mock import AsyncMock

import httpx
import pytest

from scooter_broker_lib import attachments as broker_attachments
from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.types import Identity, Provider
from scooter_lib.attachments import AttachmentRef, FetchError

from scooter_contrib_github import attachments
from scooter_contrib_github import mcp_tools as tools
from scooter_contrib_github import webhooks_handler as gh_h

UUID = "8f2b9c1e-1111-2222-3333-444455556666"
ASSET = f"https://github.com/user-attachments/assets/{UUID}"
SIGNED = f"https://private-user-images.githubusercontent.com/1/2-{UUID}.png?jwt=abc&amp;x=1"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def _parse(text: str) -> list[AttachmentRef]:
    return attachments.parse_refs(text, "o", "r", "comment/5", "github.com")


def test_img_tags_markdown_and_file_links_become_refs():
    text = (
        f'<img width="400" alt="login page" src="{ASSET}" />\n'
        "[build.log](https://github.com/user-attachments/files/123/build.log)\n"
        "![old](https://user-images.githubusercontent.com/9/abc.png)"
    )
    assert [(r.name, r.ref, r.image) for r in _parse(text)] == [
        ("login page", f"gh:o/r:comment/5:github.com/user-attachments/assets/{UUID}", True),
        ("build.log", "gh:o/r:comment/5:github.com/user-attachments/files/123/build.log", False),
        ("old", "gh:o/r:comment/5:user-images.githubusercontent.com/9/abc.png", True),
    ]


def test_other_links_are_not_attachments():
    text = "https://github.com/o/r/pull/3 and ![x](https://imgur.example/a.png) and https://github.com/user-attachments/../settings"
    assert _parse(text) == []


@pytest.mark.parametrize("ref", [
    "gh:o/r:comment/5:github.com/o/r/settings",
    "gh:o/r:comment/5:evil.example/user-attachments/assets/x",
    "gh:o/r:pulls/5:github.com/user-attachments/assets/x",
    "gl:9:abc/x.png",
])
def test_a_ref_that_is_not_an_upload_is_refused(ref):
    with pytest.raises(FetchError):
        attachments.parse_ref(ref, "github.com")


@pytest.fixture
def cdn(monkeypatch):
    """Every client the tool opens talks to a fake CDN that records what it was asked for."""
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("authorization")))
        return httpx.Response(200, content=PNG)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        broker_attachments.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw),
    )
    return seen


class _Upstream:
    def __init__(self, response: httpx.Response):
        self.response = response
        self.calls: list[tuple[str, dict]] = []

    async def request(self, method: str, path: str, **kw) -> httpx.Response:
        self.calls.append((path, kw.get("headers") or {}))
        return self.response


def _ctx(response: httpx.Response) -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id="c", namespace="n", service_account="sa"),
        provider=Provider(name="github", transports=[]),
        upstream=_Upstream(response),
        links=None,
    )


async def test_a_private_upload_is_fetched_through_the_item_s_signed_url(cdn):
    ctx = _ctx(httpx.Response(200, json={"body_html": f'<p><img src="{SIGNED}" alt="x"></p>'}))
    result = await tools.github_attachment(ref=f"gh:o/r:comment/5:github.com/user-attachments/assets/{UUID}", ctx=ctx)
    assert ctx.upstream.calls == [("repos/o/r/issues/comments/5", {"Accept": attachments.FULL_JSON})]
    assert cdn == [(SIGNED.replace("&amp;", "&"), None)]
    assert [c.type for c in result.content] == ["text", "image"]


async def test_without_a_signed_url_the_upload_itself_is_fetched(cdn):
    ctx = _ctx(httpx.Response(200, json={"body_html": "<p>no images</p>"}))
    await tools.github_attachment(ref=f"gh:o/r:review/3/7:github.com/user-attachments/assets/{UUID}", ctx=ctx)
    assert ctx.upstream.calls[0][0] == "repos/o/r/pulls/3/reviews/7"
    assert cdn == [(ASSET, None)]


async def test_a_new_conversation_fetches_its_images_with_the_repo_s_credential(monkeypatch):
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.host == "api.github.com":
            return httpx.Response(200, json={"body_html": f'<img src="{SIGNED}">'})
        return httpx.Response(200, content=PNG)

    real = httpx.AsyncClient
    monkeypatch.setattr(gh_h.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    from scooter_contrib_github import responses
    monkeypatch.setattr(responses, "_headers_for_repo", AsyncMock(return_value={"Authorization": "Bearer inst"}))
    monkeypatch.setattr(responses, "GITHUB_API", "https://api.github.com")

    refs = _parse(f'<img src="{ASSET}">')
    images = await gh_h._first_message_images("o", "r", refs)

    assert [i["mimeType"] for i in images] == ["image/png"]
    assert seen == [("api.github.com", "Bearer inst"), ("private-user-images.githubusercontent.com", None)]


async def test_a_review_comment_forwards_its_refs(monkeypatch):
    forward = AsyncMock()
    monkeypatch.setattr(gh_h, "_forward_or_ignore", forward)
    monkeypatch.setattr(gh_h, "_is_self_authored", AsyncMock(return_value=False))
    await gh_h._handle_review_comment({
        "action": "created",
        "comment": {"id": 11, "body": f"broken here ![s]({ASSET})", "user": {"login": "ann"}, "path": "a.py", "line": 3},
        "pull_request": {"number": 4},
        "repository": {"name": "r", "owner": {"login": "o"}},
    })
    message = forward.await_args.args[1]
    assert f"- s (image), ref: `gh:o/r:review_comment/11:github.com/user-attachments/assets/{UUID}`" in message
    assert message.index("github_attachment(ref)") < message.index("---")
