"""Personal credentials go only to a private conversation's owner, and every doubt resolves to nobody."""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.owner import OwnerResolver, agent_host_fetcher
from scooter_broker_lib.types import Identity


def ident(conv: str, owner: str | None = None) -> Identity:
    return Identity(conversation_id=conv, namespace="ns", service_account=f"sa-{conv}", owner=owner)


class Views:
    """A fake agent-host: conversation id -> view, counting fetches."""

    def __init__(self, views: dict[str, dict]):
        self.views = views
        self.calls = 0
        self.fail = False

    async def __call__(self, conv: str):
        self.calls += 1
        if self.fail:
            raise httpx.ConnectError("down")
        return self.views.get(conv)


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def views() -> Views:
    return Views({
        "priv": {"owner": "alice", "visibility": "private"},
        "shared": {"owner": "alice", "visibility": "shared"},
        "legacy": {"owner": "alice"},
    })


async def test_a_private_conversation_acts_as_its_owner(views):
    assert await OwnerResolver(views).acting_user(ident("priv")) == "alice"


async def test_a_shared_conversation_acts_as_nobody_even_with_an_owner(views):
    r = OwnerResolver(views)
    assert await r.acting_user(ident("shared")) is None
    assert await r.acting_user(ident("shared", owner="alice")) is None


async def test_a_view_without_visibility_counts_as_shared(views):
    assert await OwnerResolver(views).acting_user(ident("legacy")) is None


async def test_an_unknown_conversation_acts_as_nobody(views):
    assert await OwnerResolver(views).acting_user(ident("nope")) is None


async def test_a_failed_lookup_acts_as_nobody_and_is_retried(views):
    r = OwnerResolver(views)
    views.fail = True
    assert await r.acting_user(ident("priv")) is None
    views.fail = False
    assert await r.acting_user(ident("priv")) == "alice"


async def test_a_turn_to_shared_is_seen_after_the_ttl(views):
    clock = Clock()
    r = OwnerResolver(views, ttl=10, clock=clock)
    assert await r.acting_user(ident("priv")) == "alice"
    views.views["priv"]["visibility"] = "shared"
    clock.t = 5
    assert await r.acting_user(ident("priv")) == "alice"
    assert views.calls == 1
    clock.t = 11
    assert await r.acting_user(ident("priv")) is None


async def test_the_agent_host_fetcher_reads_the_conversation_view():
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/conversations/priv":
            return httpx.Response(200, json={"owner": "alice", "visibility": "private"})
        return httpx.Response(404, json={"error": "not found"})

    fetch = agent_host_fetcher("http://agent-host/", transport=httpx.MockTransport(handler))
    r = OwnerResolver(fetch)
    assert await r.acting_user(ident("priv")) == "alice"
    assert await r.acting_user(ident("gone")) is None


async def test_a_5xx_from_the_agent_host_acts_as_nobody():
    fetch = agent_host_fetcher("http://agent-host", transport=httpx.MockTransport(lambda _: httpx.Response(502)))
    assert await OwnerResolver(fetch).acting_user(ident("priv")) is None
