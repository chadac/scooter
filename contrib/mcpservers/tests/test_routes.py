"""Only the relay manages servers; a sandbox reads its owner's enabled ones."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_mcpservers.store import MAX_SERVERS, McpServerStore, _Base
from scooter_contrib_mcpservers.transport import McpServers

VIEWS = {
    "alice-private": {"owner": "alice", "visibility": "private"},
    "alice-shared": {"owner": "alice", "visibility": "shared"},
    "bob-private": {"owner": "bob", "visibility": "private"},
}


async def fetch(conv: str):
    return VIEWS.get(conv)


@pytest.fixture
async def app():
    store = McpServerStore(sqlite_config())
    await create_schema(store, _Base)
    transport = McpServers(store=store, owners=OwnerResolver(fetch, ttl=0))
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(
        transport.routes(Provider(name="mcpservers", transports=[transport]), authed), prefix="/mcpservers"
    )
    a.state.caller = caller
    return a


def client(app, *, user: str | None = None, conv: str = "") -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id=conv, namespace="ns", service_account="sa", relayed_user=user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


async def add(app, user: str, **body) -> dict:
    async with client(app, user=user) as c:
        r = await c.post(
            "/mcpservers/user/servers", json={"name": "time", "kind": "nixpkgs", "spec": "mcp-server-time", **body}
        )
    assert r.status_code == 200, r.text
    return r.json()["server"]


async def test_user_routes_need_the_relay(app):
    async with client(app, conv="alice-private") as c:
        assert (await c.get("/mcpservers/user/servers")).status_code == 403


async def test_a_server_survives_add_patch_and_delete(app):
    srv = await add(app, "alice", args=["--local-timezone", "UTC"])
    assert srv["args"] == ["--local-timezone", "UTC"] and srv["enabled"] is True
    async with client(app, user="alice") as c:
        r = await c.patch(f"/mcpservers/user/servers/{srv['id']}", json={"enabled": False, "args": []})
        assert r.json()["server"]["enabled"] is False and r.json()["server"]["args"] == []
        assert [s["id"] for s in (await c.get("/mcpservers/user/servers")).json()["servers"]] == [srv["id"]]
        assert (await c.delete(f"/mcpservers/user/servers/{srv['id']}")).status_code == 200
        assert (await c.get("/mcpservers/user/servers")).json()["servers"] == []


async def test_one_user_cannot_touch_anothers_server(app):
    srv = await add(app, "alice")
    async with client(app, user="bob") as c:
        assert (await c.get("/mcpservers/user/servers")).json()["servers"] == []
        assert (await c.patch(f"/mcpservers/user/servers/{srv['id']}", json={"enabled": False})).status_code == 404
        assert (await c.delete(f"/mcpservers/user/servers/{srv['id']}")).status_code == 404


@pytest.mark.parametrize(
    "spec",
    [
        ("npm", "@modelcontextprotocol/server-everything"),
        ("npm", "@playwright/mcp@latest"),
        ("pypi", "mcp-server-fetch"),
        ("pypi", "mcp-server-git==2025.1.14"),
        ("nixpkgs", "python3Packages.mcp-server-fetch"),
    ],
)
async def test_published_package_specs_are_accepted(app, spec):
    kind, value = spec
    await add(app, "alice", kind=kind, spec=value)


@pytest.mark.parametrize(
    "body",
    [
        {"spec": "-g"},
        {"kind": "npm", "spec": "x;rm -rf /"},
        {"kind": "npm", "spec": "--yes"},
        {"kind": "pypi", "spec": "pkg --index-url http://evil"},
        {"kind": "nixpkgs", "spec": "github:evil/flake#x"},
        {"kind": "docker", "spec": "x"},
        {"name": "a:b"},
        {"name": "-x"},
        {"args": "--flag"},
        {"args": ["ok", "two\nlines"]},
    ],
)
async def test_bad_servers_are_refused_with_a_reason(app, body):
    async with client(app, user="alice") as c:
        r = await c.post(
            "/mcpservers/user/servers", json={"name": "time", "kind": "nixpkgs", "spec": "mcp-server-time", **body}
        )
    assert r.status_code == 400 and r.json()["detail"]


async def test_a_patch_with_bad_args_is_refused(app):
    srv = await add(app, "alice")
    async with client(app, user="alice") as c:
        r = await c.patch(f"/mcpservers/user/servers/{srv['id']}", json={"args": [1]})
    assert r.status_code == 400 and "args" in r.json()["detail"]


async def test_duplicate_names_and_the_cap_are_refused(app):
    await add(app, "alice")
    async with client(app, user="alice") as c:
        r = await c.post("/mcpservers/user/servers", json={"name": "time", "kind": "pypi", "spec": "mcp-server-time"})
        assert r.status_code == 400 and "already" in r.json()["detail"]
    for i in range(MAX_SERVERS - 1):
        await add(app, "alice", name=f"s{i}")
    async with client(app, user="alice") as c:
        r = await c.post("/mcpservers/user/servers", json={"name": "more", "kind": "npm", "spec": "x"})
    assert r.status_code == 400 and "at most" in r.json()["detail"]


async def test_a_sandbox_reads_its_owners_enabled_servers(app):
    on = await add(app, "alice", args=["--x"])
    off = await add(app, "alice", name="off")
    await add(app, "bob", name="bobs")
    async with client(app, user="alice") as c:
        await c.patch(f"/mcpservers/user/servers/{off['id']}", json={"enabled": False})
    for conv in ("alice-private", "alice-shared"):
        async with client(app, conv=conv) as c:
            r = await c.get("/mcpservers/servers")
        assert r.json() == {"servers": [{"name": on["name"], "kind": "nixpkgs", "spec": on["spec"], "args": ["--x"]}]}


async def test_an_unknown_conversation_gets_none(app):
    await add(app, "alice")
    async with client(app, conv="nobody") as c:
        assert (await c.get("/mcpservers/servers")).json() == {"servers": []}


async def report(app, conv: str, body: dict) -> int:
    async with client(app, conv=conv) as c:
        return (await c.post("/mcpservers/servers/status", json=body)).status_code


async def listing(app, conv: str, user: str = "alice") -> dict:
    async with client(app, user=user) as c:
        r = await c.get(f"/mcpservers/conversation/{conv}/servers")
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_panel_shows_each_server_with_its_last_reported_state(app):
    await add(app, "alice", name="time", args=["--secret", "s3"])
    await add(app, "alice", name="fetch", kind="pypi", spec="mcp-server-fetch")
    await add(app, "alice", name="old", enabled=False)
    assert (await listing(app, "alice-private"))["reported_at"] is None

    body = {"servers": [{"name": "time", "state": "active"}], "error": "x" * 500}
    assert await report(app, "alice-private", body) == 200
    got = await listing(app, "alice-private")
    assert got["reported_at"] and got["error"] == "x" * 300
    assert [(s["name"], s["state"]) for s in got["servers"]] == [("time", "active"), ("fetch", None), ("old", None)]
    assert got["servers"][0]["tool_prefix"] == "mcp__sandbox-time__"
    assert all("args" not in s for s in got["servers"])


async def test_a_report_replaces_the_last_and_stays_with_its_conversation(app):
    await add(app, "alice", name="time")
    await report(app, "alice-private", {"servers": [{"name": "time", "state": "active"}]})
    await report(app, "alice-private", {"servers": [{"name": "time", "state": "failed"}]})
    assert (await listing(app, "alice-private"))["servers"][0]["state"] == "failed"
    assert (await listing(app, "alice-shared"))["servers"][0]["state"] is None


async def test_only_a_sandbox_reports_and_only_a_wellformed_report(app):
    async with client(app, user="alice", conv="alice-private") as c:
        r = await c.post("/mcpservers/servers/status", json={"servers": []})
    assert r.status_code == 403
    assert await report(app, "alice-private", {"servers": [{"name": "../x", "state": "active"}]}) == 400
    assert await report(app, "alice-private", {"servers": [{"name": "time", "state": "ACTIVE; rm"}]}) == 400
    assert await report(app, "alice-private", {"servers": "nope"}) == 400


async def test_an_unknown_conversation_lists_nothing(app):
    await add(app, "alice", name="time")
    assert (await listing(app, "nobody"))["servers"] == []
