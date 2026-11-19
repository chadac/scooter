"""Keys are managed only by their owner through the relay, and verified only for webhooks."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_lib.svcauth import AuthError, Principal
from scooter_contrib_apikeys.store import MAX_KEYS_PER_USER, ApiKeyStore, _Base
from scooter_contrib_apikeys.transport import ApiKeys

WEBHOOKS = "system:serviceaccount:ns:agent-webhooks"


class Clock:
    def __init__(self) -> None:
        self.t = datetime(2026, 11, 18, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.t


async def verifier(headers: Mapping[str, str]) -> Principal:
    if headers.get("authorization") != "Bearer webhooks-token":
        raise AuthError("not-allowed", "not webhooks")
    return Principal(kind="service", service_account=WEBHOOKS)


@pytest.fixture
async def app():
    clock = Clock()
    store = ApiKeyStore(sqlite_config(), now=clock)
    await create_schema(store, _Base)
    transport = ApiKeys(store=store, verifier=verifier)
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(transport.routes(Provider(name="apikeys", transports=[transport]), authed), prefix="/apikeys")
    a.state.caller, a.state.clock = caller, clock
    return a


def client(app, *, user: str | None = None, conv: str = "") -> AsyncClient:
    app.state.caller["identity"] = Identity(conversation_id=conv, namespace="ns", service_account="sa", relayed_user=user)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


async def create(app, user: str = "alice", **body) -> dict:
    async with client(app, user=user) as c:
        r = await c.post("/apikeys/user/keys", json={"name": "laptop", **body})
    assert r.status_code == 200, r.text
    return r.json()


async def verify(app, key: str, token: str = "webhooks-token"):
    async with client(app) as c:
        return await c.post("/apikeys/verify", json={"key": key, "ip": "198.51.100.7"},
                            headers={"authorization": f"Bearer {token}"})


async def test_a_new_key_is_shown_once_and_verifies_as_its_owner(app):
    made = await create(app)
    assert made["scopes"] == ["read", "write"]
    r = await verify(app, made["key"])
    assert r.status_code == 200
    assert r.json() == {"user": "alice", "key_id": made["key_id"], "scopes": ["read", "write"],
                        "expires_at": made["expires_at"]}
    async with client(app, user="alice") as c:
        listed = (await c.get("/apikeys/user/keys")).json()["keys"]
    assert [k["key_id"] for k in listed] == [made["key_id"]]
    assert "key" not in listed[0] and "secret_digest" not in listed[0]
    assert listed[0]["last_used_ip"] == "198.51.100.7"


async def test_user_routes_need_the_relay(app):
    async with client(app, conv="conv-1") as c:
        assert (await c.get("/apikeys/user/keys")).status_code == 403
        assert (await c.post("/apikeys/user/keys", json={"name": "x"})).status_code == 403


async def test_only_webhooks_may_verify(app):
    made = await create(app)
    assert (await verify(app, made["key"], token="sandbox-token")).status_code == 403


async def test_wrong_unknown_and_malformed_keys_get_the_same_answer(app):
    made = await create(app)
    wrong = made["key"][:-1] + ("A" if made["key"][-1] != "A" else "B")
    unknown = "sct_aaaaaaaaaaaa_" + made["key"][len("sct_aaaaaaaaaaaa_"):]
    for key in [wrong, unknown, "nonsense", ""]:
        r = await verify(app, key)
        assert (r.status_code, r.json()) == (401, {"detail": "invalid key"})


async def test_an_expired_key_stops_verifying(app):
    made = await create(app, expires_in_days=1)
    app.state.clock.t += timedelta(days=1)
    assert (await verify(app, made["key"])).status_code == 401


async def test_a_revoked_key_stops_verifying_and_only_its_owner_can_revoke(app):
    made = await create(app)
    async with client(app, user="bob") as c:
        assert (await c.delete(f"/apikeys/user/keys/{made['key_id']}")).status_code == 404
    assert (await verify(app, made["key"])).status_code == 200
    async with client(app, user="alice") as c:
        assert (await c.delete(f"/apikeys/user/keys/{made['key_id']}")).status_code == 200
    assert (await verify(app, made["key"])).status_code == 401


async def test_users_see_only_their_own_keys(app):
    await create(app, user="alice")
    async with client(app, user="bob") as c:
        assert (await c.get("/apikeys/user/keys")).json()["keys"] == []


async def test_a_read_only_key_carries_only_read(app):
    made = await create(app, scopes=["read"])
    assert (await verify(app, made["key"])).json()["scopes"] == ["read"]


@pytest.mark.parametrize("body", [
    {"name": ""}, {"name": "x" * 65}, {"name": "x", "scopes": []}, {"name": "x", "scopes": ["admin"]},
    {"name": "x", "expires_in_days": 0}, {"name": "x", "expires_in_days": 366}, {"name": "x", "expires_in_days": True},
])
async def test_bad_requests_are_refused(app, body):
    async with client(app, user="alice") as c:
        assert (await c.post("/apikeys/user/keys", json=body)).status_code == 400


async def test_live_keys_are_capped_but_expired_ones_free_a_slot(app):
    for _ in range(MAX_KEYS_PER_USER - 1):
        await create(app)
    await create(app, expires_in_days=1)
    async with client(app, user="alice") as c:
        assert (await c.post("/apikeys/user/keys", json={"name": "x"})).status_code == 409
    app.state.clock.t += timedelta(days=2)
    await create(app)
