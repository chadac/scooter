"""publish_state's wire shape and failure handling."""

from __future__ import annotations

import json

import httpx
import pytest

from scooter_broker_lib.state import publish_state


def _recorder(status: int = 202):
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json={"ok": True})

    return seen, httpx.MockTransport(handle)


@pytest.mark.asyncio
async def test_invalidation_posts_an_empty_body_to_the_contrib_topic():
    seen, transport = _recorder()
    await publish_state("http://router/", "conv-1", "shares", transport=transport)
    assert len(seen) == 1
    assert seen[0].method == "POST"
    assert str(seen[0].url) == "http://router/conversations/conv-1/state/contrib/shares"
    assert json.loads(seen[0].content) == {}


@pytest.mark.asyncio
async def test_data_is_sent_as_the_value():
    seen, transport = _recorder()
    await publish_state("http://router", "conv-1", "shares", {"count": 2}, transport=transport)
    assert json.loads(seen[0].content) == {"data": {"count": 2}}


@pytest.mark.asyncio
async def test_none_is_a_value_not_an_invalidation():
    seen, transport = _recorder()
    await publish_state("http://router", "conv-1", "shares", None, transport=transport)
    assert json.loads(seen[0].content) == {"data": None}


@pytest.mark.asyncio
async def test_unconfigured_host_or_conversation_sends_nothing():
    seen, transport = _recorder()
    await publish_state("", "conv-1", "shares", transport=transport)
    await publish_state("http://router", "", "shares", transport=transport)
    assert seen == []


@pytest.mark.asyncio
async def test_refusal_and_network_errors_never_raise():
    _, refused = _recorder(status=403)
    await publish_state("http://router", "conv-1", "shares", transport=refused)

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    await publish_state("http://router", "conv-1", "shares", transport=httpx.MockTransport(boom))
