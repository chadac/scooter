"""Unit test for the module registry store (SQLite in-memory): publish (version
bump, name-ownership-immutable, minted numeric id), resolve-by-name-or-id, and the
visibility-gated list."""

from __future__ import annotations

import pytest

from broker.aws.store import StoreConfig
from broker.registry.store import ModuleRegistryStore


@pytest.fixture
async def store():
    s = ModuleRegistryStore(StoreConfig(dsn="sqlite+aiosqlite:///:memory:"))
    await s.init()
    return s


def _pub(store, name, owner, vis="private", files=None, desc=""):
    return store.publish(owner=owner, name=name, description=desc,
                         visibility=vis, files=files or {"module.nix": "{...}: {}"})


@pytest.mark.asyncio
async def test_publish_mints_id_then_resolves_by_name_or_id(store):
    m = await _pub(store, "marimo", "conv-alice", files={"module.nix": "AAA"})
    assert m.name == "marimo" and m.owner == "conv-alice" and m.version == 1
    assert isinstance(m.id, int)
    # resolve by NAME
    by_name = await store.get("marimo")
    assert by_name.id == m.id
    # resolve by numeric ID
    by_id = await store.get(str(m.id))
    assert by_id.name == "marimo"
    # files by either
    assert await store.get_files("marimo") == {"module.nix": "AAA"}
    assert await store.get_files(str(m.id)) == {"module.nix": "AAA"}


@pytest.mark.asyncio
async def test_missing_is_none(store):
    assert await store.get("nope") is None
    assert await store.get("999") is None
    assert await store.get_files("nope") is None


@pytest.mark.asyncio
async def test_republish_bumps_version_keeps_id(store):
    m1 = await _pub(store, "marimo", "conv-alice", files={"module.nix": "v1"})
    m2 = await _pub(store, "marimo", "conv-alice", files={"module.nix": "v2"})
    assert m2.version == 2 and m2.id == m1.id  # same module, new version
    assert (await store.get("marimo")).files == {"module.nix": "v2"}


@pytest.mark.asyncio
async def test_name_is_globally_unique_first_publisher_owns(store):
    await _pub(store, "marimo", "conv-alice")
    with pytest.raises(PermissionError):
        await _pub(store, "marimo", "conv-bob")  # bob can't take alice's name


@pytest.mark.asyncio
async def test_list_visibility(store):
    await _pub(store, "a-priv", "conv-alice", vis="private")
    await _pub(store, "a-pub", "conv-alice", vis="public")
    await _pub(store, "b-priv", "conv-bob", vis="private")
    await _pub(store, "b-pub", "conv-bob", vis="public")

    names = {m.name for m in await store.list_visible("conv-alice")}
    assert names == {"a-priv", "a-pub", "b-pub"}  # NOT b-priv


@pytest.mark.asyncio
async def test_list_query_filters(store):
    await _pub(store, "marimo-notebook", "conv-alice", desc="data viz")
    await _pub(store, "jupyter", "conv-alice")
    hits = [m.name for m in await store.list_visible("conv-alice", query="MARIMO")]
    assert hits == ["marimo-notebook"]
    assert {m.name for m in await store.list_visible("conv-alice", query="viz")} == {"marimo-notebook"}
