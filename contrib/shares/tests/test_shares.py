"""The shares store and HTTP API on in-memory SQLite."""

from __future__ import annotations

import base64
import io
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity
from scooter_contrib_shares import store as shares_store
from scooter_contrib_shares.store import ShareFile, ShareStore
from scooter_contrib_shares.transport import _DEFAULT_FAVICON_LINK, create_shares_router


def _identity(conv: str) -> Identity:
    return Identity(conversation_id=conv, namespace="agent-sandbox",
                    service_account=f"system:serviceaccount:agent-sandbox:sandbox-{conv}")


@pytest.fixture
async def store():
    s = ShareStore(sqlite_config())
    await create_schema(s, shares_store._Base)
    return s


def _client(store, conv="conv-alice", frame_ancestors="'self'"):
    app = FastAPI()
    app.include_router(create_shares_router(
        store, authed=lambda: _identity(conv),
        public_base_url="https://scooter.example.com", frame_ancestors=frame_ancestors,
    ))
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
    ver = await store.get_version(share.uuid)
    assert ver.version == 1 and ver.files["index.html"].data == b"v1"


@pytest.mark.asyncio
async def test_add_version_bumps_and_keeps_uuid(store):
    files = {"index.html": ShareFile("index.html", "text/html", b"v1")}
    share = await store.create(owner="conv-a", conversation_id="conv-a", description="",
                               visibility="public", files=files, entry_point="index.html")
    files2 = {"index.html": ShareFile("index.html", "text/html", b"v2")}
    updated = await store.add_version(share.uuid, owner="conv-a", files=files2, entry_point="index.html")
    assert updated.uuid == share.uuid and updated.latest_version == 2
    assert (await store.get_version(share.uuid)).files["index.html"].data == b"v2"
    assert (await store.get_version(share.uuid, 1)).files["index.html"].data == b"v1"


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
    served = c.get(f"/s/{uuid}/")
    assert served.status_code == 200 and served.content == _DEFAULT_FAVICON_LINK + b"<h1>hi</h1>"
    assert served.headers["content-type"].startswith("text/html")


@pytest.mark.asyncio
async def test_update_serves_new_version_at_root(store):
    c = _client(store)
    uuid = c.post("/shares", json=_inline("one")).json()["uuid"]
    c.put(f"/shares/{uuid}", json=_inline("two"))
    assert c.get(f"/s/{uuid}/").content.endswith(b"two")
    assert c.get(f"/s/{uuid}/v/1/").content.endswith(b"one")
    assert c.get(f"/s/{uuid}/v/2/").content.endswith(b"two")


@pytest.mark.asyncio
async def test_zip_ingest_multifile(store):
    c = _client(store)
    zb = _zip_b64({"index.html": b"<img src=chart.png>", "chart.png": b"\x89PNG..."})
    r = c.post("/shares", json={"zip_b64": zb})
    assert r.status_code == 201, r.text
    uuid = r.json()["uuid"]
    assert c.get(f"/s/{uuid}/").content.endswith(b"<img src=chart.png>")
    assert c.get(f"/s/{uuid}/chart.png").content == b"\x89PNG..."


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
async def test_serve_sets_frame_ancestors_csp(store):
    c = _client(store, frame_ancestors="https://scooter.example.com")
    uuid = c.post("/shares", json=_inline("<h1>hi</h1>")).json()["uuid"]
    served = c.get(f"/s/{uuid}/")
    assert served.headers["content-security-policy"] == "frame-ancestors https://scooter.example.com"
    assert served.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_list_and_delete_owner_scoped(store):
    alice = _client(store, "conv-alice")
    uuid = alice.post("/shares", json=_inline("mine")).json()["uuid"]
    assert any(s["uuid"] == uuid for s in alice.get("/shares").json()["shares"])
    bob = _client(store, "conv-bob")
    assert bob.get(f"/shares/{uuid}").status_code == 404
    assert bob.delete(f"/shares/{uuid}").status_code == 404
    assert alice.delete(f"/shares/{uuid}").status_code == 204
    assert alice.get(f"/s/{uuid}/").status_code == 404


