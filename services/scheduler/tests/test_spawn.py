"""Tier 1 — spawn_conversation CREATES a conversation, then prompts the id the
server assigned.

The scheduler used to mint its own uuid and rely on /agui creating the
conversation implicitly. That path is gone: the server owns conversation ids
(POST /conversations, served by the conversation-router as a control-plane CR
write). These tests pin the two-call flow and, critically, that the id the
scheduler records is the SERVER's — not one it chose.
"""

import json

import httpx
import pytest

from scheduler.spawn import spawn_conversation

SERVER_ID = "11111111-2222-3333-4444-555555555555"


class _Agent:
    """A fake agent-host: records both calls and returns a server-assigned id."""

    def __init__(self, create_status=201, prompt_status=200, server_id=SERVER_ID):
        self.create_status = create_status
        self.prompt_status = prompt_status
        self.server_id = server_id
        self.create_body = None
        self.create_headers = None
        self.prompt_body = None
        self.calls: list[str] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(f"{request.method} {path}")
        if path.endswith("/conversations"):
            self.create_body = json.loads(request.content or b"{}")
            self.create_headers = request.headers
            if self.create_status >= 300:
                return httpx.Response(self.create_status)
            return httpx.Response(self.create_status, json={"id": self.server_id, "status": "pending"})
        # /agui
        self.prompt_body = json.loads(request.content)
        return httpx.Response(self.prompt_status)


async def _spawn(agent: _Agent, **kw):
    transport = httpx.MockTransport(agent.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        return await spawn_conversation(
            kw.pop("prompt", "check the dashboard"),
            title=kw.pop("title", "daily"),
            owner=kw.pop("owner", "alice"),
            client=client,
        )


@pytest.mark.asyncio
async def test_spawn_creates_then_prompts_the_server_assigned_id():
    agent = _Agent()
    conv = await _spawn(agent)

    # Create FIRST, then prompt — and the returned id is the SERVER's.
    assert agent.calls == ["POST /conversations", "POST /agui"]
    assert conv == SERVER_ID
    assert agent.prompt_body["threadId"] == SERVER_ID
    assert agent.prompt_body["messages"][0] == {"role": "user", "content": "check the dashboard"}
    assert agent.prompt_body["source"] == "scheduler"


@pytest.mark.asyncio
async def test_spawn_never_invents_its_own_id():
    """The regression that matters: the scheduler must not choose the id."""
    agent = _Agent(server_id="server-chosen")
    conv = await _spawn(agent)
    assert conv == "server-chosen"
    # Nothing in the CREATE body may carry a caller-chosen id.
    assert "threadId" not in agent.create_body
    assert "id" not in agent.create_body


@pytest.mark.asyncio
async def test_title_rides_the_create_call():
    agent = _Agent()
    await _spawn(agent, title="daily digest")
    assert agent.create_body["title"] == "daily digest"


@pytest.mark.asyncio
async def test_owner_is_sent_on_both_calls():
    agent = _Agent()
    await _spawn(agent, owner="alice")
    # The router stamps spec.owner from the identity header on CREATE...
    assert agent.create_headers["x-auth-user"] == "alice"
    # ...and the agent-host still honors the body owner for the SA-verified caller.
    assert agent.prompt_body["owner"] == "alice"


@pytest.mark.asyncio
async def test_spawn_returns_none_when_create_fails():
    """A failed create means there is NO conversation — do not prompt into the void."""
    agent = _Agent(create_status=502)
    conv = await _spawn(agent)
    assert conv is None
    assert agent.calls == ["POST /conversations"]  # never reached /agui


@pytest.mark.asyncio
async def test_spawn_returns_none_when_create_returns_no_id():
    agent = _Agent()
    agent.server_id = None  # a 201 with no usable id
    transport = httpx.MockTransport(agent.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        conv = await spawn_conversation("p", title="t", owner=None, client=client)
    assert conv is None


@pytest.mark.asyncio
async def test_spawn_returns_none_on_prompt_error_status():
    agent = _Agent(prompt_status=502)
    conv = await _spawn(agent)
    assert conv is None


@pytest.mark.asyncio
async def test_spawn_omits_optional_fields_when_absent():
    agent = _Agent()
    transport = httpx.MockTransport(agent.handler)
    async with httpx.AsyncClient(transport=transport) as client:
        conv = await spawn_conversation("p", title=None, owner=None, client=client)
    assert conv == SERVER_ID
    assert "title" not in agent.create_body
    assert "owner" not in agent.prompt_body
    assert "x-auth-user" not in agent.create_headers
