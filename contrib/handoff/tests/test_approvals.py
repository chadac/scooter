"""handoff_spawn waits for the owner's Approve, and the agent hears the outcome."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.approvals import ApprovalRequest
from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_handoff import mcp_tools, spawn
from scooter_contrib_handoff.approvals import MAX_PENDING, Spawn, card, spawn_approvals
from scooter_contrib_handoff.mcp_tools import handoff_spawn
from scooter_contrib_handoff.spawn import Spawner
from scooter_schema.broker import Base

VIEWS = {"src": {"owner": "alice", "visibility": "shared"}, "ownerless": {"owner": "", "visibility": "shared"}}


async def fetch(conv: str):
    return VIEWS.get(conv)


@dataclass
class FakeCards:
    raised: list[dict] = field(default_factory=list)

    async def raise_(self, conversation_id: str, contrib: str, card: dict) -> None:
        self.raised.append(card)

    async def withdraw(self, conversation_id: str, contrib: str, request_id: str) -> None:
        return None


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
async def spawns(agent_host, cards):
    a = spawn_approvals(Spawner(agent_host, "https://scooter.test", OwnerResolver(fetch, ttl=0)))
    a.configure(sqlite_config(), cards)
    await create_schema(a, Base)
    return a


@pytest.fixture
def configured(store, agent_host, spawns, links):
    mcp_tools.configure(store, agent_host, "https://scooter.test", owners=OwnerResolver(fetch, ttl=0), spawns=spawns)
    yield
    mcp_tools.configure(None, None, "")


@pytest.fixture
def app(spawns, configured):
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(spawns.routes(Provider(name="handoff", transports=[spawns]), authed), prefix="/handoff")
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


async def test_spawn_waits_for_a_card(router, cards, spawns, configured):
    router.add("src")
    rid = await request()
    assert router.spawns == []
    assert [c["request_id"] for c in cards.raised] == [rid]
    assert (await spawns.get(rid)).owner == "alice"


async def test_approve_spawns_and_tells_the_agent(app, router, spawns, links):
    router.add("src")
    rid = await request()
    async with as_approver(app) as c:
        assert (await c.post(f"/handoff/approvals/{rid}/can-approve", json=answer("alice"))).json() == {"can_approve": True, "pending": True}
        r = (await c.post(f"/handoff/approvals/{rid}/approve", json=answer("alice"))).json()
    assert r["conversation_id"] == "new-1" and "approved" in r["agent_message"] and "new-1" in r["agent_message"]
    assert router.spawns[0][1]["prompt"].startswith("Finish the migration.")
    assert len(links) == 2
    assert (await spawns.get(rid)).decided_by == "alice"
    async with as_approver(app) as c:
        again = await c.post(f"/handoff/approvals/{rid}/approve", json=answer("alice"))
    assert again.status_code == 409 and len(router.spawns) == 1


async def test_deny_tells_the_agent_and_spawns_nothing(app, router):
    router.add("src")
    rid = await request("Deploy")
    async with as_approver(app) as c:
        r = (await c.post(f"/handoff/approvals/{rid}/deny", json=answer("alice"))).json()
        assert (await c.get("/handoff/approvals/pending", params={"conversation_id": "src"})).json() == {"requests": []}
    assert r["status"] == "deny" and '"Deploy"' in r["agent_message"] and router.spawns == []


async def test_only_the_owner_answers(app, router):
    router.add("src")
    rid = await request()
    async with as_approver(app) as c:
        assert (await c.post(f"/handoff/approvals/{rid}/can-approve", json=answer("bob"))).json() == {"can_approve": False, "pending": True}
        assert (await c.post(f"/handoff/approvals/{rid}/approve", json=answer("bob"))).status_code == 403
        assert (await c.post(f"/handoff/approvals/{rid}/approve", json={})).status_code == 400
    async with as_approver(app, is_approver=False) as c:
        assert (await c.post(f"/handoff/approvals/{rid}/approve", json=answer("alice"))).status_code == 403
    assert router.spawns == []


async def test_a_failed_spawn_is_reported_to_the_agent(app, router, spawns):
    router.add("src")
    router.spawn_status = 429
    rid = await request()
    async with as_approver(app) as c:
        r = (await c.post(f"/handoff/approvals/{rid}/approve", json=answer("alice"))).json()
    assert "429" in r["agent_message"] and "half-made" in r["agent_message"]
    assert (await spawns.get(rid)).status == "failed"


async def test_pending_lists_cards_for_revive(app, router):
    router.add("src")
    rid = await request()
    async with as_approver(app) as c:
        out = (await c.get("/handoff/approvals/pending", params={"conversation_id": "src"})).json()
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


def _req(s: Spawn) -> ApprovalRequest[Spawn]:
    return ApprovalRequest("r1", "src", "alice", s, "pending", None, 0, None)


def test_card_shows_the_whole_brief():
    c = card(_req(Spawn("x" * 5000, model="opus")))
    assert c.message.endswith("x" * 5000) and "model opus" in c.message
    assert c.data["brief"] == "x" * 5000


def test_card_names_the_default_model_when_none_is_set():
    assert "(default model)" in card(_req(Spawn("brief"))).message


async def test_approve_refuses_once_another_author_writes_in_the_source(app, router, monkeypatch):
    router.add("src")
    monkeypatch.setitem(VIEWS, "src", {"owner": "alice", "visibility": "private", "authors": [{"user": "alice"}]})
    rid = await request()
    VIEWS["src"] = {"owner": "alice", "visibility": "private", "authors": [{"user": "alice"}, {"user": None}]}
    async with as_approver(app) as c:
        r = (await c.post(f"/handoff/approvals/{rid}/approve", json=answer("alice"))).json()
    assert r["status"] == "failed" and "didn't write" in r["agent_message"] and router.spawns == []



# --- filing the new conversation in a folder ---------------------------------------

async def test_a_handoff_names_its_folder_and_is_filed_on_approve(app, router, cards, configured):
    router.add("src")
    r = await handoff_spawn(brief="Spec the retry policy.", title="Retry spec", folder=" f-design ", ctx=ctx("src"))
    assert not r.is_error, r.text
    rid = json.loads(r.text)["request_id"]
    assert "new conversation: Retry spec, filed in folder f-design" in cards.raised[0]["message"]
    async with as_approver(app) as c:
        out = (await c.post(f"/handoff/approvals/{rid}/approve", json=answer("alice"))).json()
    assert router.filed == [("alice", "new-1", "f-design")]
    assert out["filed"] is True and "filed in folder f-design" in out["agent_message"]


async def test_a_handoff_that_will_not_file_still_counts(app, router, configured):
    router.add("src")
    router.file_status = 500
    rid = json.loads((await handoff_spawn(brief="go", folder="f-infra", ctx=ctx("src"))).text)["request_id"]
    async with as_approver(app) as c:
        out = (await c.post(f"/handoff/approvals/{rid}/approve", json=answer("alice"))).json()
    assert out["filed"] is False and "could not be filed in folder f-infra" in out["agent_message"]
    assert out["conversation_id"] == "new-1"


async def test_a_folder_must_be_the_owner_s(router, cards, configured):
    router.add("src")
    router.folders["bob"] = [{"id": "f-bob", "name": "Bob's"}]
    r = await handoff_spawn(brief="go", folder="f-bob", ctx=ctx("src"))
    assert r.is_error and "not one of the user's folders" in r.text and cards.raised == []


async def test_a_plain_handoff_files_nowhere(app, router, configured):
    router.add("src")
    rid = await request()
    async with as_approver(app) as c:
        out = (await c.post(f"/handoff/approvals/{rid}/approve", json=answer("alice"))).json()
    assert router.filed == [] and "filed" not in out
