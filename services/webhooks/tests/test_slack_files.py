"""Slack image download (multimodal, stage 5): the `files` array on a Slack message
is downloaded via the bot token, size-capped + MIME-filtered, and returned base64
for the /agui multimodal content parts. Best-effort: a bad/oversize/non-image file
is skipped, never raised."""

import base64

import httpx
import pytest

import webhooks.handlers.slack_files as sf
from webhooks.config import settings

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
    # The private URL is fetched with the bot token.
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
    assert out == []  # skipped early, never downloaded


async def test_skips_oversize_by_downloaded_bytes(monkeypatch):
    monkeypatch.setattr(settings, "slack_bot_token", "xoxb-123", raising=False)
    monkeypatch.setattr(settings, "image_max_bytes", 4, raising=False)
    _patch(monkeypatch, lambda req: httpx.Response(200, content=b"toolong"))
    out = await sf.download_images([_img_file()])  # no declared size -> caught after download
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
