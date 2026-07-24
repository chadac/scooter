"""Tier 1 — spawn_conversation POSTs the right /agui body (owner, threadId, prompt)."""

import httpx
import pytest

from scheduler.spawn import spawn_conversation


class _Capture:
    """A fake agent-host that records the POST and returns 200."""

    def __init__(self, status=200):
        self.status = status
        self.body = None
        self.headers = None

    async def handler(self, request: httpx.Request) -> httpx.Response:
        import json
        self.body = json.loads(request.content)
        self.headers = request.headers
        return httpx.Response(self.status)


@pytest.mark.asyncio
async def test_spawn_posts_prompt_owner_and_threadid():
    cap = _Capture()
    transport = httpx.MockTransport(cap.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        conv = await spawn_conversation("check the dashboard", title="daily", owner="alice", client=client)
    assert conv is not None
    assert cap.body["threadId"] == conv
    assert cap.body["messages"][0] == {"role": "user", "content": "check the dashboard"}
    assert cap.body["title"] == "daily"
    assert cap.body["owner"] == "alice"  # owner rides the body (agent-host verifies SA)


@pytest.mark.asyncio
async def test_spawn_returns_none_on_error_status():
    cap = _Capture(status=502)
    transport = httpx.MockTransport(cap.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        conv = await spawn_conversation("x", title=None, owner=None, client=client)
    assert conv is None


@pytest.mark.asyncio
async def test_spawn_omits_optional_fields_when_absent():
    cap = _Capture()
    transport = httpx.MockTransport(cap.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        await spawn_conversation("just a prompt", title=None, owner=None, client=client)
    assert "title" not in cap.body
    assert "owner" not in cap.body
