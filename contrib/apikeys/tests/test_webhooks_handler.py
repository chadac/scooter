"""The endpoint relays only owned conversations, only within a key's scopes, and never an approval."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_contrib_apikeys import webhooks_handler as wh
from scooter_contrib_apikeys.webhooks_handler import Caller, Gateway

KEYS = {
    "sct_rw": Caller("alice", "rw", ("read", "write")),
    "sct_ro": Caller("alice", "ro", ("read",)),
}
CONVS = {"c-alice": "alice", "c-bob": "bob"}
HISTORY = {"events": [
    {"type": "RUN_FINISHED", "outcome": {"type": "interrupt", "interrupts": [
        {"id": "q1", "metadata": {"kind": "ask-user.questions"}},
        {"id": "perm1", "metadata": {}},
        {"id": "aws1", "metadata": {"kind": "aws.permissions"}},
    ]}},
]}


class FakeRouter:
    """The conversation-router as webhooks sees it: records each call."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.stream_forever = False

    async def handle(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req)
        path, user = req.url.path, req.headers.get("x-scooter-user")
        assert req.headers["authorization"] == "Bearer webhooks-sa"
        if path == "/conversations" and req.method == "GET":
            return httpx.Response(200, json=[{"id": c, "owner": o} for c, o in CONVS.items()])
        if path == "/conversations" and req.method == "POST":
            return httpx.Response(200, json={"id": "c-new", "body": json.loads(req.content)})
        if path.endswith("/events.integrity"):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=self._events())
        conv = path.split("/")[2] if path.startswith("/conversations/") else ""
        if conv and conv not in CONVS:
            return httpx.Response(404, json={"error": "not found"})
        if path == f"/conversations/{conv}" and req.method == "GET":
            return httpx.Response(200, json={"id": conv, "owner": CONVS[conv], "viewer": user})
        if path.endswith("/history"):
            return httpx.Response(200, json=HISTORY)
        return httpx.Response(200, json={"ok": True, "path": path})

    def _events(self):
        forever = self.stream_forever

        class Events(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'data: {"seq": 1}\n\n'
                if forever:
                    await asyncio.Event().wait()

        return Events()


@pytest.fixture
def router():
    return FakeRouter()


@pytest.fixture
def gw(router):
    revoked: set[str] = set()

    async def verify(key: str, ip: str | None):
        return None if key in revoked else KEYS.get(key)

    g = Gateway(
        verify_remote=verify,
        upstream=httpx.AsyncClient(transport=httpx.MockTransport(router.handle), base_url="http://router"),
        upstream_headers=lambda: {"authorization": "Bearer webhooks-sa"},
    )
    g.revoked = revoked
    wh.install(g)
    yield g
    wh.install(None)


def client(key: str | None = "sct_rw") -> AsyncClient:
    app = FastAPI()
    app.include_router(wh.router)
    headers = {"authorization": f"Bearer {key}"} if key else {}
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://webhooks" + wh.PREFIX, headers=headers)


async def test_a_bad_or_missing_key_is_refused(gw):
    for key in [None, "sct_nope"]:
        async with client(key) as c:
            r = await c.get("/whoami")
        assert r.status_code == 401


async def test_calls_go_upstream_as_the_keys_user(gw, router):
    async with client() as c:
        r = await c.get("/conversations/c-alice")
    assert r.json()["viewer"] == "alice"
    assert all(req.headers["x-scooter-user"] == "alice" for req in router.calls)


async def test_another_users_conversation_is_not_found(gw):
    async with client() as c:
        for method, path in [("GET", "/conversations/c-bob"), ("GET", "/conversations/c-bob/history"),
                             ("POST", "/conversations/c-bob/cancel"), ("GET", "/conversations/c-bob/events.integrity")]:
            assert (await c.request(method, path)).status_code == 404, path


async def test_the_list_holds_only_owned_conversations(gw):
    async with client() as c:
        assert [r["id"] for r in (await c.get("/conversations?scope=all")).json()] == ["c-alice"]


async def test_a_new_conversation_never_takes_an_owner_from_the_body(gw):
    async with client() as c:
        r = await c.post("/conversations", json={"title": "t", "owner": "bob"})
    assert r.json()["body"] == {"title": "t"}


async def test_a_read_only_key_cannot_write(gw):
    async with client("sct_ro") as c:
        assert (await c.get("/conversations/c-alice/history")).status_code == 200
        assert (await c.post("/conversations/c-alice/messages", json={"text": "hi"})).status_code == 403
        assert (await c.post("/conversations", json={})).status_code == 403


async def test_only_cancel_and_suspend_are_relayed(gw):
    async with client() as c:
        assert (await c.post("/conversations/c-alice/suspend")).status_code == 200
        assert (await c.post("/conversations/c-alice/restart")).status_code == 404


async def test_a_key_answers_a_question(gw, router):
    entry = {"interruptId": "q1", "status": "resolved", "payload": {"optionId": "answer"}}
    async with client() as c:
        r = await c.post("/agui", json={"threadId": "c-alice", "resume": [entry]})
    assert r.status_code == 200
    assert json.loads(router.calls[-1].content) == {"threadId": "c-alice", "resume": [entry]}


@pytest.mark.parametrize("interrupt", ["perm1", "aws1", "unknown"])
async def test_a_key_never_answers_an_approval(gw, router, interrupt):
    for status in ["resolved", "cancelled"]:
        async with client() as c:
            r = await c.post("/agui", json={"threadId": "c-alice", "resume": [{"interruptId": interrupt, "status": status}]})
        assert r.status_code == 403
    assert all(req.url.path != "/agui" for req in router.calls)


async def test_agui_takes_no_new_run(gw):
    async with client() as c:
        r = await c.post("/agui", json={"threadId": "c-alice", "resume": [{"interruptId": "q1"}], "messages": []})
    assert r.status_code == 400


async def test_the_stream_is_relayed(gw):
    async with client() as c:
        r = await c.get("/conversations/c-alice/events.integrity?afterSeq=3&checksum=" + "a" * 64)
    assert r.status_code == 200
    assert r.headers["x-accel-buffering"] == "no"
    assert r.text == 'data: {"seq": 1}\n\n'
    assert gw.streams == {}


async def test_revoking_a_key_closes_its_open_stream(gw, router, monkeypatch):
    monkeypatch.setattr(wh, "VERIFY_TTL_S", 0.05)
    router.stream_forever = True

    async def revoke_soon():
        await asyncio.sleep(0.1)
        gw.revoked.add("sct_rw")

    task = asyncio.create_task(revoke_soon())
    async with client() as c:
        r = await asyncio.wait_for(c.get("/conversations/c-alice/events.integrity"), timeout=5)
    await task
    assert r.text == 'data: {"seq": 1}\n\n'
    assert gw.streams == {}


async def test_open_streams_are_capped_per_key(gw, monkeypatch):
    monkeypatch.setattr(wh, "STREAMS_PER_KEY", 0)
    async with client() as c:
        assert (await c.get("/conversations/c-alice/events.integrity")).status_code == 429


async def test_repeated_bad_keys_are_rate_limited(gw):
    async with client("sct_nope") as c:
        codes = [(await c.get("/whoami")).status_code for _ in range(25)]
    assert codes[:20] == [401] * 20 and set(codes[20:]) == {429}


async def test_failures_are_limited_per_client_not_per_ingress(gw):
    async with client("sct_nope") as c:
        for _ in range(20):
            await c.get("/whoami", headers={"x-forwarded-for": "6.6.6.6, 203.0.113.9"})
        assert (await c.get("/whoami", headers={"x-forwarded-for": "1.1.1.1, 203.0.113.9"})).status_code == 429
    async with client() as c:
        assert (await c.get("/conversations", headers={"x-forwarded-for": "198.51.100.2"})).status_code == 200


async def test_star_and_retitle_take_one_typed_field(gw, router):
    async with client() as c:
        assert (await c.patch("/conversations/c-alice/starred", json={"starred": True, "owner": "bob"})).status_code == 200
        assert json.loads(router.calls[-1].content) == {"starred": True}
        assert (await c.patch("/conversations/c-alice/title", json={"title": 3})).status_code == 400
        assert (await c.patch("/conversations/c-alice/visibility", json={"visibility": "shared"})).status_code == 404
        assert (await c.patch("/conversations/c-bob/title", json={"title": "x"})).status_code == 404
    async with client("sct_ro") as c:
        assert (await c.patch("/conversations/c-alice/title", json={"title": "x"})).status_code == 403
