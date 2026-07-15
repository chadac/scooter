"""Unit tests for the module registry HTTP API — download (unauth), the
visibility-gated catalog, and publish (owner = caller's conversation)."""

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


async def _seed(store, mid, owner, **kw):
    await store.upsert(module_id=mid, owner=owner, name=kw.get("name", mid),
                       description=kw.get("desc", ""), visibility=kw.get("vis", "private"),
                       files=kw.get("files", {"module.nix": "{...}: {}"}))


@pytest.mark.asyncio
async def test_download_is_unauthenticated_and_tars_by_id(store):
    await _seed(store, "a", "conv-x", files={"module.nix": "AAA", "flake.nix": "{}"})
    await _seed(store, "b", "conv-y", files={"module.nix": "BBB"})
    # No auth override needed — download is unauthenticated.
    app = FastAPI()
    app.include_router(create_registry_router(store))
    resp = TestClient(app).get("/modules.tar.gz?ids=a,b")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/gzip"
    assert _tar_names(resp.content) == {"a/module.nix", "a/flake.nix", "b/module.nix"}


@pytest.mark.asyncio
async def test_download_missing_is_404(store):
    app = FastAPI()
    app.include_router(create_registry_router(store))
    assert TestClient(app).get("/modules.tar.gz?ids=nope").status_code == 404


@pytest.mark.asyncio
async def test_list_is_visibility_gated(store):
    await _seed(store, "a-priv", "conv-alice", vis="private")
    await _seed(store, "a-pub", "conv-alice", vis="public")
    await _seed(store, "b-priv", "conv-bob", vis="private")
    await _seed(store, "b-pub", "conv-bob", vis="public")
    ids = {m["id"] for m in _client(store, "conv-alice").get("/modules").json()["modules"]}
    assert ids == {"a-priv", "a-pub", "b-pub"}  # NOT b-priv
    # list summaries carry no files blob.
    assert all("files" not in m for m in _client(store, "conv-alice").get("/modules").json()["modules"])


@pytest.mark.asyncio
async def test_get_private_module_of_another_is_404(store):
    await _seed(store, "b-priv", "conv-bob", vis="private")
    assert _client(store, "conv-alice").get("/modules/b-priv").status_code == 404
    # bob CAN get his own
    assert _client(store, "conv-bob").get("/modules/b-priv").status_code == 200


@pytest.mark.asyncio
async def test_publish_stamps_owner_from_identity(store):
    c = _client(store, "conv-alice")
    resp = c.post("/modules", json={"id": "m1", "name": "mymod", "files": {"module.nix": "{...}: {}"}})
    assert resp.status_code == 201
    assert resp.json()["owner"] == "conv-alice"  # from the token, not the body
    # republish by a DIFFERENT conversation -> 403
    other = _client(store, "conv-bob")
    assert other.post("/modules", json={"id": "m1", "name": "x", "files": {"module.nix": "y"}}).status_code == 403


@pytest.mark.asyncio
async def test_publish_requires_module_nix(store):
    c = _client(store, "conv-alice")
    assert c.post("/modules", json={"id": "m1", "name": "x", "files": {"other.nix": "y"}}).status_code == 400
    assert c.post("/modules", json={"id": "m1", "name": "x"}).status_code == 400
    assert c.post("/modules", json={"id": "", "name": "x", "files": {"module.nix": "y"}}).status_code == 400


@pytest.mark.asyncio
async def test_publish_rejects_bad_visibility(store):
    c = _client(store, "conv-alice")
    r = c.post("/modules", json={"id": "m1", "name": "x", "visibility": "secret", "files": {"module.nix": "y"}})
    assert r.status_code == 400
