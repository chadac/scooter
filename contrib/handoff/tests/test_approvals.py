"""handoff_spawn waits for the owner's Approve, and the agent hears the outcome."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_handoff import mcp_tools, spawn
from scooter_contrib_handoff.host import HostCards, card
from scooter_contrib_handoff.mcp_tools import handoff_spawn
from scooter_contrib_handoff.spawn import Spawner
from scooter_contrib_handoff.store import MAX_PENDING, SpawnRequest
from scooter_contrib_handoff.transport import Handoff

VIEWS = {"src": {"owner": "alice", "visibility": "shared"}, "ownerless": {"owner": "", "visibility": "shared"}}


async def fetch(conv: str):
    return VIEWS.get(conv)


@dataclass
class FakeCards:
    raised: list[SpawnRequest] = field(default_factory=list)

    async def raise_(self, r: SpawnRequest) -> None:
        self.raised.append(r)


@pytest.fixture
def cards():
    return FakeCards()


@pytest.fixture
def links(monkeypatch):
    posted: list[tuple[str, object]] = []

    async def post_link(url, conversation_id, link):
        posted.append((conversation_id, link))

    monkeypatch.setattr(spawn, "post_link", post_link)
    return posted


@pytest.fixture
def configured(store, agent_host, cards, links):
    mcp_tools.configure(store, agent_host, "https://scooter.test", owners=OwnerResolver(fetch, ttl=0), cards=cards)
    yield
    mcp_tools.configure(None, None, "")


@pytest.fixture
def app(store, agent_host, configured):
    transport = Handoff(store=store, agent_host=agent_host, spawner=Spawner(agent_host, "https://scooter.test", OwnerResolver(fetch, ttl=0)))
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(transport.routes(Provider(name="handoff", transports=[transport]), authed), prefix="/handoff")
    a.state.caller = caller
    return a


def as_approver(app, is_approver: bool = True) -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id="", namespace="ns", service_account="agent-host", is_approver=is_approver
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


def answer(user: str) -> dict:
    return {"approver": {"id": user, "email": f"{user}@example.com", "name": user}}


def ctx(conversation: str) -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id=conversation, namespace="ns", service_account="sandbox"),
        provider=Provider(name="handoff", transports=[]),
        upstream=None,  # type: ignore[arg-type]
        links=None,  # type: ignore[arg-type]
    )


async def request(title: str = "Migration") -> str:
    r = await handoff_spawn(brief="Finish the migration.", title=title, ctx=ctx("src"))
    assert not r.is_error, r.text
    out = json.loads(r.text)
    assert out["status"] == "pending_approval"
    return out["request_id"]


async def test_spawn_waits_for_a_card(router, cards, configured):
    router.add("src")
    rid = await request()
    assert router.spawns == []
    assert [r.id for r in cards.raised] == [rid] and cards.raised[0].owner == "alice"


async def test_approve_spawns_and_tells_the_agent(app, router, store, links):
    router.add("src")
    rid = await request()
    async with as_approver(app) as c:
        assert (await c.post(f"/handoff/spawns/{rid}/can-approve", json=answer("alice"))).json() == {"can_approve": True}
        r = (await c.post(f"/handoff/spawns/{rid}/approve", json=answer("alice"))).json()
    assert r["conversation_id"] == "new-1" and "approved" in r["agent_message"] and "new-1" in r["agent_message"]
    assert router.spawns[0][1]["prompt"].startswith("Finish the migration.")
    assert len(links) == 2
    assert (await store.spawn_request(rid)).spawned_id == "new-1"
    async with as_approver(app) as c:
        again = (await c.post(f"/handoff/spawns/{rid}/approve", json=answer("alice"))).json()
    assert "refused" in again and len(router.spawns) == 1


async def test_deny_tells_the_agent_and_spawns_nothing(app, router):
    router.add("src")
    rid = await request("Deploy")
    async with as_approver(app) as c:
        r = (await c.post(f"/handoff/spawns/{rid}/deny", json=answer("alice"))).json()
        assert (await c.get("/handoff/spawns/pending", params={"conversation_id": "src"})).json() == {"requests": []}
    assert r["denied"] == rid and '"Deploy"' in r["agent_message"] and router.spawns == []


async def test_only_the_owner_answers(app, router):
    router.add("src")
    rid = await request()
    async with as_approver(app) as c:
        assert (await c.post(f"/handoff/spawns/{rid}/can-approve", json=answer("bob"))).json() == {"can_approve": False}
        assert (await c.post(f"/handoff/spawns/{rid}/approve", json=answer("bob"))).status_code == 403
        assert (await c.post(f"/handoff/spawns/{rid}/approve", json={})).status_code == 400
    async with as_approver(app, is_approver=False) as c:
        assert (await c.post(f"/handoff/spawns/{rid}/approve", json=answer("alice"))).status_code == 403
    assert router.spawns == []


async def test_a_failed_spawn_is_reported_to_the_agent(app, router, store):
    router.add("src")
    router.spawn_status = 429
    rid = await request()
    async with as_approver(app) as c:
        r = (await c.post(f"/handoff/spawns/{rid}/approve", json=answer("alice"))).json()
    assert "429" in r["agent_message"] and "half-made" in r["agent_message"]
    assert (await store.spawn_request(rid)).status == "failed"


async def test_pending_lists_cards_for_revive(app, router):
    router.add("src")
    rid = await request()
    async with as_approver(app) as c:
        out = (await c.get("/handoff/spawns/pending", params={"conversation_id": "src"})).json()
    assert [r["request_id"] for r in out["requests"]] == [rid]
    assert out["requests"][0]["kind"] == "handoff.spawn" and "Finish the migration." in out["requests"][0]["message"]


async def test_pending_requests_are_capped(router, configured):
    router.add("src")
    for _ in range(MAX_PENDING):
        await request()
    r = await handoff_spawn(brief="one more", ctx=ctx("src"))
    assert r.is_error and "waiting" in r.text


async def test_no_known_owner_is_refused(router, configured):
    r = await handoff_spawn(brief="go", ctx=ctx("ownerless"))
    assert r.is_error and "owner" in r.text


def test_card_shows_the_whole_brief():
    r = SpawnRequest("r1", "src", "alice", "x" * 5000, "", "opus", "pending")
    c = card(r)
    assert c["message"].endswith("x" * 5000) and "model opus" in c["message"]
    assert c["data"]["brief"] == "x" * 5000


def test_card_names_the_default_model_when_none_is_set():
    r = SpawnRequest("r1", "src", "alice", "brief", "", "", "pending")
    assert "(default model)" in card(r)["message"]


async def test_host_cards_post_to_the_approvals_route():
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(201)

    r = SpawnRequest("r1", "src", "alice", "go", "T", "", "pending")
    await HostCards("http://host.test", transport=httpx.MockTransport(handler)).raise_(r)
    assert seen[0].url.path == "/conversations/src/approvals/handoff"
    assert json.loads(seen[0].content)["request_id"] == "r1"


async def test_approve_refuses_once_another_author_writes_in_the_source(app, router, monkeypatch):
    router.add("src")
    monkeypatch.setitem(VIEWS, "src", {"owner": "alice", "visibility": "private", "authors": [{"user": "alice"}]})
    rid = await request()
    VIEWS["src"] = {"owner": "alice", "visibility": "private", "authors": [{"user": "alice"}, {"user": None}]}
    async with as_approver(app) as c:
        r = (await c.post(f"/handoff/spawns/{rid}/approve", json=answer("alice"))).json()
    assert "failed" in r and "didn't write" in r["agent_message"] and router.spawns == []
