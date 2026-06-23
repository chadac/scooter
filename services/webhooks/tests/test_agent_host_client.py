"""Unit tests for the agent-host client — the spawn-via-/agui seam.

Mocks the agent-host AG-UI SSE stream and proves create_conversation generates a
threadId, posts the task, accumulates the final assistant message, and returns
it; send_message follows up on the same thread; RUN_ERROR surfaces as failure.
"""

from __future__ import annotations

import httpx
import pytest

from webhooks import agent_host_client as ahc


def _sse(*events: str) -> bytes:
    return "".join(f"data: {e}\n\n" for e in events).encode()


class _FakeStream:
    def __init__(self, body: bytes):
        self._body = body
        self.status_code = 200

    def raise_for_status(self):
        pass

    async def aiter_lines(self):
        for line in self._body.decode().splitlines():
            yield line

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _patch_stream(monkeypatch, body: bytes, captured: dict | None = None):
    def fake_stream(self, method, url, **kwargs):  # noqa: ANN001
        if captured is not None:
            captured["url"] = url
            captured["json"] = kwargs.get("json")
        return _FakeStream(body)

    monkeypatch.setattr(httpx.AsyncClient, "stream", fake_stream)


async def test_create_conversation_collects_final_message(monkeypatch):
    captured: dict = {}
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"Done: "}',
        '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"fixed it."}',
        '{"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
    )
    _patch_stream(monkeypatch, body, captured)

    result = await ahc.create_conversation("fix the bug", repository="o/r")

    assert result is not None
    assert result["result"] == "Done: fixed it."
    assert result["conversation_id"]  # a generated threadId
    # The repo was woven into the task, posted to /agui.
    assert captured["json"]["messages"][0]["content"].startswith("Repository: o/r")
    assert captured["json"]["threadId"] == result["conversation_id"]


async def test_run_error_returns_none(monkeypatch):
    body = _sse(
        '{"type":"RUN_STARTED","threadId":"t","runId":"r"}',
        '{"type":"RUN_ERROR","message":"agent blew up"}',
    )
    _patch_stream(monkeypatch, body)

    result = await ahc.create_conversation("do a thing")
    assert result is None


async def test_send_message_posts_to_same_thread(monkeypatch):
    captured: dict = {}
    _patch_stream(monkeypatch, _sse('{"type":"RUN_FINISHED","threadId":"c1","runId":"r"}'), captured)

    ok = await ahc.send_message("c1", "a follow-up")
    assert ok is True
    assert captured["json"]["threadId"] == "c1"
    assert captured["json"]["messages"][0]["content"] == "a follow-up"


def test_resolve_sandbox_is_identity():
    import asyncio

    assert asyncio.run(ahc.resolve_sandbox_to_conversation("conv-x")) == "conv-x"
