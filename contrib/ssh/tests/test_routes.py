"""The key reaches SSH only in its owner's private conversation, and only the relay manages it."""

from __future__ import annotations

import base64
import struct

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib import ssh_keys
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_broker_lib.user_secrets import KeyRing, SecretBox
from scooter_contrib_ssh.store import SshKeyStore, _Base
from scooter_contrib_ssh.transport import SshKey

VIEWS = {
    "alice-private": {"owner": "alice", "visibility": "private"},
    "alice-shared": {"owner": "alice", "visibility": "shared"},
    "bob-private": {"owner": "bob", "visibility": "private"},
}


async def fetch(conv: str):
    return VIEWS.get(conv)


@pytest.fixture
async def app():
    store = SshKeyStore(sqlite_config(), SecretBox.of(KeyRing.generate()))
    await create_schema(store, _Base)
    transport = SshKey(store=store, owners=OwnerResolver(fetch, ttl=0))
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(transport.routes(Provider(name="ssh", transports=[transport]), authed), prefix="/ssh")
    a.state.caller = caller
    a.state.store = store
    return a


@pytest.fixture
def changes():
    seen: list[ssh_keys.SshKeyChange] = []

    async def listen(change):
        seen.append(change)

    ssh_keys.on_ssh_key_change(listen)
    yield seen
    ssh_keys._listeners.remove(listen)


def client(app, *, user: str | None = None, conv: str = "") -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id=conv, namespace="ns", service_account="sa", relayed_user=user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


def strings(blob: bytes) -> list[bytes]:
    out = []
    while blob:
        (n,) = struct.unpack(">I", blob[:4])
        out.append(blob[4 : 4 + n])
        blob = blob[4 + n :]
    return out


async def key_blob(app, user: str) -> str:
    async with client(app, user=user) as c:
        line = (await c.get("/ssh/user/key")).json()["public_key"]
    return line.split(" ")[1]


async def test_user_routes_need_the_relay(app):
    async with client(app, conv="alice-private") as c:
        assert (await c.get("/ssh/user/key")).status_code == 403
        assert (await c.post("/ssh/user/rotate")).status_code == 403


async def test_the_first_visit_creates_a_key_and_announces_it(app, changes):
    async with client(app, user="alice") as c:
        first = (await c.get("/ssh/user/key")).json()
        again = (await c.get("/ssh/user/key")).json()
    assert first == again
    assert first["public_key"].startswith("ssh-ed25519 ") and first["fingerprint"].startswith("SHA256:")
    assert [(ch.user, ch.old) for ch in changes] == [("alice", None)]


async def test_the_private_key_is_never_stored_in_the_clear(app):
    await key_blob(app, "alice")
    key = await app.state.store.get("alice")
    async with app.state.store._session() as s:
        from scooter_contrib_ssh.store import _Key

        row = await s.get(_Key, "alice")
    assert row.private_key.startswith("v1.")
    assert base64.b64encode(key.pair.seed).decode() not in row.private_key


async def test_rotate_replaces_the_key_and_announces_old_and_new(app, changes):
    async with client(app, user="alice") as c:
        old = (await c.get("/ssh/user/key")).json()
        new = (await c.post("/ssh/user/rotate")).json()
    assert new["public_key"] != old["public_key"]
    assert (changes[-1].old, changes[-1].new) == (old["public_key"], new["public_key"])


async def test_identities_only_in_the_owners_private_conversation(app):
    blob = await key_blob(app, "alice")
    async with client(app, conv="alice-private") as c:
        ids = (await c.get("/ssh/identities")).json()["identities"]
    assert [i["key"] for i in ids] == [blob]
    for conv in ("alice-shared", "bob-private", "unknown"):
        async with client(app, conv=conv) as c:
            assert (await c.get("/ssh/identities")).json() == {"identities": []}


async def test_a_signature_verifies_under_the_users_key(app):
    blob = await key_blob(app, "alice")
    data = b"ssh userauth payload"
    async with client(app, conv="alice-private") as c:
        resp = await c.post("/ssh/sign", json={"key": blob, "data": base64.b64encode(data).decode(), "flags": 0})
    assert resp.status_code == 200
    kind, sig = strings(base64.b64decode(resp.json()["signature"]))
    assert kind == b"ssh-ed25519"
    pub = strings(base64.b64decode(blob))[1]
    Ed25519PublicKey.from_public_bytes(pub).verify(sig, data)


async def test_signing_is_refused_outside_the_owners_private_conversation(app):
    blob = await key_blob(app, "alice")
    body = {"key": blob, "data": base64.b64encode(b"x").decode(), "flags": 0}
    for conv in ("alice-shared", "bob-private"):
        async with client(app, conv=conv) as c:
            assert (await c.post("/ssh/sign", json=body)).status_code == 403


async def test_signing_with_another_key_is_refused(app):
    await key_blob(app, "alice")
    bob_blob = await key_blob(app, "bob")
    body = {"key": bob_blob, "data": base64.b64encode(b"x").decode(), "flags": 0}
    async with client(app, conv="alice-private") as c:
        assert (await c.post("/ssh/sign", json=body)).status_code == 403


async def test_a_malformed_sign_request_is_a_400(app):
    async with client(app, conv="alice-private") as c:
        assert (await c.post("/ssh/sign", json={"key": "!!", "data": "", "flags": 0})).status_code == 400
        too_big = base64.b64encode(b"x" * (64 * 1024 + 1)).decode()
        assert (await c.post("/ssh/sign", json={"key": "AAAA", "data": too_big})).status_code == 400
