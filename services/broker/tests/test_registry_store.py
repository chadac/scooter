"""Unit test for the module registry store (SQLite in-memory): create/publish
(version bump, ownership-immutable), get/get_files, and the visibility-gated list."""

from __future__ import annotations

import pytest

from broker.aws.store import StoreConfig
from broker.registry.store import ModuleRegistryStore


@pytest.fixture
async def store():
    s = ModuleRegistryStore(StoreConfig(dsn="sqlite+aiosqlite:///:memory:"))
    await s.init()
    return s


def _upsert(store, mid, owner, name="mod", vis="private", files=None, desc=""):
    return store.upsert(module_id=mid, owner=owner, name=name, description=desc,
                        visibility=vis, files=files or {"module.nix": "{...}: {}"})


@pytest.mark.asyncio
async def test_create_then_get(store):
    m = await _upsert(store, "m1", "alice", files={"module.nix": "AAA"})
    assert m.version == 1 and m.owner == "alice"
    got = await store.get("m1")
    assert got.files == {"module.nix": "AAA"}
    assert await store.get_files("m1") == {"module.nix": "AAA"}


@pytest.mark.asyncio
async def test_missing_is_none(store):
    assert await store.get("nope") is None
    assert await store.get_files("nope") is None


@pytest.mark.asyncio
async def test_republish_bumps_version(store):
    await _upsert(store, "m1", "alice", files={"module.nix": "v1"})
    m2 = await _upsert(store, "m1", "alice", files={"module.nix": "v2"})
    assert m2.version == 2
    assert (await store.get("m1")).files == {"module.nix": "v2"}


@pytest.mark.asyncio
async def test_republish_by_other_owner_rejected(store):
    await _upsert(store, "m1", "alice")
    with pytest.raises(PermissionError):
        await _upsert(store, "m1", "bob")


@pytest.mark.asyncio
async def test_list_visibility(store):
    await _upsert(store, "a-priv", "alice", vis="private")
    await _upsert(store, "a-pub", "alice", vis="public")
    await _upsert(store, "b-priv", "bob", vis="private")
    await _upsert(store, "b-pub", "bob", vis="public")

    ids = {m.id for m in await store.list_visible("alice")}
    assert "a-priv" in ids   # own private
    assert "a-pub" in ids     # own public
    assert "b-pub" in ids     # others' public
    assert "b-priv" not in ids  # others' private — hidden


@pytest.mark.asyncio
async def test_list_query_filters(store):
    await _upsert(store, "m1", "alice", name="marimo-notebook", desc="data viz")
    await _upsert(store, "m2", "alice", name="jupyter")
    hits = [m.name for m in await store.list_visible("alice", query="MARIMO")]
    assert hits == ["marimo-notebook"]
    # matches description too
    assert {m.id for m in await store.list_visible("alice", query="viz")} == {"m1"}
