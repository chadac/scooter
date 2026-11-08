"""The approvals construct: decide once, gate the approve verb, expire, and raise cards."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from scooter_broker_lib.approvals import (
    Approvals,
    Approver,
    Card,
    Decision,
    HostCards,
    TooManyPending,
)
from scooter_broker_lib.store import StoreConfig
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_schema.broker import Base
from scooter_broker_lib.types import Identity

CONV = "c-1"


@dataclass
class Thing:
    title: str


class RecordingCards:
    def __init__(self) -> None:
        self.raised: list[dict] = []
        self.withdrawn: list[str] = []

    async def raise_(self, conversation_id, contrib, card):
        self.raised.append({"conversation_id": conversation_id, "contrib": contrib, **card})

    async def withdraw(self, conversation_id, contrib, request_id):
        self.withdrawn.append(request_id)


async def _approvals(**kw) -> tuple[Approvals[Thing], RecordingCards]:
    cards = RecordingCards()
    a = Approvals(contrib="echo", kind="echo.thing", payload=Thing,
                  render=lambda r: Card(f"Do {r.payload.title}?", {"title": r.payload.title}), **kw)
    a.configure(sqlite_config(), cards)
    await create_schema(a, Base)

    @a.on("approve")
    async def _(req, who):
        return Decision(f"approved {req.payload.title}", {"by": who.id})

    @a.on("deny")
    async def _(req, who):
        return Decision("denied")

    return a, cards


def _client(a: Approvals, *, approver: bool = True) -> httpx.AsyncClient:
    async def authed() -> Identity:
        return Identity(conversation_id="", namespace="t", service_account="sa", is_approver=approver)

    class _P:
        name = "echo"

    app = FastAPI()
    app.include_router(a.routes(_P(), authed=authed), prefix="/echo")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://broker")


def _as(who: str) -> dict:
    return {"approver": {"id": who, "email": f"{who}@x"}}


async def test_request_raises_a_card_and_lists_as_pending():
    a, cards = await _approvals()
    req = await a.request(CONV, Thing("x"), owner="alice")
    assert cards.raised == [{"conversation_id": CONV, "contrib": "echo", "request_id": req.id,
                             "message": "Do x?", "kind": "echo.thing", "data": {"title": "x"}}]
    async with _client(a) as c:
        r = await c.get("/echo/approvals/pending", params={"conversation_id": CONV})
    assert [x["request_id"] for x in r.json()["requests"]] == [req.id]


async def test_owner_approves_once_and_the_agent_is_told():
    a, _ = await _approvals()
    req = await a.request(CONV, Thing("x"), owner="alice")
    async with _client(a) as c:
        assert (await c.post(f"/echo/approvals/{req.id}/can-approve", json=_as("alice"))).json() == {"can_approve": True}
        r = await c.post(f"/echo/approvals/{req.id}/approve", json=_as("alice"))
        assert r.json() == {"by": "alice", "status": "approve", "agent_message": "approved x"}
        # A second click races the first, which stands.
        assert (await c.post(f"/echo/approvals/{req.id}/deny", json=_as("alice"))).status_code == 409
        pending = await c.get("/echo/approvals/pending", params={"conversation_id": CONV})
    assert pending.json() == {"requests": []}
    assert (await a.get(req.id)).decided_by == "alice"


async def test_only_may_approve_can_press_the_gated_verb_but_anyone_can_deny():
    a, _ = await _approvals()
    req = await a.request(CONV, Thing("x"), owner="alice")
    async with _client(a) as c:
        assert (await c.post(f"/echo/approvals/{req.id}/can-approve", json=_as("bob"))).json() == {"can_approve": False}
        assert (await c.post(f"/echo/approvals/{req.id}/approve", json=_as("bob"))).status_code == 403
        assert (await a.get(req.id)).status == "pending"
        assert (await c.post(f"/echo/approvals/{req.id}/deny", json=_as("bob"))).json()["agent_message"] == "denied"


async def test_routes_take_approver_callers_only():
    a, _ = await _approvals()
    async with _client(a, approver=False) as c:
        assert (await c.get("/echo/approvals/pending", params={"conversation_id": CONV})).status_code == 403


async def test_an_answer_needs_an_approver_and_a_known_verb():
    a, _ = await _approvals()
    req = await a.request(CONV, Thing("x"), owner="alice")
    async with _client(a) as c:
        assert (await c.post(f"/echo/approvals/{req.id}/approve", json={})).status_code == 400
        assert (await c.post(f"/echo/approvals/{req.id}/maybe", json=_as("alice"))).status_code == 400
        assert (await c.post("/echo/approvals/nope/approve", json=_as("alice"))).status_code == 404


async def test_an_expired_request_leaves_pending_and_tells_the_agent_when_answered():
    a, _ = await _approvals(expires_after=timedelta(0))
    req = await a.request(CONV, Thing("x"), owner="alice")
    assert await a.pending(conversation_id=CONV) == []
    async with _client(a) as c:
        assert (await c.post(f"/echo/approvals/{req.id}/can-approve", json=_as("alice"))).json() == {"can_approve": False}
        r = await c.post(f"/echo/approvals/{req.id}/approve", json=_as("alice"))
    assert r.json()["status"] == "expired" and "expired" in r.json()["agent_message"]
    assert (await a.get(req.id)).status == "expired"


async def test_max_pending_counts_open_requests_per_conversation():
    a, _ = await _approvals(max_pending=1)
    await a.request(CONV, Thing("x"), owner="alice")
    with pytest.raises(TooManyPending):
        await a.request(CONV, Thing("y"), owner="alice")
    await a.request("c-2", Thing("y"), owner="alice")


async def test_a_failing_handler_marks_the_request_failed_and_says_so():
    a, _ = await _approvals()

    @a.on("approve")
    async def _(req, who):
        raise RuntimeError("router down")

    req = await a.request(CONV, Thing("x"), owner="alice")
    out = await a.answer(req.id, "approve", Approver("alice"))
    assert out["status"] == "failed" and out["agent_message"].endswith("failed: router down")
    assert (await a.get(req.id)).status == "failed"


async def test_withdraw_retires_the_request_and_its_card():
    a, cards = await _approvals()
    req = await a.request(CONV, Thing("x"), owner="alice")
    await a.withdraw(req)
    await a.withdraw(req)
    assert cards.withdrawn == [req.id]
    assert (await a.get(req.id)).status == "withdrawn"
    assert await a.pending(owner="alice") == []


async def test_host_cards_retry_a_5xx_then_post_the_card():
    calls: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(503 if len(calls) == 1 else 202)

    cards = HostCards("http://host", transport=httpx.MockTransport(handle))
    await cards.raise_(CONV, "echo", {"request_id": "r1", "message": "m"})
    assert [c.url.path for c in calls] == [f"/conversations/{CONV}/approvals/echo"] * 2


async def test_contribs_sharing_the_table_see_only_their_own_requests(tmp_path):
    config = StoreConfig(dsn=f"sqlite+aiosqlite:///{tmp_path}/broker.db")
    mine, theirs = (
        Approvals(contrib=c, kind=f"{c}.thing", payload=Thing, render=lambda r: Card("?"))
        for c in ("echo", "other")
    )
    for a in (mine, theirs):
        a.configure(config)
        a.on("approve")(lambda req, who: _decided())
    await create_schema(mine, Base)
    req = await mine.request(CONV, Thing("x"), owner="alice")

    assert await theirs.pending(conversation_id=CONV) == []
    assert await theirs.get(req.id) is None
    with pytest.raises(HTTPException) as e:
        await theirs.answer(req.id, "approve", Approver("alice"))
    assert e.value.status_code == 404
    assert [r.id for r in await mine.pending(conversation_id=CONV)] == [req.id]


async def _decided() -> Decision:
    return Decision("approved")
