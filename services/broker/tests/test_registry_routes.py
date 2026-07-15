"""Unit tests for the module registry HTTP API — download (unauth, by name OR id),
the visibility-gated catalog, and publish (name = the unique id; owner = caller's
conversation)."""

from __future__ import annotations

import gzip
import io
import tarfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from broker.aws.store import StoreConfig
from broker.core.auth import authenticate
from broker.core.types import Identity
from broker.registry.routes import create_registry_router
from broker.registry.store import ModuleRegistryStore


def _identity(conv: str) -> Identity:
    return Identity(conversation_id=conv, namespace="agent-sandbox",
                    service_account=f"system:serviceaccount:agent-sandbox:sandbox-{conv}")


@pytest.fixture
async def store():
    s = ModuleRegistryStore(StoreConfig(dsn="sqlite+aiosqlite:///:memory:"))
    await s.init()
    return s


def _client(store, conv="conv-alice"):
    app = FastAPI()
    app.include_router(create_registry_router(store))
    app.dependency_overrides[authenticate] = lambda: _identity(conv)
    return TestClient(app)


def _tar_names(body: bytes) -> set[str]:
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(body)), mode="r") as t:
        return set(t.getnames())


async def _pub(store, name, owner, **kw):
    return await store.publish(owner=owner, name=name, description=kw.get("desc", ""),
                               visibility=kw.get("vis", "private"),
                               files=kw.get("files", {"module.nix": "{...}: {}"}))


@pytest.mark.asyncio
async def test_download_unauth_by_name_and_tars_by_name(store):
    await _pub(store, "a", "conv-x", files={"module.nix": "AAA", "flake.nix": "{}"})
    await _pub(store, "b", "conv-y", files={"module.nix": "BBB"})
    app = FastAPI()
    app.include_router(create_registry_router(store))  # no auth override — download is open
    resp = TestClient(app).get("/modules.tar.gz?ids=a,b")
    assert resp.status_code == 200
    assert _tar_names(resp.content) == {"a/module.nix", "a/flake.nix", "b/module.nix"}


@pytest.mark.asyncio
async def test_download_by_numeric_id_tars_under_name(store):
    m = await _pub(store, "marimo", "conv-x", files={"module.nix": "X"})
    app = FastAPI()
    app.include_router(create_registry_router(store))
    # ask by numeric id -> served, tar path is the NAME (canonical).
    resp = TestClient(app).get(f"/modules.tar.gz?ids={m.id}")
    assert _tar_names(resp.content) == {"marimo/module.nix"}


@pytest.mark.asyncio
async def test_download_missing_is_404(store):
    app = FastAPI()
    app.include_router(create_registry_router(store))
    assert TestClient(app).get("/modules.tar.gz?ids=nope").status_code == 404


@pytest.mark.asyncio
async def test_list_is_visibility_gated(store):
    await _pub(store, "a-priv", "conv-alice", vis="private")
    await _pub(store, "a-pub", "conv-alice", vis="public")
    await _pub(store, "b-priv", "conv-bob", vis="private")
    await _pub(store, "b-pub", "conv-bob", vis="public")
    names = {m["name"] for m in _client(store, "conv-alice").get("/modules").json()["modules"]}
    assert names == {"a-priv", "a-pub", "b-pub"}
    assert all("files" not in m for m in _client(store, "conv-alice").get("/modules").json()["modules"])


@pytest.mark.asyncio
async def test_get_by_name_or_id_private_gated(store):
    m = await _pub(store, "b-priv", "conv-bob", vis="private")
    # alice can't see bob's private -> 404 (by name AND by id)
    assert _client(store, "conv-alice").get("/modules/b-priv").status_code == 404
    assert _client(store, "conv-alice").get(f"/modules/{m.id}").status_code == 404
    # bob can, by either ref
    assert _client(store, "conv-bob").get("/modules/b-priv").status_code == 200
    assert _client(store, "conv-bob").get(f"/modules/{m.id}").status_code == 200


@pytest.mark.asyncio
async def test_publish_stamps_owner_and_name_is_unique(store):
    c = _client(store, "conv-alice")
    resp = c.post("/modules", json={"name": "mymod", "files": {"module.nix": "{...}: {}"}})
    assert resp.status_code == 201
    assert resp.json()["owner"] == "conv-alice"  # from the token, not the body
    assert isinstance(resp.json()["id"], int)     # minted numeric id
    # another conversation can't take the name -> 403
    other = _client(store, "conv-bob")
    assert other.post("/modules", json={"name": "mymod", "files": {"module.nix": "y"}}).status_code == 403


@pytest.mark.asyncio
async def test_republish_bumps_version(store):
    c = _client(store, "conv-alice")
    v1 = c.post("/modules", json={"name": "m", "files": {"module.nix": "v1"}}).json()
    v2 = c.post("/modules", json={"name": "m", "files": {"module.nix": "v2"}}).json()
    assert v2["version"] == 2 and v2["id"] == v1["id"]


@pytest.mark.asyncio
async def test_publish_requires_name_and_module_nix(store):
    c = _client(store, "conv-alice")
    assert c.post("/modules", json={"name": "x", "files": {"other.nix": "y"}}).status_code == 400
    assert c.post("/modules", json={"name": "x"}).status_code == 400
    assert c.post("/modules", json={"files": {"module.nix": "y"}}).status_code == 400


@pytest.mark.asyncio
async def test_publish_rejects_bad_visibility(store):
    c = _client(store, "conv-alice")
    r = c.post("/modules", json={"name": "x", "visibility": "secret", "files": {"module.nix": "y"}})
    assert r.status_code == 400
