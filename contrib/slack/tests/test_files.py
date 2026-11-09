"""Slack attachment download: the `files` array is fetched via the bot token, size-capped, and split into images, inlined text and binary parts."""

import base64

import httpx
import pytest

import scooter_contrib_slack.files as sf
from scooter_contrib_slack.config import settings

pytestmark = pytest.mark.asyncio


def _patch(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(sf.httpx, "AsyncClient", factory)


def _img_file(url="https://files.slack.com/a.png", mimetype="image/png", size=None):
    f = {"mimetype": mimetype, "url_private_download": url, "name": "a.png"}
    if size is not None:
        f["size"] = size
    return f


async def test_downloads_an_image_as_base64(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["auth"] = req.headers.get("authorization")
        return httpx.Response(200, content=b"\x89PNGdata")

    _patch(monkeypatch, handler)
    out = await sf.download_images([_img_file()])
    assert out == [{"data": base64.b64encode(b"\x89PNGdata").decode(), "mimeType": "image/png"}]
    assert captured["auth"] == "Bearer xoxb-123"


async def test_skips_non_image_files(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"x"))
    out = await sf.download_images([_img_file(mimetype="application/pdf")])
    assert out == []


async def test_skips_oversize_by_declared_size(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    monkeypatch.setattr(settings, "image_max_bytes", 100, raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"x"))
    out = await sf.download_images([_img_file(size=101)])
    assert out == []


async def test_skips_oversize_by_downloaded_bytes(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    monkeypatch.setattr(settings, "image_max_bytes", 4, raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"toolong"))
    out = await sf.download_images([_img_file()])
    assert out == []


async def test_skips_a_failed_download_without_raising(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(403))
    out = await sf.download_images([_img_file()])
    assert out == []


async def test_no_token_returns_empty(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "", raising=False)
    out = await sf.download_images([_img_file()])
    assert out == []


async def test_no_files_returns_empty(monkeypatch):
    assert await sf.download_images(None) == []
    assert await sf.download_images([]) == []


# --- download_files: the 3-way split (images / text-inline / binary) ----------


def _file(name, mimetype="", url="https://files.slack.com/f", size=None, **extra):
    f = {"name": name, "mimetype": mimetype, "url_private_download": url}
    if size is not None:
        f["size"] = size
    f.update(extra)
    return f


async def test_text_file_is_inlined_with_fence_and_filename(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"print('hi')\n"))
    out = await sf.download_files([_file("foo.py", mimetype="text/x-python")])
    assert out.images == []
    assert out.file_parts == []
    assert "[Attached file: foo.py]" in out.inline_text
    assert "```python" in out.inline_text
    assert "print('hi')" in out.inline_text


async def test_text_file_by_extension_when_mimetype_missing(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"key: value\n"))
    out = await sf.download_files([_file("cfg.yaml", mimetype="application/octet-stream")])
    assert "[Attached file: cfg.yaml]" in out.inline_text
    assert "```yaml" in out.inline_text


async def test_binary_file_becomes_a_file_part(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"%PDF-1.4"))
    out = await sf.download_files([_file("doc.pdf", mimetype="application/pdf")])
    assert out.inline_text == ""
    assert out.images == []
    assert out.file_parts == [
        {
            "name": "doc.pdf",
            "data": base64.b64encode(b"%PDF-1.4").decode(),
            "mimeType": "application/pdf",
        }
    ]


async def test_images_still_work_via_download_files(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"\x89PNG"))
    out = await sf.download_files([_file("a.png", mimetype="image/png")])
    assert out.images == [{"data": base64.b64encode(b"\x89PNG").decode(), "mimeType": "image/png"}]
    assert out.inline_text == ""
    assert out.file_parts == []


async def test_oversize_file_is_skipped_by_declared_size(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    monkeypatch.setattr(settings, "file_max_bytes", 100, raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"x"))
    out = await sf.download_files([_file("big.pdf", mimetype="application/pdf", size=101)])
    assert out.file_parts == []


async def test_failed_download_is_skipped_without_raising(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(403))
    out = await sf.download_files([_file("doc.pdf", mimetype="application/pdf")])
    assert out.file_parts == [] and out.images == [] and out.inline_text == ""


async def test_slack_snippet_is_inlined(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"a snippet"))
    out = await sf.download_files(
        [_file("snippet", mimetype="", mode="snippet", filetype="text")]
    )
    assert "[Attached file: snippet]" in out.inline_text
    assert "a snippet" in out.inline_text