@pytest.mark.asyncio
async def test_every_change_tells_the_conversation_to_refetch(store):
    changed: list[str] = []

    async def on_change(conversation_id: str) -> None:
        changed.append(conversation_id)

    app = FastAPI()
    app.include_router(create_shares_router(store, authed=lambda: _identity("conv-alice"), on_change=on_change))
    c = TestClient(app)
    uuid = c.post("/shares", json=_inline("one")).json()["uuid"]
    c.put(f"/shares/{uuid}", json=_inline("two"))
    assert c.delete(f"/shares/{uuid}").status_code == 204
    assert changed == ["conv-alice", "conv-alice", "conv-alice"]
    # A refused change publishes nothing.
    assert c.delete(f"/shares/{uuid}").status_code == 404
    assert len(changed) == 3


def _relay_client(store, relayed_user="alice"):
    """The agent-host relaying a UI request, as the broker core authenticates it."""
    app = FastAPI()
    host = Identity(
        conversation_id="", namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:agent-host", relayed_user=relayed_user,
    )
    app.include_router(create_shares_router(
        store, authed=lambda: host, public_base_url="https://scooter.example.com",
    ))
    return TestClient(app)


@pytest.mark.asyncio
async def test_relay_lists_named_conversation_shares(store):
    alice = _client(store, "conv-alice")
    uuid = alice.post("/shares", json=_inline("mine")).json()["uuid"]

    shares = _relay_client(store).get("/shares/conversation/conv-alice/list").json()["shares"]
    assert [s["uuid"] for s in shares] == [uuid]
    assert shares[0]["url"] == f"https://scooter.example.com/s/{uuid}/"


@pytest.mark.asyncio
async def test_only_the_relay_lists_another_conversation(store):
    alice = _client(store, "conv-alice")
    alice.post("/shares", json=_inline("mine"))
    # A sandbox, even the owning one, is not the relay.
    assert _client(store, "conv-bob").get("/shares/conversation/conv-alice/list").status_code == 403
    assert alice.get("/shares/conversation/conv-alice/list").status_code == 403
    assert _relay_client(store, relayed_user=None).get("/shares/conversation/conv-alice/list").status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("page, expected", [
    (b"<!DOCTYPE html><html><head><title>t</title></head></html>",
     b"<!DOCTYPE html><html><head>" + _DEFAULT_FAVICON_LINK + b"<title>t</title></head></html>"),
    (b"<!doctype html><html lang=en><body>x</body></html>",
     b"<!doctype html><html lang=en>" + _DEFAULT_FAVICON_LINK + b"<body>x</body></html>"),
    (b"<!DOCTYPE html><p>x</p>", b"<!DOCTYPE html>" + _DEFAULT_FAVICON_LINK + b"<p>x</p>"),
])
async def test_html_without_icon_gets_scooter_favicon(store, page, expected):
    c = _client(store)
    files = {"index.html": {"content_type": "text/html; charset=utf-8", "b64": _b64(page)}}
    uuid = c.post("/shares", json={"files": files}).json()["uuid"]
    assert c.get(f"/s/{uuid}/").content == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("link", [
    b'<link rel="icon" href="me.png">',
    b"<LINK REL='shortcut icon' href='me.ico'>",
    b'<link href="me.png" rel=icon>',
])
async def test_html_with_own_icon_is_untouched(store, link):
    c = _client(store)
    page = b"<html><head>" + link + b"</head></html>"
    uuid = c.post("/shares", json=_inline(page.decode())).json()["uuid"]
    assert c.get(f"/s/{uuid}/").content == page


@pytest.mark.asyncio
async def test_non_html_is_untouched(store):
    c = _client(store)
    files = {"data.txt": {"content_type": "text/plain", "b64": _b64(b"<head>")}}
    uuid = c.post("/shares", json={"files": files}).json()["uuid"]
    assert c.get(f"/s/{uuid}/").content == b"<head>"
