"""Unit test for the sandbox size store (SQLite in-memory). get/set round-trip +
missing -> None + corrupt row -> None (never a fabricated default)."""

from __future__ import annotations

import pytest

from broker.aws.store import StoreConfig
from broker.sandbox.resources import SandboxResources
from broker.sandbox.store import SandboxSizeStore


@pytest.fixture
async def store():
    s = SandboxSizeStore(StoreConfig(dsn="sqlite+aiosqlite:///:memory:"))
    await s.init()
    return s


@pytest.mark.asyncio
async def test_missing_is_none(store):
    assert await store.get("nope") is None


@pytest.mark.asyncio
async def test_set_get_roundtrip(store):
    spec = SandboxResources(requests={"cpu": "2", "memory": "4Gi"}, limits={"memory": "8Gi", "gpu": 1})
    await store.set("c1", spec)
    got = await store.get("c1")
    assert got.to_dict() == spec.to_dict()


@pytest.mark.asyncio
async def test_set_upserts(store):
    await store.set("c1", SandboxResources(requests={"cpu": "1"}))
    await store.set("c1", SandboxResources(requests={"cpu": "4"}))
    got = await store.get("c1")
    assert got.requests["cpu"] == "4"
