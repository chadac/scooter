"""Scooter's own Slack status messages suppress link/media unfurl.

The "on it — follow along: <chat url|View conversation>" post (and its edits) carry a
chat URL / PR link; Slack's default unfurl renders a big useless preview card. Assert
both post + update send unfurl_links/unfurl_media = False.
"""

import json

import httpx

from webhooks.responses import slack as slack_resp

# asyncio_mode = "auto" (pyproject) — `async def test_*` run without extra markers.


def _capture(monkeypatch, captured: dict):
    """Route the module's httpx.AsyncClient through a MockTransport that records the
    request body and returns a Slack-OK response."""
    real_client = httpx.AsyncClient

    def handler(req: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(req.content.decode())
        return httpx.Response(200, json={"ok": True, "ts": "123.456"})

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(slack_resp.httpx, "AsyncClient", factory)


async def test_post_message_suppresses_unfurl(monkeypatch):
    captured: dict = {}
    _capture(monkeypatch, captured)
    await slack_resp.post_slack_message("C1", "on it: <https://x|View conversation>")
    assert captured["body"]["unfurl_links"] is False
    assert captured["body"]["unfurl_media"] is False


async def test_update_message_suppresses_unfurl(monkeypatch):
    captured: dict = {}
    _capture(monkeypatch, captured)
    await slack_resp.update_slack_message("C1", "123.456", "updated: <https://x|link>")
    assert captured["body"]["unfurl_links"] is False
    assert captured["body"]["unfurl_media"] is False
