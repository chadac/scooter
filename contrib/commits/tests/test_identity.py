"""The user sets their identity freely; an agent only proposes one, which the user approves in the conversation."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.mcp import ToolContext, gate_for
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_commits import mcp_tools
from scooter_contrib_commits.host import card
from scooter_contrib_commits.store import CommitIdentityStore, Proposal, Refused, _Base, _Identity
from scooter_contrib_commits.transport import Commits

VIEWS = {
    "alice-private": {"owner": "alice", "visibility": "private", "authors": []},
    "alice-private-2": {"owner": "alice", "visibility": "private", "authors": []},
    "alice-shared": {"owner": "alice", "visibility": "shared"},
}


async def fetch(conv: str):
    return VIEWS.get(conv)


@dataclass
class FakeCards:
    raised: list[Proposal] = field(default_factory=list)
    withdrawn: list[Proposal] = field(default_factory=list)

    async def raise_(self, p: Proposal) -> None:
        self.raised.append(p)

    async def withdraw(self, p: Proposal) -> None:
        self.withdrawn.append(p)


@pytest.fixture
def cards():
    return FakeCards()


@pytest.fixture
async def store(cards):
    s = CommitIdentityStore(sqlite_config())
    await create_schema(s, _Base)
    mcp_tools.configure(s, OwnerResolver(fetch, ttl=0), cards)
    yield s
    mcp_tools.configure(None, None)


@pytest.fixture
def app(store, cards):
    transport = Commits(store=store, cards=cards)
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(transport.routes(Provider(name="commits", transports=[transport]), authed), prefix="/commits")
    a.state.caller = caller
    return a


def as_(app, relayed_user: str | None, conversation: str = "") -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id=conversation, namespace="ns", service_account="agent-host", relayed_user=relayed_user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


def as_approver(app, is_approver: bool = True) -> AsyncClient:
    """The agent-host relaying a user's answer."""
    app.state.caller["identity"] = Identity(
        conversation_id="", namespace="ns", service_account="agent-host", is_approver=is_approver
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


def answer(user: str) -> dict:
    return {"approver": {"id": user, "email": f"{user}@example.com", "name": user}}


@dataclass
class _Links:
    async def list(self) -> list[dict[str, Any]]:
        return []


def ctx(conversation: str) -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id=conversation, namespace="agent-sandbox", service_account="sandbox"),
        provider=Provider(name="commits", transports=[]),
        upstream=None,  # type: ignore[arg-type]
        links=_Links(),
    )


async def test_only_the_relay_reaches_the_user_routes(app):
    async with as_(app, None, "alice-private") as c:
        for method in ("GET", "PUT", "DELETE"):
            r = await c.request(method, "/commits/user/identity", json={"name": "x", "email": "x@y"})
            assert r.status_code == 403, (method, r.text)


async def test_the_user_sets_replaces_and_clears(app):
    async with as_(app, "alice") as c:
        assert (await c.get("/commits/user/identity")).json() == {"identity": None}
        r = await c.put("/commits/user/identity", json={"name": "Alice", "email": "alice@example.com"})
        assert r.json()["identity"]["set_by"] == "user"
        await c.put("/commits/user/identity", json={"name": "A. Liddell", "email": "al@example.com"})
        assert (await c.get("/commits/user/identity")).json()["identity"]["email"] == "al@example.com"
        await c.delete("/commits/user/identity")
        assert (await c.get("/commits/user/identity")).json() == {"identity": None}
    async with as_(app, "bob") as c:
        assert (await c.get("/commits/user/identity")).json() == {"identity": None}


@pytest.mark.parametrize("name,email", [("", "a@b"), ("A <x>", "a@b"), ("A\nB", "a@b"), ("A", "nope"), ("A", "a b@c")])
async def test_a_malformed_identity_is_refused(app, name, email):
    async with as_(app, "alice") as c:
        assert (await c.put("/commits/user/identity", json={"name": name, "email": email})).status_code == 400


async def test_tools_are_listed_only_in_the_owners_private_conversation(store):
    for tool in ("commit_identity_get", "commit_identity_propose"):
        gate = gate_for(tool)
        assert gate is not None
        assert await gate(ctx("alice-private"))
        assert not await gate(ctx("alice-shared"))
        assert not await gate(ctx("unknown"))


async def propose(conv: str, name: str = "Alice", email: str = "alice@example.com"):
    return await mcp_tools.commit_identity_propose(name=name, email=email, ctx=ctx(conv))


