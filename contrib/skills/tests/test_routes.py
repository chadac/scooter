"""Only the relay manages sources; a sandbox reads its owner's enabled ones."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_skills.store import MAX_SOURCES, SkillSourceStore, _Base
from scooter_contrib_skills.transport import SkillSources

VIEWS = {
    "alice-private": {"owner": "alice", "visibility": "private"},
    "alice-shared": {"owner": "alice", "visibility": "shared"},
    "bob-private": {"owner": "bob", "visibility": "private"},
}


async def fetch(conv: str):
    return VIEWS.get(conv)


@pytest.fixture
async def app():
    store = SkillSourceStore(sqlite_config())
    await create_schema(store, _Base)
    transport = SkillSources(store=store, owners=OwnerResolver(fetch, ttl=0))
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(transport.routes(Provider(name="skills", transports=[transport]), authed), prefix="/skills")
    a.state.caller = caller
    return a


def client(app, *, user: str | None = None, conv: str = "") -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id=conv, namespace="ns", service_account="sa", relayed_user=user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


async def add(app, user: str, **body) -> dict:
    async with client(app, user=user) as c:
        r = await c.post("/skills/user/sources", json={"kind": "github", "spec": "acme/skills", **body})
    assert r.status_code == 200, r.text
    return r.json()["source"]


async def test_user_routes_need_the_relay(app):
    async with client(app, conv="alice-private") as c:
        assert (await c.get("/skills/user/sources")).status_code == 403


async def test_a_source_survives_add_patch_and_delete(app):
    src = await add(app, "alice", skills="pdf, docx,pdf")
    assert src["skills"] == ["pdf", "docx"] and src["enabled"] is True
    async with client(app, user="alice") as c:
        r = await c.patch(f"/skills/user/sources/{src['id']}", json={"enabled": False})
        assert r.json()["source"]["enabled"] is False
        assert [s["id"] for s in (await c.get("/skills/user/sources")).json()["sources"]] == [src["id"]]
        assert (await c.delete(f"/skills/user/sources/{src['id']}")).status_code == 200
        assert (await c.get("/skills/user/sources")).json()["sources"] == []


async def test_one_user_cannot_touch_anothers_source(app):
    src = await add(app, "alice")
    async with client(app, user="bob") as c:
        assert (await c.get("/skills/user/sources")).json()["sources"] == []
        assert (await c.patch(f"/skills/user/sources/{src['id']}", json={"enabled": False})).status_code == 404
        assert (await c.delete(f"/skills/user/sources/{src['id']}")).status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "skills.sh", "spec": "-g"},
        {"kind": "skills.sh", "spec": "x;rm"},
        {"kind": "github", "spec": "owner/repo/../../etc"},
        {"kind": "github", "spec": "just-a-name"},
        {"kind": "npm", "spec": "x"},
        {"kind": "github", "spec": "a/b", "skills": ["../x"]},
    ],
)
async def test_unsafe_specs_are_refused_with_a_reason(app, body):
    async with client(app, user="alice") as c:
        r = await c.post("/skills/user/sources", json=body)
    assert r.status_code == 400 and r.json()["detail"]


async def test_duplicates_and_the_cap_are_refused(app):
    await add(app, "alice")
    async with client(app, user="alice") as c:
        r = await c.post("/skills/user/sources", json={"kind": "github", "spec": "acme/skills"})
        assert r.status_code == 400 and "already" in r.json()["detail"]
    for i in range(MAX_SOURCES - 1):
        await add(app, "alice", spec=f"acme/s{i}")
    async with client(app, user="alice") as c:
        r = await c.post("/skills/user/sources", json={"kind": "github", "spec": "acme/one-more"})
    assert r.status_code == 400 and "at most" in r.json()["detail"]


async def test_a_sandbox_reads_its_owners_enabled_sources(app):
    on = await add(app, "alice", skills=["pdf"])
    off = await add(app, "alice", spec="acme/off")
    await add(app, "bob", spec="bob/only")
    async with client(app, user="alice") as c:
        await c.patch(f"/skills/user/sources/{off['id']}", json={"enabled": False})
    for conv in ("alice-private", "alice-shared"):
        async with client(app, conv=conv) as c:
            r = await c.get("/skills/sources")
        assert r.json() == {"sources": [{"kind": "github", "spec": on["spec"], "skills": ["pdf"]}]}


async def test_an_unknown_conversation_gets_none(app):
    await add(app, "alice")
    async with client(app, conv="nobody") as c:
        assert (await c.get("/skills/sources")).json() == {"sources": []}