async def test_mixed_attachments_split_three_ways(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)

    def handler(req):
        url = str(req.url)
        if url.endswith("img"):
            return httpx.Response(200, content=b"\x89PNG")
        if url.endswith("txt"):
            return httpx.Response(200, content=b"hello")
        return httpx.Response(200, content=b"BINARY")

    _patch(monkeypatch, handler)
    out = await sf.download_files(
        [
            _file("a.png", mimetype="image/png", url="https://x/img"),
            _file("notes.txt", mimetype="text/plain", url="https://x/txt"),
            _file("z.zip", mimetype="application/zip", url="https://x/bin"),
        ]
    )
    assert len(out.images) == 1
    assert "[Attached file: notes.txt]" in out.inline_text and "hello" in out.inline_text
    assert len(out.file_parts) == 1 and out.file_parts[0]["name"] == "z.zip"


async def test_download_files_no_token_returns_empty(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "", raising=False)
    out = await sf.download_files([_file("doc.pdf", mimetype="application/pdf")])
    assert out.images == [] and out.file_parts == [] and out.inline_text == ""


# --- skipped files: each one is listed so the message can say so -------------


async def test_oversize_file_is_listed_with_its_url(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    monkeypatch.setattr(settings, "file_max_bytes", 1024 * 1024, raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"x"))
    out = await sf.download_files(
        [_file("demo.mov", mimetype="video/quicktime", url="https://files.slack.com/demo", size=3 * 1024 * 1024)]
    )
    assert out.notice == (
        "[Attachment not forwarded: demo.mov (video/quicktime, 3.0 MB): over the 1.0 MB limit."
        " URL: https://files.slack.com/demo]"
    )


async def test_oversize_by_downloaded_size_reports_the_real_size(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    monkeypatch.setattr(settings, "file_max_bytes", 2048, raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"x" * 4096))
    out = await sf.download_files([_file("doc.pdf", mimetype="application/pdf")])
    assert out.file_parts == []
    assert [(s.size, s.reason) for s in out.skipped] == [(4096, "over the 2 KB limit")]


async def test_failed_download_is_listed(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(403))
    out = await sf.download_files([_file("doc.pdf", mimetype="application/pdf")])
    assert [s.reason for s in out.skipped] == ["the download failed"]


async def test_file_parts_past_the_per_message_limit_are_listed(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    monkeypatch.setattr(settings, "file_max_per_message", 2, raising=False)
    fetched = []

    def handler(req):
        fetched.append(str(req.url))
        return httpx.Response(200, content=b"BIN")

    _patch(monkeypatch, handler)
    out = await sf.download_files(
        [_file(f"{i}.zip", mimetype="application/zip", url=f"https://x/{i}") for i in range(3)]
        + [_file("a.png", mimetype="image/png", url="https://x/img")]
    )
    assert [p["name"] for p in out.file_parts] == ["0.zip", "1.zip"]
    assert len(out.images) == 1
    assert [(s.name, s.reason) for s in out.skipped] == [("2.zip", "more than 2 files in one message")]
    assert "https://x/2" not in fetched


async def test_without_a_token_every_file_is_listed(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "", raising=False)
    out = await sf.download_files([_file("a.pdf"), _file("b.png", mimetype="image/png")])
    assert [s.name for s in out.skipped] == ["a.pdf", "b.png"]


def test_notice_line_without_type_or_size():
    s = sf.Skipped(name="x", mimetype="", size=None, reason="the download failed", url="")
    assert s.line() == "[Attachment not forwarded: x: the download failed.]"


# --- files.info fallback ------------------------------------------------------


async def test_file_without_url_is_looked_up_via_files_info(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    seen = []

    def handler(req):
        seen.append((req.url.path, req.url.params.get("file"), req.headers.get("authorization")))
        if req.url.path == "/api/files.info":
            return httpx.Response(
                200,
                json={"ok": True, "file": {"id": "F1", "name": "doc.pdf", "mimetype": "application/pdf",
                                           "url_private_download": "https://files.slack.com/F1/doc.pdf"}},
            )
        return httpx.Response(200, content=b"PDF")

    _patch(monkeypatch, handler)
    out = await sf.download_files([{"id": "F1", "file_access": "check_file_info"}])
    assert seen == [("/api/files.info", "F1", "Bearer xoxb-123"), ("/F1/doc.pdf", None, "Bearer xoxb-123")]
    assert [p["name"] for p in out.file_parts] == ["doc.pdf"]
    assert out.skipped == []


async def test_files_info_failure_lists_the_file(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, json={"ok": False, "error": "file_not_found"}))
    out = await sf.download_files([{"id": "F1", "name": "doc.pdf", "permalink": "https://x.slack.com/files/F1"}])
    assert out.notice == (
        "[Attachment not forwarded: doc.pdf: Slack gave no download link. URL: https://x.slack.com/files/F1]"
    )