async def test_a_proposal_raises_a_card_and_waits_for_approval(store, cards):
    got = await propose("alice-private")
    assert not got.is_error and "Approvals" in got.text, got.text
    assert await store.get("alice") is None
    [p] = cards.raised
    assert (p.user_id, p.conversation_id, p.person.email) == ("alice", "alice-private", "alice@example.com")
    assert card(p)["kind"] == "commits.identity"
    assert card(p)["data"] == {"name": "Alice", "email": "alice@example.com"}
    status = await mcp_tools.commit_identity_get(ctx=ctx("alice-private"))
    assert "Awaiting the user's approval: Alice <alice@example.com>" in status.text


async def test_approving_writes_it_and_withdraws_the_other_agents_cards(app, store, cards):
    await propose("alice-private", "Alice", "alice@example.com")
    await propose("alice-private-2", "A. Liddell", "al@example.com")
    first, second = cards.raised
    async with as_approver(app) as c:
        r = await c.post(f"/commits/proposals/{second.id}/approve", json=answer("alice"))
        assert r.status_code == 200, r.text
        assert r.json()["superseded"] == [first.id]
        assert [p.id for p in cards.withdrawn] == [first.id]
        # A stale card changes nothing and is no broker failure.
        late = await c.post(f"/commits/proposals/{first.id}/approve", json=answer("alice"))
        assert late.status_code == 200 and "superseded" in late.json()["refused"]
        assert (await c.get("/commits/proposals/pending", params={"conversation_id": "alice-private"})).json() == {
            "requests": []
        }
    chosen = await store.get("alice")
    assert (chosen.person.email, chosen.set_by) == ("al@example.com", "agent")


async def test_the_identity_key_refuses_an_approval_that_lost_a_race(store):
    p = await store.propose("alice", "alice-private", Person("Alice", "alice@example.com"))
    # An identity written without superseding p, as a lost race leaves it.
    async with store._session() as s, s.begin():
        s.add(_Identity(user_id="alice", name="B", email="b@example.com", set_by="agent", updated_at="t"))
    with pytest.raises(Refused, match="set first"):
        await store.approve(p.id, "alice")
    assert (await store.proposal(p.id)).status == "superseded"
    assert (await store.get("alice")).person.email == "b@example.com"


async def test_an_identity_set_in_settings_supersedes_pending_proposals(app, store, cards):
    await propose("alice-private")
    [p] = cards.raised
    async with as_(app, "alice") as c:
        await c.put("/commits/user/identity", json={"name": "Alice", "email": "me@example.com"})
    assert [w.id for w in cards.withdrawn] == [p.id]
    with pytest.raises(Refused):
        await store.approve(p.id, "alice")
    assert (await store.get("alice")).set_by == "user"


async def test_only_the_proposals_user_may_answer(app, cards):
    await propose("alice-private")
    [p] = cards.raised
    async with as_approver(app) as c:
        assert (await c.post(f"/commits/proposals/{p.id}/can-approve", json=answer("alice"))).json() == {"can_approve": True}
        assert (await c.post(f"/commits/proposals/{p.id}/can-approve", json=answer("mallory"))).json() == {"can_approve": False}
        assert (await c.post(f"/commits/proposals/{p.id}/approve", json=answer("mallory"))).status_code == 403
        assert (await c.post(f"/commits/proposals/{p.id}/deny", json=answer("mallory"))).status_code == 403


async def test_only_an_approver_caller_reaches_the_proposal_routes(app, cards):
    await propose("alice-private")
    [p] = cards.raised
    async with as_approver(app, is_approver=False) as c:
        assert (await c.post(f"/commits/proposals/{p.id}/approve", json=answer("alice"))).status_code == 403
        assert (await c.get("/commits/proposals/pending", params={"conversation_id": "alice-private"})).status_code == 403


async def test_a_denied_proposal_frees_the_conversation_to_ask_again(app, store, cards):
    await propose("alice-private")
    again = await propose("alice-private", "Other", "o@example.com")
    assert again.is_error and "still pending" in again.text
    [p] = cards.raised
    async with as_approver(app) as c:
        assert (await c.get("/commits/proposals/pending", params={"conversation_id": "alice-private"})).json() == {
            "requests": [card(p)]
        }
        assert (await c.post(f"/commits/proposals/{p.id}/deny", json=answer("alice"))).json() == {"denied": p.id}
    assert await store.get("alice") is None
    assert not (await propose("alice-private", "Other", "o@example.com")).is_error


async def test_an_agent_cannot_propose_over_a_set_identity(app, store, cards):
    async with as_(app, "alice") as c:
        await c.put("/commits/user/identity", json={"name": "Alice", "email": "alice@example.com"})
    got = await propose("alice-private", "Other", "o@example.com")
    assert got.is_error and "already set" in got.text
    assert cards.raised == []


async def test_a_shared_conversation_cannot_propose(store, cards):
    got = await propose("alice-shared")
    assert got.is_error
    assert cards.raised == []
