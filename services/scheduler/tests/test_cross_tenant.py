"""Tier 1 — cross-tenant isolation: user B must not see or mutate user A's task.

Deliberately uses TWO identities. test_api.py drives everything as a single user
(AUTH = alice), which is why it never noticed that the read/write paths ignore
x-auth-user entirely.
"""

import httpx
import pytest
import pytest_asyncio

import scheduler.app as appmod
from scheduler.store import Store


@pytest_asyncio.fixture
async def client(monkeypatch):
    store = Store("sqlite+aiosqlite:///:memory:")
    await store.init()
    appmod.app.state.store = store

    async def fake_spawn(prompt, *, title, owner, client=None):
        return "conv-fake"

    monkeypatch.setattr(appmod, "spawn_conversation", fake_spawn)

    transport = httpx.ASGITransport(app=appmod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        yield c
    await store.dispose()


ALICE = {"x-auth-user": "alice"}
BOB = {"x-auth-user": "bob"}


@pytest_asyncio.fixture
async def alice_task(client):
    r = await client.post(
        "/tasks",
        json={"title": "alice-private", "prompt": "alice secret prompt", "cron": "0 9 * * *"},
        headers=ALICE,
    )
    assert r.status_code == 200, r.text
    assert r.json()["owner"] == "alice"
    return r.json()["id"]


@pytest.mark.asyncio
async def test_list_is_scoped_to_the_caller(client, alice_task):
    """GET /tasks must return only the caller's own tasks."""
    r = await client.get("/tasks", headers=BOB)
    assert r.status_code == 200
    assert [t["title"] for t in r.json()] == []


@pytest.mark.asyncio
async def test_cannot_read_another_users_task(client, alice_task):
    r = await client.get(f"/tasks/{alice_task}", headers=BOB)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_cannot_patch_another_users_task(client, alice_task):
    r = await client.patch(f"/tasks/{alice_task}", json={"prompt": "PWNED"}, headers=BOB)
    assert r.status_code == 404
    # ...and the original prompt is untouched.
    check = await client.get(f"/tasks/{alice_task}", headers=ALICE)
    assert check.json()["prompt"] == "alice secret prompt"


@pytest.mark.asyncio
async def test_cannot_delete_another_users_task(client, alice_task):
    r = await client.delete(f"/tasks/{alice_task}", headers=BOB)
    assert r.status_code == 404
    check = await client.get(f"/tasks/{alice_task}", headers=ALICE)
    assert check.status_code == 200


@pytest.mark.asyncio
async def test_cannot_read_another_users_runs(client, alice_task):
    r = await client.get(f"/tasks/{alice_task}/runs", headers=BOB)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_cannot_trigger_another_users_task(client, alice_task):
    """run-now on someone else's task would spawn a conversation as THEM."""
    r = await client.post(f"/tasks/{alice_task}/run", headers=BOB)
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_owner_still_has_full_access(client, alice_task):
    """The isolation must not break the legitimate path."""
    assert (await client.get(f"/tasks/{alice_task}", headers=ALICE)).status_code == 200
    assert [t["title"] for t in (await client.get("/tasks", headers=ALICE)).json()] == ["alice-private"]
    assert (await client.patch(f"/tasks/{alice_task}", json={"title": "renamed"}, headers=ALICE)).status_code == 200
    assert (await client.get(f"/tasks/{alice_task}/runs", headers=ALICE)).status_code == 200
    assert (await client.delete(f"/tasks/{alice_task}", headers=ALICE)).status_code == 204


@pytest.mark.asyncio
async def test_anonymous_is_a_scope_not_a_wildcard(client, alice_task):
    """No x-auth-user maps to the unowned ("") bucket — which must NOT see alice's
    tasks. Otherwise a deployment without ingress auth silently reads everything."""
    r = await client.get("/tasks")  # no x-auth-user at all
    assert r.status_code == 200
    assert [t["title"] for t in r.json()] == []
    assert (await client.get(f"/tasks/{alice_task}")).status_code == 404

    # ...and the anonymous bucket is usable in its own right.
    mine = await client.post("/tasks", json={"title": "anon", "prompt": "p", "cron": "0 9 * * *"})
    assert mine.status_code == 200
    assert mine.json()["owner"] == ""
    assert [t["title"] for t in (await client.get("/tasks")).json()] == ["anon"]
    # An empty header is the same bucket as an absent one.
    assert [t["title"] for t in (await client.get("/tasks", headers={"x-auth-user": ""})).json()] == ["anon"]
