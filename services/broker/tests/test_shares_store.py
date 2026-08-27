"""Unit tests for the static-shares store + HTTP API (SQLite in-memory):
UUID minting, versioning (root serves latest), owner-scoping, inline + zip
ingest, path-traversal guards, and the unauthenticated /s/<uuid>/ serve path."""

from __future__ import annotations

import base64
import io
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from broker.aws.store import StoreConfig
from broker.core.auth import authenticate
from broker.core.types import Identity
from broker.shares.routes import create_shares_router
from broker.shares.store import ShareFile, ShareStore


def _identity(conv: str) -> Identity:
    return Identity(conversation_id=conv, namespace="agent-sandbox",
                    service_account=f"system:serviceaccount:agent-sandbox:sandbox-{conv}")


@pytest.fixture
async def store():
    s = ShareStore(StoreConfig(dsn="sqlite+aiosqlite:///:memory:"))
    await s.init()
    return s


def _client(store, conv="conv-alice"):
    app = FastAPI()
    app.include_router(create_shares_router(store, public_base_url="https://scooter.example.com"))
    app.dependency_overrides[authenticate] = lambda: _identity(conv)
    return TestClient(app)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _inline(html: str) -> dict:
    return {"files": {"index.html": {"content_type": "text/html", "b64": _b64(html.encode())}}}


def _zip_b64(entries: dict[str, bytes]) -> str:
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return _b64(raw.getvalue())


# --- store ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_mints_uuid_and_serves_latest(store):
    files = {"index.html": ShareFile("index.html", "text/html", b"v1")}
    share = await store.create(owner="conv-a", conversation_id="conv-a", description="d",
                               visibility="public", files=files, entry_point="index.html")
    assert share.uuid and share.latest_version == 1
    ver = await store.get_version(share.uuid)  # None => latest
    assert ver.version == 1 and ver.files["index.html"].data == b"v1"


@pytest.mark.asyncio
async def test_add_version_bumps_and_keeps_uuid(store):
    files = {"index.html": ShareFile("index.html", "text/html", b"v1")}
    share = await store.create(owner="conv-a", conversation_id="conv-a", description="",
                               visibility="public", files=files, entry_point="index.html")
    files2 = {"index.html": ShareFile("index.html", "text/html", b"v2")}
    updated = await store.add_version(share.uuid, owner="conv-a", files=files2, entry_point="index.html")
    assert updated.uuid == share.uuid and updated.latest_version == 2
    assert (await store.get_version(share.uuid)).files["index.html"].data == b"v2"      # latest
    assert (await store.get_version(share.uuid, 1)).files["index.html"].data == b"v1"   # pinned


@pytest.mark.asyncio
async def test_update_is_owner_scoped(store):
    files = {"index.html": ShareFile("index.html", "text/html", b"x")}
    share = await store.create(owner="conv-a", conversation_id="conv-a", description="",
                               visibility="public", files=files, entry_point="index.html")
    with pytest.raises(PermissionError):
        await store.add_version(share.uuid, owner="conv-b", files=files, entry_point="index.html")


@pytest.mark.asyncio
async def test_missing_is_none(store):
    assert await store.get("nope") is None
    assert await store.get_version("nope") is None


# --- routes -----------------------------------------------------------------

@pytest.mark.asyncio
async def test_publish_then_serve_unauthenticated(store):
    c = _client(store)
    r = c.post("/shares", json=_inline("<h1>hi</h1>"))
    assert r.status_code == 201, r.text
    uuid = r.json()["uuid"]
    assert r.json()["url"] == f"https://scooter.example.com/s/{uuid}/"
    # serve path takes NO auth override effect — it's open by capability URL
    served = c.get(f"/s/{uuid}/")
    assert served.status_code == 200 and served.text == "<h1>hi</h1>"
    assert served.headers["content-type"].startswith("text/html")


@pytest.mark.asyncio
async def test_update_serves_new_version_at_root(store):
    c = _client(store)
    uuid = c.post("/shares", json=_inline("one")).json()["uuid"]
    c.put(f"/shares/{uuid}", json=_inline("two"))
    assert c.get(f"/s/{uuid}/").text == "two"       # root = latest
    assert c.get(f"/s/{uuid}/v/1/").text == "one"   # old version pinned
    assert c.get(f"/s/{uuid}/v/2/").text == "two"


@pytest.mark.asyncio
async def test_zip_ingest_multifile(store):
    c = _client(store)
    zb = _zip_b64({"index.html": b"<img src=chart.png>", "chart.png": b"\x89PNG..."})
    r = c.post("/shares", json={"zip_b64": zb})
    assert r.status_code == 201, r.text
    uuid = r.json()["uuid"]
    assert c.get(f"/s/{uuid}/").text == "<img src=chart.png>"          # entry = index.html
    assert c.get(f"/s/{uuid}/chart.png").content == b"\x89PNG..."      # asset by path


@pytest.mark.asyncio
async def test_zip_traversal_rejected(store):
    c = _client(store)
    r = c.post("/shares", json={"zip_b64": _zip_b64({"../evil.html": b"x"})})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_disallowed_extension_rejected(store):
    c = _client(store)
    r = c.post("/shares", json={"files": {"run.sh": {"content_type": "text/x-sh", "b64": _b64(b"echo hi")}}})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_list_and_delete_owner_scoped(store):
    alice = _client(store, "conv-alice")
    uuid = alice.post("/shares", json=_inline("mine")).json()["uuid"]
    assert any(s["uuid"] == uuid for s in alice.get("/shares").json()["shares"])
    # bob can't see or delete alice's share
    bob = _client(store, "conv-bob")
    assert bob.get(f"/shares/{uuid}").status_code == 404
    assert bob.delete(f"/shares/{uuid}").status_code == 404
    # alice can
    assert alice.delete(f"/shares/{uuid}").status_code == 204
    assert alice.get(f"/s/{uuid}/").status_code == 404
